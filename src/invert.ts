// 反算流水线(CPU 参考实现,GPU shader 与之一一对应)
import { Vec3, MAT3_IDENTITY, mat3MulVec } from './color.js';
import { lutSample } from './curves.js';

export interface InvertParams {
  /** 片基测量值(扫描空间,0..1)。从片边未曝光处取样 */
  base: Vec3;
  /** 扫描仪黑电平,默认 0 */
  black?: Vec3;
  /** IT8 标定矩阵,作用于 (像素-black);默认单位阵 */
  scannerMatrix?: number[];
  /** 每通道 D→logH 查找表 */
  luts: { r: Float32Array; g: Float32Array; b: Float32Array };
  /** LUT 密度范围 */
  dMax: number;
  /** 线性曝光倍率,默认 1 */
  exposure?: number;
  /** 输出 3x3 矩阵,默认单位阵 */
  outputMatrix?: number[];
}

export interface PreparedInvert {
  baseCal: Vec3;
  black: Vec3;
  scannerMatrix: number[];
  luts: { r: Float32Array; g: Float32Array; b: Float32Array };
  dMax: number;
  exposure: number;
  outputMatrix: number[];
}

/** 把片基也换算到标定空间,之后每像素就是纯比值 */
export function prepareInvert(p: InvertParams): PreparedInvert {
  const black = p.black ?? [0, 0, 0];
  const scannerMatrix = p.scannerMatrix ?? MAT3_IDENTITY;
  const baseShift: Vec3 = [p.base[0] - black[0], p.base[1] - black[1], p.base[2] - black[2]];
  return {
    baseCal: mat3MulVec(scannerMatrix, baseShift),
    black,
    scannerMatrix,
    luts: p.luts,
    dMax: p.dMax,
    exposure: p.exposure ?? 1,
    outputMatrix: p.outputMatrix ?? MAT3_IDENTITY,
  };
}

/**
 * 负片扫描 → 线性正片。
 * scan:RGB 交错,0..1(16bit 文件先除以 65535)。
 * 返回线性 sRGB(中灰 = 0.18)。
 */
export function invertScan(scan: Float32Array, count: number, prep: PreparedInvert): Float32Array {
  const { baseCal, black, scannerMatrix: M, luts, dMax, exposure, outputMatrix: O } = prep;
  const out = new Float32Array(count * 3);
  const lutArr = [luts.r, luts.g, luts.b];
  for (let i = 0; i < count; i++) {
    const s = mat3MulVec(M, [
      scan[i * 3] - black[0],
      scan[i * 3 + 1] - black[1],
      scan[i * 3 + 2] - black[2],
    ]);
    for (let c = 0; c < 3; c++) {
      const d = Math.log10(Math.max(baseCal[c], 1e-7) / Math.max(s[c], 1e-7));
      const logH = lutSample(lutArr[c], dMax, d);
      out[i * 3 + c] = 0.18 * Math.pow(10, logH) * exposure;
    }
    const o = mat3MulVec(O, [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]);
    out[i * 3] = Math.max(o[0], 0);
    out[i * 3 + 1] = Math.max(o[1], 0);
    out[i * 3 + 2] = Math.max(o[2], 0);
  }
  return out;
}
