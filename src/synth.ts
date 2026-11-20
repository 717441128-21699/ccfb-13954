// 正向模型:从正常照片合成"扫描出来的负片",以及合成 IT8 测试色卡。
// 用途:① 精度自测(反算结果和原片比 ΔE)② 店里没有新卷样片时验证预设。
import { Vec3, mat3MulVec } from './color.js';
import { CharacteristicCurve } from './curves.js';
import { FilmPreset } from './films.js';

/** 扫描仪成像模型:光源偏色 + 片基透过率 + 通道串扰 + 噪声 + 量化 */
export interface ScannerModel {
  /** 光源每通道增益(偏色),如 [1.0, 0.86, 0.72] 是偏暖的灯 */
  illuminant: Vec3;
  /** 片基(橙色蒙版)透过率,如 [0.88, 0.42, 0.20] */
  baseMask: Vec3;
  /** 传感器通道串扰 3x3(行主序),对角≈1 */
  matrix: number[];
  bitDepth: 8 | 16;
  /** 高斯噪声 σ(相对满量程) */
  noise: number;
  seed?: number;
}

export const TYPICAL_SCANNER: ScannerModel = {
  illuminant: [1.0, 0.86, 0.72],
  baseMask: [0.88, 0.42, 0.2],
  matrix: [0.97, 0.04, 0.01, 0.03, 0.95, 0.05, 0.02, 0.06, 0.94],
  bitDepth: 16,
  noise: 1e-4, // 正常 CCD 扫描仪水平;2e-4 以上属于偏差的机器
  seed: 42,
};

// 确定性随机数(mulberry32),测试可复现
export function makeRng(seed = 42): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 片基(未曝光处)的扫描测量值 = 串扰矩阵 · (光源 ⊙ 片基) */
export function measuredBase(model: ScannerModel): Vec3 {
  return mat3MulVec(model.matrix, [
    model.illuminant[0] * model.baseMask[0],
    model.illuminant[1] * model.baseMask[1],
    model.illuminant[2] * model.baseMask[2],
  ]);
}

export interface SynthNegative {
  data: Float32Array; // 0..1 扫描值(已含量化与噪声)
  width: number;
  height: number;
  baseMeasured: Vec3;
}

/**
 * 正向:线性照片 → 负片扫描。
 * logH = log10(L/0.18) → D = 曲线(logH) → T = 10^-D →
 * S = 串扰 · (光源 ⊙ 片基 ⊙ T) → 加噪 → 量化。
 */
export function synthesizeNegative(
  photoLinear: Float32Array,
  width: number,
  height: number,
  film: FilmPreset,
  model: ScannerModel,
  exposureBias = 0,
): SynthNegative {
  const cr = new CharacteristicCurve(film.curves.r);
  const cg = new CharacteristicCurve(film.curves.g);
  const cb = new CharacteristicCurve(film.curves.b);
  const rng = makeRng(model.seed ?? 42);
  const q = model.bitDepth === 16 ? 65535 : 255;
  const n = width * height;
  const out = new Float32Array(n * 3);
  const [ir, ig, ib] = model.illuminant;
  const [mr, mg, mb] = model.baseMask;
  for (let i = 0; i < n; i++) {
    const Lr = Math.max(photoLinear[i * 3], 1e-7);
    const Lg = Math.max(photoLinear[i * 3 + 1], 1e-7);
    const Lb = Math.max(photoLinear[i * 3 + 2], 1e-7);
    const Dr = cr.eval(Math.log10(Lr / 0.18) + exposureBias);
    const Dg = cg.eval(Math.log10(Lg / 0.18) + exposureBias);
    const Db = cb.eval(Math.log10(Lb / 0.18) + exposureBias);
    const x: Vec3 = [
      ir * mr * Math.pow(10, -Dr),
      ig * mg * Math.pow(10, -Dg),
      ib * mb * Math.pow(10, -Db),
    ];
    const s = mat3MulVec(model.matrix, x);
    for (let c = 0; c < 3; c++) {
      let v = s[c] + gaussian(rng) * model.noise;
      v = Math.min(Math.max(v, 0), 1);
      out[i * 3 + c] = Math.round(v * q) / q;
    }
  }
  return { data: out, width, height, baseMeasured: measuredBase(model) };
}

/**
 * 程序化的"正常照片"(线性 sRGB):灰阶、饱和色块、肤色、天空渐变、
 * 深阴影和超 1.0 的高光,覆盖整条特性曲线。
 */
