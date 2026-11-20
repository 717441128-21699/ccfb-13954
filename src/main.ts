// UI 主逻辑:批量转换 / IT8 标定 / 胶卷预设 / 精度自测
import { Vec3, MAT3_IDENTITY, linearToSrgb, srgbToLinear, mat3MulVec } from './color.js';
import { CharacteristicCurve, buildLut } from './curves.js';
import { FilmPreset, FILM_PRESETS, presetToJson, presetFromJson } from './films.js';
import { prepareInvert, invertScan } from './invert.js';
import { calibrateFromIt8, sampleGrid, buildPresetFromWedge, parseIt8Reference } from './calibrate.js';
import { decodeTiff, toFloat32, DecodedImage } from './tiff.js';
import { GpuInverter } from './gpu/engine.js';
import { TYPICAL_SCANNER, synthesizeIt8, synthesizeNegative, generateTestPhoto } from './synth.js';
import { runRoundTrip } from './selftest.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string, _ctor?: abstract new () => T) =>
  document.getElementById(id) as T;

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<{
      getFileHandle: (name: string, o: { create: boolean }) => Promise<{
        createWritable: () => Promise<{ write: (b: Blob) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }>;
  }
}

// ---------- 全局状态 ----------
interface CalibState { matrix: number[]; date: string; meanDE: number }
const state = {
  calib: null as CalibState | null,
  customPresets: [] as FilmPreset[],
  base: null as Vec3 | null,
  pickBase: false,
  files: [] as { file: File; img?: DecodedImage; err?: string }[],
  gpu: null as GpuInverter | null,
  lutCache: new Map<string, { r: Float32Array; g: Float32Array; b: Float32Array }>(),
  results: [] as { name: string; blob: Blob; url: string }[],
};

const allPresets = () => [...FILM_PRESETS, ...state.customPresets];

function loadPersisted() {
  try {
    const c = localStorage.getItem('neg2pos.calib');
    if (c) state.calib = JSON.parse(c);
    const p = localStorage.getItem('neg2pos.customPresets');
    if (p) state.customPresets = JSON.parse(p);
  } catch { /* 忽略损坏的本地数据 */ }
}
function persistCalib() { localStorage.setItem('neg2pos.calib', JSON.stringify(state.calib)); }
function persistPresets() { localStorage.setItem('neg2pos.customPresets', JSON.stringify(state.customPresets)); }

// ---------- 图像载入 ----------
type Transfer = 'linear' | 'srgb' | 'gamma22';

async function loadImageFile(file: File, transfer: 'auto' | Transfer): Promise<DecodedImage> {
  let img: DecodedImage;
  const isTiff = /\.tiff?$/i.test(file.name);
  if (isTiff) {
    img = decodeTiff(await file.arrayBuffer());
  } else {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    const ctx = cv.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const id = ctx.getImageData(0, 0, bmp.width, bmp.height);
    const rgb = new Uint8Array(bmp.width * bmp.height * 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgb[i] = id.data[j]; rgb[i + 1] = id.data[j + 1]; rgb[i + 2] = id.data[j + 2];
    }
    img = { data: rgb, width: bmp.width, height: bmp.height, bits: 8 };
  }
  const mode: Transfer =
    transfer === 'auto' ? (isTiff ? 'linear' : 'srgb') : transfer;
  return applyTransfer(img, mode);
}

/** 显示编码 → 线性(扫描仪文件常见 gamma 编码,先解到线性再进流水线) */
function applyTransfer(img: DecodedImage, mode: Transfer): DecodedImage {
  if (mode === 'linear') return img;
  const max = img.bits === 16 ? 65535 : 255;
  const lut = img.bits === 16 ? new Uint16Array(max + 1) : new Uint8Array(max + 1);
  for (let i = 0; i <= max; i++) {
    const v = i / max;
    const lin = mode === 'srgb' ? srgbToLinear(v) : Math.pow(v, 2.2);
    lut[i] = Math.round(Math.min(1, lin) * max);
  }
  const out = img.bits === 16 ? new Uint16Array(img.data.length) : new Uint8Array(img.data.length);
  const d = img.data;
  for (let i = 0; i < d.length; i++) out[i] = lut[d[i]];
  return { data: out as Uint16Array & Uint8Array, width: img.width, height: img.height, bits: img.bits };
}

