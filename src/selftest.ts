// 端到端自测:合成负片 → IT8 标定 → 反算 → 和原片比 ΔE2000。
// Node 单测和浏览器「自测」页共用这一套。
import { deltaEStats, linearToSrgb } from './color.js';
import { CharacteristicCurve, buildLut } from './curves.js';
import { FilmPreset } from './films.js';
import {
  ScannerModel,
  TYPICAL_SCANNER,
  generateTestPhoto,
  synthesizeIt8,
  synthesizeNegative,
} from './synth.js';
import { calibrateFromIt8, sampleGrid } from './calibrate.js';
import { invertScan, prepareInvert } from './invert.js';

export interface RoundTripResult {
  film: string;
  bitDepth: number;
  /** 3x3  binning 后(等效人眼看色块)的 ΔE:这是"偏色"指标 */
  meanDE: number;
  p99DE: number;
  maxDE: number;
  /** 逐像素 ΔE(含扫描噪声,仅供参考) */
  pixelMeanDE: number;
  calibMeanDE: number; // IT8 校正后色块残差
  uncalibratedMeanDE: number; // 不做 IT8 标定的对照组(binning 后)
}

export interface RoundTripOutput extends RoundTripResult {
  photo: Float32Array;
  positive: Float32Array;
  width: number;
  height: number;
}

/** k×k 盒式降采样:面积平均,模拟人眼对均匀区域的判色方式 */
export function boxDownsample(img: Float32Array, w: number, h: number, k: number): {
  data: Float32Array;
  width: number;
  height: number;
} {
  const w2 = Math.floor(w / k), h2 = Math.floor(h / k);
  const out = new Float32Array(w2 * h2 * 3);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * w + x * k + dx) * 3;
          r += img[i]; g += img[i + 1]; b += img[i + 2];
        }
      }
      const o = (y * w2 + x) * 3, n = k * k;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { data: out, width: w2, height: h2 };
}

/** 完整走一遍:造照片 → 造负片 → 标定 → 反算 → 统计 */
export function runRoundTrip(
  film: FilmPreset,
  model: ScannerModel = TYPICAL_SCANNER,
  keepImages = false,
): RoundTripOutput | RoundTripResult {
  const w = 480, h = 360;
  const photo = generateTestPhoto(w, h);

  // 1. 合成 IT8 并标定
  const it8 = synthesizeIt8(model);
  const corners: [number, number][] = [
    [0, 0],
    [it8.width - 1, 0],
    [it8.width - 1, it8.height - 1],
    [0, it8.height - 1],
  ];
  const measured = sampleGrid(it8, corners, it8.rows, it8.cols);
  const calib = calibrateFromIt8(measured, it8.refs);

  // 2. 合成负片
  const neg = synthesizeNegative(photo, w, h, film, model);

  // 3. 反算(带标定)
  const curves = {
    r: new CharacteristicCurve(film.curves.r),
    g: new CharacteristicCurve(film.curves.g),
    b: new CharacteristicCurve(film.curves.b),
  };
  const luts = {
    r: buildLut(curves.r, film.dMaxLut),
    g: buildLut(curves.g, film.dMaxLut),
    b: buildLut(curves.b, film.dMaxLut),
  };
  const prep = prepareInvert({
    base: neg.baseMeasured,
    scannerMatrix: calib.matrix,
    luts,
    dMax: film.dMaxLut,
    outputMatrix: film.outputMatrix,
  });
  const positive = invertScan(neg.data, w * h, prep);

  // 4. 对照组:不做 IT8 标定
  const prepRaw = prepareInvert({ base: neg.baseMeasured, luts, dMax: film.dMaxLut });
  const positiveRaw = invertScan(neg.data, w * h, prepRaw);

  // 5. ΔE 统计。sRGB 编码域比较;跳过扫描值被量化到 0 的像素。
  //    主指标在 3x3 binning 后计算——偏色是面积上的系统误差,
  //    逐像素噪声是扫描仪物理属性,不属于"转换偏色"。
  const q = model.bitDepth === 16 ? 65535 : 255;
  const skip = (i: number) =>
    neg.data[i * 3] * q < 1 || neg.data[i * 3 + 1] * q < 1 || neg.data[i * 3 + 2] * q < 1;
  const toSrgb = (img: Float32Array) => {
    const o = new Float32Array(img.length);
    for (let i = 0; i < img.length; i++) o[i] = linearToSrgb(Math.min(img[i], 1));
    return o;
  };
  const photoS = toSrgb(photo);
  const posS = toSrgb(positive);
  const rawS = toSrgb(positiveRaw);

  const pixel = deltaEStats(posS, photoS, w * h, skip);
  const photoBin = boxDownsample(photoS, w, h, 3);
  const posBin = boxDownsample(posS, w, h, 3);
  const rawBin = boxDownsample(rawS, w, h, 3);
  const binned = deltaEStats(posBin.data, photoBin.data, photoBin.width * photoBin.height);
  const binnedRaw = deltaEStats(rawBin.data, photoBin.data, photoBin.width * photoBin.height);

  const result: RoundTripResult = {
    film: film.name,
    bitDepth: model.bitDepth,
    meanDE: binned.mean,
    p99DE: binned.p99,
    maxDE: binned.max,
    pixelMeanDE: pixel.mean,
    calibMeanDE: calib.after.mean,
    uncalibratedMeanDE: binnedRaw.mean,
  };
  if (keepImages) return { ...result, photo, positive, width: w, height: h };
  return result;
}