export function generateTestPhoto(w: number, h: number): Float32Array {
  const img = new Float32Array(w * h * 3);
  const patchCols = 8;
  const patchRows = 4;
  const bandY = Math.floor(h * 0.55);
  // 色块参考值(线性)
  const patches: Vec3[] = [];
  for (let c = 0; c < patchCols; c++) {
    const v = 0.9 * Math.pow(0.5, c); // 灰阶 0.9 → ~0.007
    patches.push([v, v, v]);
  }
  patches.push(
    [0.55, 0.08, 0.06], [0.08, 0.4, 0.1], [0.1, 0.15, 0.6],
    [0.5, 0.45, 0.08], [0.45, 0.1, 0.4], [0.08, 0.4, 0.45],
    [0.4, 0.22, 0.14], [0.28, 0.16, 0.11], // 两档肤色
    [0.12, 0.25, 0.08], [0.35, 0.3, 0.25], [0.6, 0.55, 0.5],
    [0.02, 0.02, 0.02], [0.05, 0.04, 0.06], [0.8, 0.7, 0.55],
    [0.15, 0.35, 0.55], [0.9, 0.85, 0.8],
    [0.7, 0.2, 0.15], [0.2, 0.5, 0.3], [0.25, 0.3, 0.7],
    [0.65, 0.6, 0.2], [0.5, 0.25, 0.5], [0.2, 0.55, 0.6],
    [0.008, 0.008, 0.01], [0.95, 0.9, 0.85],
  );
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      if (y < bandY) {
        // 天空:上冷下暖的平滑渐变 + 一个超 1.0 的"太阳"
        const t = y / bandY;
        let r = 0.35 + 0.35 * t;
        let g = 0.45 + 0.2 * t;
        let b = 0.75 - 0.35 * t;
        const dx = x - w * 0.7, dy = y - bandY * 0.3;
        const sun = Math.exp(-(dx * dx + dy * dy) / (2 * (w * 0.04) ** 2));
        r += sun * 1.6; g += sun * 1.4; b += sun * 1.0;
        // 底部压一小条深阴影
        if (y > bandY * 0.85) { r *= 0.02; g *= 0.02; b *= 0.02; }
        img[i] = r; img[i + 1] = g; img[i + 2] = b;
      } else {
        const pw = w / patchCols;
        const ph = (h - bandY) / patchRows;
        const pc = Math.min(patchCols - 1, Math.floor(x / pw));
        const pr = Math.min(patchRows - 1, Math.floor((y - bandY) / ph));
        const p = patches[pr * patchCols + pc];
        img[i] = p[0]; img[i + 1] = p[1]; img[i + 2] = p[2];
      }
    }
  }
  return img;
}

export interface SynthIt8 {
  data: Float32Array;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** 每块参考值(线性 sRGB),按行优先 */
  refs: Vec3[];
}

/** 合成 IT8 色卡扫描件:已知参考值的色块经过同一扫描仪模型 */
export function synthesizeIt8(model: ScannerModel, cols = 8, rows = 6): SynthIt8 {
  const cell = 96, gap = 24;
  const w = cols * cell + (cols + 1) * gap;
  const h = rows * cell + (rows + 1) * gap;
  const refs: Vec3[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0) {
        const v = 0.92 * Math.pow(0.62, c); // 第一行灰阶
        refs.push([v, v, v]);
      } else {
        // 其余:不同色相/饱和/明度
        const hue = ((c + (r - 1) * 0.5) / cols) * 2 * Math.PI;
        const sat = 0.25 + 0.6 * ((r - 1) / (rows - 2));
        const val = 0.15 + 0.75 * (c / (cols - 1));
        const rr = val * (1 - sat + sat * Math.max(0, Math.cos(hue)));
        const gg = val * (1 - sat + sat * Math.max(0, Math.cos(hue - 2.094)));
        const bb = val * (1 - sat + sat * Math.max(0, Math.cos(hue + 2.094)));
        refs.push([rr, gg, bb]);
      }
    }
  }
  const rng = makeRng((model.seed ?? 42) + 7);
  const q = model.bitDepth === 16 ? 65535 : 255;
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.floor((x - gap) / (cell + gap));
      const r = Math.floor((y - gap) / (cell + gap));
      const inX = (x - gap) % (cell + gap) < cell && x >= gap;
      const inY = (y - gap) % (cell + gap) < cell && y >= gap;
      const ref: Vec3 =
        c >= 0 && c < cols && r >= 0 && r < rows && inX && inY
          ? refs[r * cols + c]
          : [0.02, 0.02, 0.02]; // 底色
      const x3: Vec3 = [
        model.illuminant[0] * ref[0],
        model.illuminant[1] * ref[1],
        model.illuminant[2] * ref[2],
      ];
      const s = mat3MulVec(model.matrix, x3);
      const i = (y * w + x) * 3;
      for (let ch = 0; ch < 3; ch++) {
        let v = s[ch] + gaussian(rng) * model.noise;
        v = Math.min(Math.max(v, 0), 1);
        data[i + ch] = Math.round(v * q) / q;
      }
    }
  }
  return { data, width: w, height: h, cols, rows, refs };
}