// ---------- 片基取样 ----------
function autoBase(img: DecodedImage): Vec3 {
  const max = img.bits === 16 ? 65535 : 255;
  const bins = 2048;
  const hists = [new Uint32Array(bins), new Uint32Array(bins), new Uint32Array(bins)];
  const d = img.data;
  const scale = (bins - 1) / max;
  for (let i = 0; i < d.length; i += 3) {
    hists[0][(d[i] * scale) | 0]++;
    hists[1][(d[i + 1] * scale) | 0]++;
    hists[2][(d[i + 2] * scale) | 0]++;
  }
  const total = d.length / 3;
  const out = [0, 0, 0] as Vec3;
  for (let c = 0; c < 3; c++) {
    let acc = 0;
    for (let b = bins - 1; b >= 0; b--) {
      acc += hists[c][b];
      if (acc >= total * 0.02) { out[c] = b / (bins - 1); break; }
    }
  }
  return out;
}

function sampleRegion(img: DecodedImage, cx: number, cy: number, r = 7): Vec3 {
  const max = img.bits === 16 ? 65535 : 255;
  const acc = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(img.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(img.width - 1, cx + r); x++) {
      const i = (y * img.width + x) * 3;
      acc[0] += img.data[i]; acc[1] += img.data[i + 1]; acc[2] += img.data[i + 2];
      n++;
    }
  }
  return [acc[0] / n / max, acc[1] / n / max, acc[2] / n / max];
}

function showBase() {
  const sw = $('baseSwatch');
  if (!state.base) {
    $('baseVal').textContent = '未取样(转换时自动)';
    sw.style.background = 'transparent';
    return;
  }
  const b = state.base;
  sw.style.background = `rgb(${b.map((v) => Math.round(Math.min(1, v) * 255)).join(',')})`;
  $('baseVal').textContent = `R ${b[0].toFixed(3)} G ${b[1].toFixed(3)} B ${b[2].toFixed(3)}`;
}

// ---------- 预览 ----------
function drawPreview(img: DecodedImage, canvas: HTMLCanvasElement, maxW = 880): { scale: number } {
  const scale = Math.min(1, maxW / img.width);
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const out = ctx.createImageData(w, h);
  const max = img.bits === 16 ? 65535 : 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.round(x / scale));
      const sy = Math.min(img.height - 1, Math.round(y / scale));
      const si = (sy * img.width + sx) * 3;
      const o = (y * w + x) * 4;
      out.data[o] = (img.data[si] / max) * 255;
      out.data[o + 1] = (img.data[si + 1] / max) * 255;
      out.data[o + 2] = (img.data[si + 2] / max) * 255;
      out.data[o + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  return { scale };
}

// ---------- 转换 ----------
function currentPreset(): FilmPreset {
  return allPresets().find((p) => p.name === $('presetSelect', HTMLSelectElement).value) ?? FILM_PRESETS[0];
}

function getLuts(preset: FilmPreset) {
  let l = state.lutCache.get(preset.name);
  if (!l) {
    l = {
      r: buildLut(new CharacteristicCurve(preset.curves.r), preset.dMaxLut),
      g: buildLut(new CharacteristicCurve(preset.curves.g), preset.dMaxLut),
      b: buildLut(new CharacteristicCurve(preset.curves.b), preset.dMaxLut),
    };
    state.lutCache.set(preset.name, l);
  }
  return l;
}

function processOne(img: DecodedImage): { out: ImageData; base: Vec3 } {
  const preset = currentPreset();
  const luts = getLuts(preset);
  const base = state.base ?? autoBase(img);
  const ev = Number($('exposure', HTMLInputElement).value);
  const useCalib = $('useCalib', HTMLInputElement).checked && state.calib;
  const prep = prepareInvert({
    base,
    scannerMatrix: useCalib ? state.calib!.matrix : undefined,
    luts,
    dMax: preset.dMaxLut,
    exposure: Math.pow(2, ev),
    outputMatrix: preset.outputMatrix,
  });
  if (state.gpu) {
    state.gpu.setLuts(luts.r, luts.g, luts.b);
    state.gpu.params = {
      baseCal: prep.baseCal,
      black: prep.black,
      scannerMatrix: prep.scannerMatrix,
      dMax: prep.dMax,
      exposure: prep.exposure,
      outputMatrix: prep.outputMatrix,
    };
    return { out: state.gpu.process({ data: img.data, width: img.width, height: img.height }), base };
  }
  const lin = invertScan(toFloat32(img), img.width * img.height, prep);
  const out = new ImageData(img.width, img.height);
  for (let i = 0, j = 0; i < lin.length; i += 3, j += 4) {
    out.data[j] = Math.round(linearToSrgb(Math.min(lin[i], 1)) * 255);
    out.data[j + 1] = Math.round(linearToSrgb(Math.min(lin[i + 1], 1)) * 255);
    out.data[j + 2] = Math.round(linearToSrgb(Math.min(lin[i + 2], 1)) * 255);
    out.data[j + 3] = 255;
  }
  return { out, base };
}

