// 颜色科学基础:sRGB 编解码、3x3 矩阵、XYZ/Lab、CIEDE2000
export type Vec3 = [number, number, number];

export const LOG10 = Math.log(10);
export const LOG2_10 = Math.LOG2E * Math.LN10; // log2(10) ≈ 3.3219

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function linearToSrgb(c: number): number {
  c = Math.max(0, c);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// ---------- 3x3 矩阵(行主序 number[9]) ----------

export const MAT3_IDENTITY: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function mat3MulVec(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function mat3Mul(a: number[], b: number[]): number[] {
  const o = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) o[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c];
  return o;
}

/** 行主序 → 列主序(WebGL uniformMatrix3fv 需要) */
export function mat3Transpose(m: number[]): number[] {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function mat3Invert(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
  const det = a * A + d * B + g * C;
  if (Math.abs(det) < 1e-12) throw new Error('矩阵不可逆');
  const s = 1 / det;
  return [
    A * s, B * s, C * s,
    (f * g - d * i) * s, (a * i - c * g) * s, (c * d - a * f) * s,
    (d * h - e * g) * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

/**
 * 最小二乘解 3x3 矩阵 W,使 W·measured_i ≈ reference_i。
 * 用于 IT8 标定:测得色块值 → 参考值。
 */
export function solveColorMatrix(measured: Vec3[], reference: Vec3[]): number[] {
  if (measured.length !== reference.length || measured.length < 3)
    throw new Error('色块数量不足');
  // A = Σ m·mᵀ
  const A = new Array(9).fill(0);
  for (const m of measured)
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) A[r * 3 + c] += m[r] * m[c];
  const Ainv = mat3Invert(A);
  // 每个输出通道一行:w_o = (Σ r_o·mᵀ)·A⁻¹
  const W = new Array(9).fill(0);
  for (let o = 0; o < 3; o++) {
    const b = [0, 0, 0];
    for (let i = 0; i < measured.length; i++) {
      b[0] += reference[i][o] * measured[i][0];
      b[1] += reference[i][o] * measured[i][1];
      b[2] += reference[i][o] * measured[i][2];
    }
    // 行向量 b 乘 Ainv
    for (let c = 0; c < 3; c++)
      W[o * 3 + c] = b[0] * Ainv[c] + b[1] * Ainv[3 + c] + b[2] * Ainv[6 + c];
  }
  return W;
}

// ---------- XYZ / Lab / CIEDE2000 ----------

/** 线性 sRGB → CIE XYZ(D65) */
export function linearSrgbToXyz(r: number, g: number, b: number): Vec3 {
  return [
    0.4123908 * r + 0.3575843 * g + 0.1804808 * b,
    0.212639 * r + 0.7151687 * g + 0.0721923 * b,
    0.0193308 * r + 0.1191948 * g + 0.9505322 * b,
  ];
}

const D65: Vec3 = [0.95047, 1.0, 1.08883];

export function xyzToLab(x: number, y: number, z: number): Vec3 {
  const f = (t: number) =>
    t > 0.008856451679 ? Math.cbrt(t) : 7.787037037 * t + 16 / 116;
  const fx = f(x / D65[0]), fy = f(y / D65[1]), fz = f(z / D65[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function linearSrgbToLab(r: number, g: number, b: number): Vec3 {
  const [x, y, z] = linearSrgbToXyz(r, g, b);
  return xyzToLab(x, y, z);
}

/** CIEDE2000(Sharma 等,2005) */
export function deltaE00(lab1: Vec3, lab2: Vec3): number {
  const [L1, a1, b1] = lab1, [L2, a2, b2] = lab2;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const C7 = Cbar ** 7;
  const G = 0.5 * (1 - Math.sqrt(C7 / (C7 + 25 ** 7)));
  const a1p = a1 * (1 + G), a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = C1p === 0 ? 0 : ((Math.atan2(b1, a1p) * 180) / Math.PI + 360) % 360;
  const h2p = C2p === 0 ? 0 : ((Math.atan2(b2, a2p) * 180) / Math.PI + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= 180) dhp = h2p - h1p;
  else dhp = h2p - h1p > 180 ? h2p - h1p - 360 : h2p - h1p + 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lbar = (L1 + L2) / 2;
  const CbarP = (C1p + C2p) / 2;
  let hbar: number;
  if (C1p * C2p === 0) hbar = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbar = (h1p + h2p) / 2;
  else hbar = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  const T =
    1 -
    0.17 * Math.cos(((hbar - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hbar * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hbar + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hbar - 63) * Math.PI) / 180);
  const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
  const CbarP7 = CbarP ** 7;
  const Rc = 2 * Math.sqrt(CbarP7 / (CbarP7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
  const Sc = 1 + 0.045 * CbarP;
  const Sh = 1 + 0.015 * CbarP * T;
  const Rt = -Math.sin((2 * dTheta * Math.PI) / 180) * Rc;
  const dL = dLp / Sl, dC = dCp / Sc, dH = dHp / Sh;
  return Math.sqrt(dL * dL + dC * dC + dH * dH + Rt * dC * dH);
}

/** 两组线性 sRGB 像素的 ΔE2000 统计 */
export function deltaEStats(
  a: Float32Array,
  b: Float32Array,
  count: number,
  skip?: (i: number) => boolean,
): { mean: number; max: number; p99: number; n: number } {
  const des: number[] = [];
  for (let i = 0; i < count; i++) {
    if (skip && skip(i)) continue;
    const de = deltaE00(
      linearSrgbToLab(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]),
      linearSrgbToLab(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]),
    );
    des.push(de);
  }
  des.sort((x, y) => x - y);
  const mean = des.reduce((s, v) => s + v, 0) / Math.max(1, des.length);
  const p99 = des.length ? des[Math.min(des.length - 1, Math.floor(des.length * 0.99))] : 0;
  const max = des.length ? des[des.length - 1] : 0;
  return { mean, max, p99, n: des.length };
}
