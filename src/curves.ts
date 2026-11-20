// 胶片特性曲线(D-logE):PCHIP 单调三次样条,可反算
export interface CurvePoint {
  x: number; // log10 曝光量(相对值,0 = 18% 中灰的测光曝光)
  y: number; // 密度(已扣除片基密度)
}

/** 端点斜率(MATLAB pchip 同款三点估计 + 单调性限制) */
function endpointSlope(h0: number, h1: number, d0: number, d1: number): number {
  let m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
  if (Math.sign(m) !== Math.sign(d0)) m = 0;
  else if (Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > Math.abs(3 * d0)) m = 3 * d0;
  return m;
}

/**
 * 单调特性曲线。控制点按 x 升序,y 单调不减(胶片密度随曝光单调上升)。
 * 范围外按端点斜率线性外推。
 */
export class CharacteristicCurve {
  private xs: number[];
  private ys: number[];
  private ms: number[];

  constructor(points: CurvePoint[]) {
    const pts = [...points].sort((a, b) => a.x - b.x);
    if (pts.length < 2) throw new Error('曲线至少需要两个控制点');
    this.xs = pts.map((p) => p.x);
    this.ys = pts.map((p) => p.y);
    const n = pts.length;
    const h: number[] = [], d: number[] = [];
    for (let k = 0; k < n - 1; k++) {
      h.push(this.xs[k + 1] - this.xs[k]);
      d.push((this.ys[k + 1] - this.ys[k]) / h[k]);
    }
    const m = new Array<number>(n).fill(0);
    if (n === 2) {
      m[0] = m[1] = d[0];
    } else {
      for (let k = 1; k < n - 1; k++) {
        if (d[k - 1] === 0 || d[k] === 0 || Math.sign(d[k - 1]) !== Math.sign(d[k])) m[k] = 0;
        else {
          // 加权调和平均(Fritsch–Carlson),保证单调
          const w1 = 2 * h[k] + h[k - 1];
          const w2 = h[k] + 2 * h[k - 1];
          m[k] = (w1 + w2) / (w1 / d[k - 1] + w2 / d[k]);
        }
      }
      m[0] = endpointSlope(h[0], h[1], d[0], d[1]);
      m[n - 1] = endpointSlope(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
    }
    this.ms = m;
  }

  eval(x: number): number {
    const xs = this.xs, ys = this.ys, ms = this.ms;
    const n = xs.length;
    if (x <= xs[0]) return ys[0] + ms[0] * (x - xs[0]);
    if (x >= xs[n - 1]) return ys[n - 1] + ms[n - 1] * (x - xs[n - 1]);
    // 二分找区间
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid;
      else hi = mid;
    }
    const h = xs[hi] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[lo] +
      (t3 - 2 * t2 + t) * h * ms[lo] +
      (-2 * t3 + 3 * t2) * ys[hi] +
      (t3 - t2) * h * ms[hi]
    );
  }

  /** 反算:给定密度求 log 曝光量(曲线单调,二分求解) */
  invert(y: number): number {
    let lo = this.xs[0] - 3;
    let hi = this.xs[this.xs.length - 1] + 3;
    for (let i = 0; i < 64; i++) {
      const mid = (lo + hi) / 2;
      if (this.eval(mid) <= y) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  get points(): CurvePoint[] {
    return this.xs.map((x, i) => ({ x, y: this.ys[i] }));
  }
}

/**
 * 把曲线反算烘成 LUT:输入密度 D ∈ [0, dMax],输出 logH。
 * GPU 端作为 1D 纹理采样,CPU 端线性插值。
 */
export function buildLut(curve: CharacteristicCurve, dMax: number, n = 2048): Float32Array {
  const lut = new Float32Array(n);
  for (let i = 0; i < n; i++) lut[i] = curve.invert((i / (n - 1)) * dMax);
  return lut;
}

export function lutSample(lut: Float32Array, dMax: number, d: number): number {
  const u = Math.min(Math.max(d / dMax, 0), 1) * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(u));
  const f = u - i;
  return lut[i] * (1 - f) + lut[i + 1] * f;
}

// ---------- 预设曲线的参数化生成 ----------

export interface CurveShapeParams {
  dMax: number;        // 最大密度(肩部平台)
  x0: number;          // 曲线中点对应的 logE
  gamma: number;       // 直线段斜率(反差)
  toe: number;         // 趾部斜率比例 0..1
  shoulder: number;    // 肩部斜率比例 0..1
}

/**
 * 用分段 logistic 生成特性曲线控制点:
 * D(x) = dMax / (1 + 10^(-k(x)(x-x0))),x<x0 用趾部斜率,x>x0 用肩部斜率。
 */
export function logisticCurvePoints(p: CurveShapeParams, step = 0.1): CurvePoint[] {
  const k = (4 * p.gamma) / (p.dMax * Math.LN10); // 使 x0 处斜率 = gamma
  const pts: CurvePoint[] = [];
  const xMin = p.x0 - 3.6, xMax = p.x0 + 2.4;
  for (let x = xMin; x <= xMax + 1e-9; x += step) {
    const kk = x < p.x0 ? k * p.toe : k * p.shoulder;
    const d = p.dMax / (1 + Math.pow(10, -kk * (x - p.x0)));
    pts.push({ x: Number(x.toFixed(4)), y: Number(Math.max(0, d).toFixed(5)) });
  }
  return pts;
}