function log(msg: string) {
  const el = $('batchLog');
  el.hidden = false;
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

async function runBatch() {
  const btn = $('runBatch', HTMLButtonElement);
  btn.disabled = true;
  state.results.forEach((r) => URL.revokeObjectURL(r.url));
  state.results = [];
  $('results').innerHTML = '';
  $('batchLog').textContent = '';
  const prog = $('batchProgress', HTMLProgressElement);
  prog.hidden = false;
  prog.max = state.files.length;
  const t0 = performance.now();
  let done = 0;
  for (const f of state.files) {
    try {
      if (!f.img) f.img = await loadImageFile(f.file, $('inputTransfer', HTMLSelectElement).value as 'auto');
      const t1 = performance.now();
      const { out, base } = processOne(f.img);
      const cv = document.createElement('canvas');
      cv.width = out.width; cv.height = out.height;
      cv.getContext('2d')!.putImageData(out, 0, 0);
      const blob = await new Promise<Blob>((res) => cv.toBlob((b) => res(b!), 'image/png'));
      const ms = performance.now() - t1;
      const name = f.file.name.replace(/\.[^.]+$/, '') + '_pos.png';
      const url = URL.createObjectURL(blob);
      state.results.push({ name, blob, url });
      log(`✓ ${f.file.name}  ${out.width}×${out.height}  ${ms.toFixed(0)} ms  片基(${base.map((v) => v.toFixed(3)).join(' ')})`);
      // 结果卡片
      const card = document.createElement('div');
      card.className = 'card';
      const thumb = document.createElement('canvas');
      const ts = 220 / out.width;
      thumb.width = 220; thumb.height = Math.round(out.height * ts);
      thumb.getContext('2d')!.drawImage(cv, 0, 0, thumb.width, thumb.height);
      const imgEl = document.createElement('img');
      imgEl.src = thumb.toDataURL();
      const a = document.createElement('a');
      a.href = url; a.download = name; a.textContent = name;
      card.append(imgEl, document.createElement('br'), a);
      $('results').append(card);
    } catch (e) {
      log(`✗ ${f.file.name}: ${(e as Error).message}`);
    }
    prog.value = ++done;
  }
  const total = (performance.now() - t0) / 1000;
  log(`—— 共 ${done} 张,${total.toFixed(1)} 秒(每张 ${(total / Math.max(1, done)).toFixed(2)} s)` +
    (done >= 36 ? `,${total < 120 ? '✓ 在' : '✗ 超出'} 2 分钟预算${total < 120 ? '内' : ''}` : ''));
  $('resultPanel').hidden = state.results.length === 0;
  btn.disabled = false;
}

// ---------- IT8 标定 ----------
const it8 = {
  img: null as DecodedImage | null,
  corners: [] as [number, number][],
  refs: null as Vec3[] | null,
  scale: 1,
};

function redrawIt8() {
  if (!it8.img) return;
  it8.scale = drawPreview(it8.img, $('it8Canvas', HTMLCanvasElement)).scale;
  const ctx = $('it8Canvas', HTMLCanvasElement).getContext('2d')!;
  ctx.strokeStyle = '#e0885a';
  ctx.fillStyle = '#e0885a';
  it8.corners.forEach(([x, y], i) => {
    const px = x * it8.scale, py = y * it8.scale;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.stroke();
    ctx.fillText(String(i + 1), px + 7, py - 4);
  });
  $('cornerStatus').textContent = it8.corners.length < 4
    ? `未选择角点(${it8.corners.length}/4)——按 左上→右上→右下→左下 点击`
    : '角点齐了,可以计算';
  updateCalibButton();
}

function updateCalibButton() {
  $('runCalib', HTMLButtonElement).disabled = !(it8.img && it8.corners.length === 4 && it8.refs);
}

function updateCalibStatus() {
  $('calibStatus').textContent = state.calib
    ? `已标定(${state.calib.date},色块平均 ΔE ${state.calib.meanDE.toFixed(2)})`
    : '未标定——先到「扫描仪标定」页做 IT8 标定';
  $('useCalib', HTMLInputElement).checked = !!state.calib;
}

// ---------- 预设 ----------
function refreshPresetSelects() {
  for (const id of ['presetSelect', 'presetSelect2']) {
    const sel = $(id, HTMLSelectElement);
    const cur = sel.value;
    sel.innerHTML = '';
    for (const p of allPresets()) {
      const o = document.createElement('option');
      o.value = o.textContent = p.name;
      sel.append(o);
    }
    if (allPresets().some((p) => p.name === cur)) sel.value = cur;
  }
  plotCurves();
}

function plotCurves() {
  const sel = $('presetSelect2', HTMLSelectElement);
  const preset = allPresets().find((p) => p.name === sel.value) ?? allPresets()[0];
  $('presetJson', HTMLTextAreaElement).value = presetToJson(preset);
  const cv = $('curveCanvas', HTMLCanvasElement);
  const ctx = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  ctx.fillStyle = '#1e2128';
  ctx.fillRect(0, 0, W, H);
  const x0 = -3, x1 = 2.5, y0 = 0, y1 = 3;
  const X = (x: number) => ((x - x0) / (x1 - x0)) * W;
  const Y = (y: number) => H - ((y - y0) / (y1 - y0)) * H;
  ctx.strokeStyle = '#333947';
  ctx.fillStyle = '#8a919e';
  ctx.font = '11px sans-serif';
  for (let d = 0; d <= 3; d += 0.5) {
    ctx.beginPath(); ctx.moveTo(0, Y(d)); ctx.lineTo(W, Y(d)); ctx.stroke();
    ctx.fillText(d.toFixed(1), 4, Y(d) - 3);
  }
  for (let x = -3; x <= 2.5; x += 0.5) {
    ctx.beginPath(); ctx.moveTo(X(x), 0); ctx.lineTo(X(x), H); ctx.stroke();
    ctx.fillText(x.toFixed(1), X(x) + 2, H - 5);
  }
  const colors = { r: '#e06a6a', g: '#6fbf6f', b: '#5aa3e0' } as const;
  for (const ch of ['r', 'g', 'b'] as const) {
    const c = new CharacteristicCurve(preset.curves[ch]);
    ctx.strokeStyle = colors[ch];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let px = 0; px <= W; px++) {
      const x = x0 + (px / W) * (x1 - x0);
      const y = c.eval(x);
      if (px === 0) ctx.moveTo(px, Y(y));
      else ctx.lineTo(px, Y(y));
    }
    ctx.stroke();
  }
  ctx.lineWidth = 1;
}

// ---------- 灰阶标定新卷 ----------
const wedge = {
  img: null as DecodedImage | null,
  points: [] as [number, number][],
  scale: 1,
};

function redrawWedge() {
  if (!wedge.img) return;
  wedge.scale = drawPreview(wedge.img, $('wedgeCanvas', HTMLCanvasElement)).scale;
  const ctx = $('wedgeCanvas', HTMLCanvasElement).getContext('2d')!;
  ctx.strokeStyle = '#5aa3e0';
  ctx.fillStyle = '#5aa3e0';
  wedge.points.forEach(([x, y], i) => {
    const px = x * wedge.scale, py = y * wedge.scale;
    ctx.beginPath(); ctx.arc(px, py, 6, 0, 7); ctx.stroke();
    ctx.fillText(String(i + 1), px + 8, py - 5);
  });
  $('wedgeStatus').textContent = `已点 ${wedge.points.length} 个色块(从最透明到最黑)`;
  $('buildWedge', HTMLButtonElement).disabled = wedge.points.length < 4;
}

// ---------- 自测 ----------
async function runAccuracy() {
  const out = $('accuracyOut');
  out.innerHTML = '<p class="hint">运行中……</p>';
  await new Promise((r) => setTimeout(r, 30));
  const rows: string[] = [];
  let allPass = true;
  for (const film of allPresets()) {
    const r = runRoundTrip(film, { ...TYPICAL_SCANNER, bitDepth: 16 });
    const pass = r.maxDE < 2;
    allPass = allPass && pass;
    rows.push(
      `<tr><td style="text-align:left">${film.name}</td><td>${r.meanDE.toFixed(2)}</td>` +
      `<td>${r.p99DE.toFixed(2)}</td><td>${r.maxDE.toFixed(2)}</td>` +
      `<td>${r.uncalibratedMeanDE.toFixed(2)}</td>` +
      `<td class="${pass ? 'ok' : 'bad'}">${pass ? '✓ 通过' : '✗ 超标'}</td></tr>`,
    );
  }
  out.innerHTML =
    `<table><tr><th>预设</th><th>平均 ΔE</th><th>p99 ΔE</th><th>最大 ΔE</th><th>未标定对照</th><th>判定(ΔE<2)</th></tr>${rows.join('')}</table>` +
    `<p class="${allPass ? 'ok' : 'bad'}" style="font-weight:600">${allPass ? '全部预设偏色压在 ΔE2 以内' : '有预设超标'}</p>`;
}

async function runGpuCheck() {
  const out = $('gpuCheckOut');
  if (!state.gpu) { out.innerHTML = '<span class="bad">WebGL2 不可用</span>'; return; }
  out.textContent = '运行中……';
  await new Promise((r) => setTimeout(r, 30));
  const film = FILM_PRESETS[2];
  const model = { ...TYPICAL_SCANNER, bitDepth: 16 as const };
  const w = 480, h = 360;
  const photo = generateTestPhoto(w, h);
  const neg = synthesizeNegative(photo, w, h, film, model);
  const it8img = synthesizeIt8(model);
  const measured = sampleGrid(it8img, [[0, 0], [it8img.width - 1, 0], [it8img.width - 1, it8img.height - 1], [0, it8img.height - 1]], it8img.rows, it8img.cols);
  const calib = calibrateFromIt8(measured, it8img.refs);
  const luts = {
    r: buildLut(new CharacteristicCurve(film.curves.r), film.dMaxLut),
    g: buildLut(new CharacteristicCurve(film.curves.g), film.dMaxLut),
    b: buildLut(new CharacteristicCurve(film.curves.b), film.dMaxLut),
  };
  const prep = prepareInvert({ base: neg.baseMeasured, scannerMatrix: calib.matrix, luts, dMax: film.dMaxLut });
  // CPU
  const lin = invertScan(neg.data, w * h, prep);
  const cpuBytes = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < lin.length; i += 3, j += 4) {
    cpuBytes[j] = Math.round(linearToSrgb(Math.min(lin[i], 1)) * 255);
    cpuBytes[j + 1] = Math.round(linearToSrgb(Math.min(lin[i + 1], 1)) * 255);
    cpuBytes[j + 2] = Math.round(linearToSrgb(Math.min(lin[i + 2], 1)) * 255);
    cpuBytes[j + 3] = 255;
  }
  // GPU(同一负片转 Uint16)
  const u16 = new Uint16Array(w * h * 3);
  for (let i = 0; i < u16.length; i++) u16[i] = Math.round(neg.data[i] * 65535);
  state.gpu.setLuts(luts.r, luts.g, luts.b);
  state.gpu.params = {
    baseCal: prep.baseCal, black: prep.black, scannerMatrix: prep.scannerMatrix,
    dMax: prep.dMax, exposure: 1, outputMatrix: prep.outputMatrix,
  };
  const gpuImg = state.gpu.process({ data: u16, width: w, height: h });
  let maxDiff = 0;
  for (let i = 0; i < cpuBytes.length; i++) maxDiff = Math.max(maxDiff, Math.abs(cpuBytes[i] - gpuImg.data[i]));
  const pass = maxDiff <= 2;
  out.innerHTML = `最大字节差 ${maxDiff}/255 —— <span class="${pass ? 'ok' : 'bad'}">${pass ? '✓ GPU 与 CPU 一致' : '✗ 不一致'}</span>`;
}

async function runBench() {
  const out = $('benchOut');
  if (!state.gpu) { out.innerHTML = '<span class="bad">WebGL2 不可用,无法跑 GPU 基准</span>'; return; }
  out.textContent = '生成 1200 万像素测试负片……';
  await new Promise((r) => setTimeout(r, 30));
  const film = FILM_PRESETS[2];
  const model = { ...TYPICAL_SCANNER, bitDepth: 16 as const };
  // 低分辨率合成 → 最近邻放大到 4000×3000(GPU 每帧成本与内容无关)
  const sw = 1000, sh = 750, W = 4000, H = 3000;
  const photo = generateTestPhoto(sw, sh);
  const neg = synthesizeNegative(photo, sw, sh, film, model);
  const frame = new Uint16Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = ((y * sh) / H) | 0;
    for (let x = 0; x < W; x++) {
      const sx = ((x * sw) / W) | 0;
      const si = (sy * sw + sx) * 3, di = (y * W + x) * 3;
      frame[di] = Math.round(neg.data[si] * 65535);
      frame[di + 1] = Math.round(neg.data[si + 1] * 65535);
      frame[di + 2] = Math.round(neg.data[si + 2] * 65535);
    }
  }
  const luts = {
    r: buildLut(new CharacteristicCurve(film.curves.r), film.dMaxLut),
    g: buildLut(new CharacteristicCurve(film.curves.g), film.dMaxLut),
    b: buildLut(new CharacteristicCurve(film.curves.b), film.dMaxLut),
  };
  const prep = prepareInvert({ base: neg.baseMeasured, luts, dMax: film.dMaxLut });
  state.gpu.setLuts(luts.r, luts.g, luts.b);
  state.gpu.params = {
    baseCal: prep.baseCal, black: prep.black, scannerMatrix: prep.scannerMatrix,
    dMax: prep.dMax, exposure: 1, outputMatrix: prep.outputMatrix,
  };
  // 预热
  state.gpu.process({ data: frame, width: W, height: H });
  const N = 36;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    state.gpu.process({ data: frame, width: W, height: H });
    if (i % 6 === 5) {
      out.textContent = `已完成 ${i + 1}/${N}……`;
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const total = (performance.now() - t0) / 1000;
  const pass = total < 120;
  out.innerHTML = `${N} 张 4000×3000 共 <b>${total.toFixed(1)} s</b>(每张 ${(total / N).toFixed(2)} s)—— ` +
    `<span class="${pass ? 'ok' : 'bad'}">${pass ? '✓ 远在 2 分钟预算内' : '✗ 超出预算'}</span>`;
}

// ---------- 事件绑定 ----------
function init() {
  loadPersisted();

  // GPU
  try {
    state.gpu = new GpuInverter(document.createElement('canvas'));
    $('gpuStatus').innerHTML = '<span class="ok">WebGL2 可用,走 GPU</span>';
  } catch {
    $('gpuStatus').innerHTML = '<span class="warn">WebGL2 不可用,退回 CPU(批量会慢)</span>';
  }

  // 标签页
  document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      $('tab-' + (b as HTMLElement).dataset.tab).classList.add('active');
    });
  });

  refreshPresetSelects();
  updateCalibStatus();
  showBase();

  // ---- 批量转换 ----
  const drop = $('drop');
  const fileInput = $('fileInput', HTMLInputElement);
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    addFiles(e.dataTransfer?.files);
  });
  fileInput.addEventListener('change', () => addFiles(fileInput.files));

  function addFiles(list: FileList | null | undefined) {
    if (!list) return;
    for (const f of Array.from(list)) state.files.push({ file: f });
    renderFileList();
    $('runBatch', HTMLButtonElement).disabled = state.files.length === 0;
    previewFirst();
  }

  function renderFileList() {
    $('fileList').innerHTML = state.files
      .map((f) => `<li>${f.file.name} <span class="hint">(${(f.file.size / 1048576).toFixed(1)} MB)</span></li>`)
      .join('');
  }

  async function previewFirst() {
    const f = state.files[0];
    if (!f) return;
    try {
      if (!f.img) f.img = await loadImageFile(f.file, $('inputTransfer', HTMLSelectElement).value as 'auto');
      drawPreview(f.img, $('negPreview', HTMLCanvasElement));
      if (f.img.bits === 8) log('提示:8bit 文件暗部精度有限,正式出片请扫 16bit TIFF');
    } catch (e) {
      log(`预览失败:${(e as Error).message}`);
    }
  }

  $('negPreview', HTMLCanvasElement).addEventListener('click', (e) => {
    if (!state.pickBase || !state.files[0]?.img) return;
    const cv = $('negPreview', HTMLCanvasElement);
    const rect = cv.getBoundingClientRect();
    const img = state.files[0].img;
    const x = Math.round(((e.clientX - rect.left) / rect.width) * img.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * img.height);
    state.base = sampleRegion(img, x, y);
    state.pickBase = false;
    $('pickBaseBtn').classList.remove('armed');
    showBase();
  });

  $('autoBaseBtn').addEventListener('click', () => {
    const img = state.files[0]?.img;
    if (!img) { log('先导入底片'); return; }
    state.base = autoBase(img);
    showBase();
  });
  $('pickBaseBtn').addEventListener('click', () => {
    state.pickBase = !state.pickBase;
    $('pickBaseBtn').classList.toggle('armed', state.pickBase);
  });
  $('exposure', HTMLInputElement).addEventListener('input', () => {
    $('exposureVal').textContent = `${Number($('exposure', HTMLInputElement).value).toFixed(2)} EV`;
  });
  $('runBatch').addEventListener('click', () => void runBatch());
  $('saveAll').addEventListener('click', async () => {
    if (!state.results.length) return;
    if (window.showDirectoryPicker) {
      try {
        const dir = await window.showDirectoryPicker();
        for (const r of state.results) {
          const fh = await dir.getFileHandle(r.name, { create: true });
          const w = await fh.createWritable();
          await w.write(r.blob);
          await w.close();
        }
        log(`✓ 已保存 ${state.results.length} 张到所选文件夹`);
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    for (const r of state.results) {
      const a = document.createElement('a');
      a.href = r.url; a.download = r.name;
      a.click();
      await new Promise((res) => setTimeout(res, 200));
    }
  });

  // ---- IT8 标定 ----
  const it8Input = $('it8Input', HTMLInputElement);
  $('it8LoadBtn').addEventListener('click', () => it8Input.click());
  it8Input.addEventListener('change', async () => {
    const f = it8Input.files?.[0];
    if (!f) return;
    it8.img = await loadImageFile(f, 'auto');
    it8.corners = [];
    redrawIt8();
  });
  $('it8Canvas', HTMLCanvasElement).addEventListener('click', (e) => {
    if (!it8.img || it8.corners.length >= 4) return;
    const rect = ($('it8Canvas') as HTMLCanvasElement).getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * it8.img.width;
    const y = ((e.clientY - rect.top) / rect.height) * it8.img.height;
    it8.corners.push([x, y]);
    redrawIt8();
  });
  $('clearCorners').addEventListener('click', () => { it8.corners = []; redrawIt8(); });
  const refInput = $('refInput', HTMLInputElement);
  $('refLoadBtn').addEventListener('click', () => refInput.click());
  refInput.addEventListener('change', async () => {
    const f = refInput.files?.[0];
    if (!f) return;
    try {
      it8.refs = parseIt8Reference(await f.text());
      $('refStatus').textContent = `已载入 ${it8.refs.length} 个参考值`;
    } catch (err) {
      $('refStatus').textContent = `参考文件解析失败:${(err as Error).message}`;
    }
    updateCalibButton();
  });
  $('runCalib').addEventListener('click', () => {
    if (!it8.img || !it8.refs) return;
    const rows = Number($('it8Rows', HTMLInputElement).value);
    const cols = Number($('it8Cols', HTMLInputElement).value);
    const measured = sampleGrid(
      { data: toFloat32(it8.img), width: it8.img.width, height: it8.img.height },
      it8.corners, rows, cols,
    );
    if (measured.length !== it8.refs.length) {
      $('calibResult').innerHTML = `<p class="bad">色块数对不上:图上 ${rows}×${cols}=${measured.length},参考文件 ${it8.refs.length} 个</p>`;
      return;
    }
    const r = calibrateFromIt8(measured, it8.refs);
    state.calib = { matrix: r.matrix, date: new Date().toLocaleDateString(), meanDE: r.after.mean };
    persistCalib();
    updateCalibStatus();
    const m = r.matrix.map((v) => v.toFixed(4));
    $('calibResult').innerHTML =
      `<h3>标定完成</h3><p>校正前色块平均 ΔE <b>${r.before.mean.toFixed(2)}</b>(最大 ${r.before.max.toFixed(2)}) → ` +
      `校正后平均 ΔE <b class="${r.after.mean < 1 ? 'ok' : 'warn'}">${r.after.mean.toFixed(2)}</b>(最大 ${r.after.max.toFixed(2)})</p>` +
      `<div class="log">校正矩阵:\n[${m[0]}, ${m[1]}, ${m[2]}]\n[${m[3]}, ${m[4]}, ${m[5]}]\n[${m[6]}, ${m[7]}, ${m[8]}]</div>` +
      `<p class="hint">已保存,转换页勾选「使用 IT8 扫描仪标定」即可生效。</p>`;
  });
  $('genTestCard').addEventListener('click', () => {
    const card = synthesizeIt8(TYPICAL_SCANNER);
    const cv = document.createElement('canvas');
    cv.width = card.width; cv.height = card.height;
    const ctx = cv.getContext('2d')!;
    const id = ctx.createImageData(card.width, card.height);
    for (let i = 0, j = 0; i < card.data.length; i += 3, j += 4) {
      id.data[j] = Math.round(linearToSrgb(card.data[i]) * 255);
      id.data[j + 1] = Math.round(linearToSrgb(card.data[i + 1]) * 255);
      id.data[j + 2] = Math.round(linearToSrgb(card.data[i + 2]) * 255);
      id.data[j + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    cv.toBlob((b) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(b!);
      a.download = 'it8_testcard.png';
      a.click();
    }, 'image/png');
    const refs = new Blob([JSON.stringify(card.refs)], { type: 'application/json' });
    const a2 = document.createElement('a');
    a2.href = URL.createObjectURL(refs);
    a2.download = 'it8_testcard_refs.json';
    a2.click();
  });

  // ---- 预设 ----
  $('presetSelect2', HTMLSelectElement).addEventListener('change', plotCurves);
  $('exportPreset').addEventListener('click', () => {
    const preset = allPresets().find((p) => p.name === $('presetSelect2', HTMLSelectElement).value)!;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([presetToJson(preset)], { type: 'application/json' }));
    a.download = preset.name.replace(/[^\w-]+/g, '_') + '.json';
    a.click();
  });
  const importInput = $('importPreset', HTMLInputElement);
  $('importPresetBtn').addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const p = presetFromJson(await f.text());
      state.customPresets = state.customPresets.filter((x) => x.name !== p.name).concat(p);
      persistPresets();
      refreshPresetSelects();
      $('presetSelect2', HTMLSelectElement).value = p.name;
      plotCurves();
    } catch (e) {
      alert(`导入失败:${(e as Error).message}`);
    }
  });

  // 灰阶标定
  const wedgeInput = $('wedgeInput', HTMLInputElement);
  $('wedgeLoadBtn').addEventListener('click', () => wedgeInput.click());
  wedgeInput.addEventListener('change', async () => {
    const f = wedgeInput.files?.[0];
    if (!f) return;
    wedge.img = await loadImageFile(f, 'auto');
    wedge.points = [];
    redrawWedge();
  });
  $('wedgeCanvas', HTMLCanvasElement).addEventListener('click', (e) => {
    if (!wedge.img) return;
    const rect = ($('wedgeCanvas') as HTMLCanvasElement).getBoundingClientRect();
    wedge.points.push([
      ((e.clientX - rect.left) / rect.width) * wedge.img.width,
      ((e.clientY - rect.top) / rect.height) * wedge.img.height,
    ]);
    redrawWedge();
  });
  $('wedgeReset').addEventListener('click', () => { wedge.points = []; redrawWedge(); });
  $('buildWedge').addEventListener('click', () => {
    if (!wedge.img || wedge.points.length < 4) return;
    const useCalib = state.calib !== null;
    const M = useCalib ? state.calib!.matrix : MAT3_IDENTITY;
    const baseRaw = autoBase(wedge.img);
    const base = mat3MulVec(M, baseRaw) as Vec3;
    const patches = wedge.points.map(([x, y]) =>
      mat3MulVec(M, sampleRegion(wedge.img!, Math.round(x), Math.round(y))) as Vec3,
    );
    try {
      const preset = buildPresetFromWedge(
        $('wedgeName', HTMLInputElement).value || '我的新卷',
        base,
        patches,
        Number($('wedgeLogE', HTMLInputElement).value),
      );
      state.customPresets = state.customPresets.filter((x) => x.name !== preset.name).concat(preset);
      persistPresets();
      refreshPresetSelects();
      $('presetSelect2', HTMLSelectElement).value = preset.name;
      plotCurves();
      $('wedgeStatus').innerHTML = `<span class="ok">✓ 已生成「${preset.name}」${useCalib ? '(已套用 IT8 标定)' : '(未做 IT8 标定,建议先标定)'}</span>`;
    } catch (e) {
      $('wedgeStatus').textContent = `生成失败:${(e as Error).message}`;
    }
  });

  // ---- 自测 ----
  $('runAccuracy').addEventListener('click', () => void runAccuracy());
  $('runGpuCheck').addEventListener('click', () => void runGpuCheck());
  $('runBench').addEventListener('click', () => void runBench());
}

init();
