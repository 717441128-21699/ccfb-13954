// IT8 扫描仪标定 + 从灰阶负片生成胶卷预设
import { Vec3, solveColorMatrix, deltaE00, linearSrgbToLab, linearSrgbToXyz, xyzToLab } from './color.js';
import { CurvePoint } from './curves.js';
import { FilmPreset } from './films.js';

export interface RgbImage {
  data: Float32Array; // RGB 交错,0..1
  width: number;
  height: number;
}

/**
 * 按四角点双线性内插出色块网格,取每块中心 40% 区域的均值。
 * corners 顺序:左上、右上、右下、左下(圈住整个色块区)。
 */
export function sampleGrid(
  img: RgbImage,
  corners: [number, number][],
  rows: number,
  cols: number,
): Vec3[] {
  const [tl, tr, br, bl] = corners;
  const out: Vec3[] = [];
  const at = (u: number, v: number): [number, number] => {
    // 双线性:u 横向 0..1,v 纵向 0..1
    const x =
      tl[0] * (1 - u) * (1 - v) + tr[0] * u * (1 - v) + br[0] * u * v + bl[0] * (1 - u) * v;
    const y =
      tl[1] * (1 - u) * (1 - v) + tr[1] * u * (1 - v) + br[1] * u * v + bl[1] * (1 - u) * v;
    return [x, y];
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u0 = (c + 0.3) / cols, u1 = (c + 0.7) / cols;
      const v0 = (r + 0.3) / rows, v1 = (r + 0.7) / rows;
      let sr = 0, sg = 0, sb = 0, n = 0;
      const steps = 6;
      for (let sy = 0; sy < steps; sy++) {
        for (let sx = 0; sx < steps; sx++) {
          const [fx, fy] = at(u0 + ((u1 - u0) * sx) / (steps - 1), v0 + ((v1 - v0) * sy) / (steps - 1));
          const px = Math.min(img.width - 1, Math.max(0, Math.round(fx)));
          const py = Math.min(img.height - 1, Math.max(0, Math.round(fy)));
          const i = (py * img.width + px) * 3;
          sr += img.data[i]; sg += img.data[i + 1]; sb += img.data[i + 2];
          n++;
        }
      }
      out.push([sr / n, sg / n, sb / n]);
    }
  }
  return out;
}

/** 标定:测得值 + 参考值 → 3x3 矩阵,并报告校正前后的色块 ΔE */
export function calibrateFromIt8(measured: Vec3[], refs: Vec3[]): {
  matrix: number[];
  before: { mean: number; max: number };
  after: { mean: number; max: number };
} {
  const matrix = solveColorMatrix(measured, refs);
  const stat = (f: (v: Vec3) => Vec3) => {
    const des = measured.map((m, i) =>
      deltaE00(linearSrgbToLab(...f(m)), linearSrgbToLab(...refs[i])),
    );
    return {
      mean: des.reduce((s, v) => s + v, 0) / des.length,
      max: Math.max(...des),
    };
  };
  const apply = (v: Vec3): Vec3 => [
    matrix[0] * v[0] + matrix[1] * v[1] + matrix[2] * v[2],
    matrix[3] * v[0] + matrix[4] * v[1] + matrix[5] * v[2],
    matrix[6] * v[0] + matrix[7] * v[1] + matrix[8] * v[2],
  ];
  return { matrix, before: stat((v) => v), after: stat(apply) };
}

/**
 * 从灰阶负片生成预设:输入每档的扫描均值(已减黑电平、已乘标定矩阵)、
 * 片基值、每档 logE(间隔均匀,如 0.15 ≈ 半档),输出三通道曲线控制点。
 * patchOrder:从"负片最透明"(曝光最少)到"负片最黑"(曝光最多)。
 */
export function buildPresetFromWedge(
  name: string,
  base: Vec3,
  patches: Vec3[],
  logEStep: number,
): FilmPreset {
  if (patches.length < 4) throw new Error('至少需要 4 个灰阶色块');
  const mk = (ch: number): CurvePoint[] =>
    patches.map((p, i) => ({
      x: Number((i * logEStep).toFixed(4)),
      y: Number(Math.log10(Math.max(base[ch], 1e-7) / Math.max(p[ch], 1e-7)).toFixed(5)),
    }));
  // 让 logE 以中灰为 0:把中间档平移到 0
  const midIdx = Math.floor(patches.length / 2);
  const shift = midIdx * logEStep;
  const shiftPts = (pts: CurvePoint[]) => pts.map((p) => ({ x: p.x - shift, y: p.y }));
  return {
    name,
    note: '灰阶负片实测标定',
    dMaxLut: 3.0,
    curves: { r: shiftPts(mk(0)), g: shiftPts(mk(1)), b: shiftPts(mk(2)) },
  };
}

// ---------- IT8 参考文件解析 ----------

/**
 * 解析 IT8 参考文件。支持:
 * ① JSON:[[r,g,b],...](线性 0..1)
 * ② CGATS/IT8 文本:含 BEGIN_DATA ... END_DATA,列名从 HEADER 里找
 *    RGB_R/G/B(0..255 或 0..100)、XYZ_X/Y/Z、LAB_L/A/B(D50,自动转 sRGB 线性)
 */
export function parseIt8Reference(text: string): Vec3[] {
  const t = text.trim();
  if (t.startsWith('[')) {
    const arr = JSON.parse(t);
    return arr.map((v: number[]) => [v[0], v[1], v[2]] as Vec3);
  }
  const lines = t.split(/\r?\n/);
  let cols: string[] = [];
  let inData = false;
  const rows: number[][] = [];
  for (const line of lines) {
    const s = line.trim();
    if (/^BEGIN_DATA_FORMAT/i.test(s)) {
      inData = false;
      continue;
    }
    if (/^END_DATA_FORMAT/i.test(s)) continue;
    if (/^BEGIN_DATA/i.test(s)) { inData = true; continue; }
    if (/^END_DATA/i.test(s)) { inData = false; continue; }
    if (inData) {
      const parts = s.split(/\s+/);
      const nums = parts.slice(1).map(Number).filter((v) => !Number.isNaN(v));
      if (nums.length >= 3) rows.push(nums);
    } else if (/RGB_R|XYZ_X|LAB_L/i.test(s)) {
      cols = s.split(/\s+/);
    }
  }
  if (!rows.length) throw new Error('参考文件里没有数据行');
  const idx = (name: string) => cols.findIndex((c) => c.toUpperCase().startsWith(name));
  if (cols.length && idx('RGB_R') >= 0) {
    const scale = Math.max(...rows.flat()) > 1.5 ? 255 : 1;
    return rows.map((r) => {
      const v: Vec3 = [r[idx('RGB_R')] / scale, r[idx('RGB_G')] / scale, r[idx('RGB_B')] / scale];
      // IT8 RGB 参考一般是 0..255 的显示值,转线性
      return v.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))) as Vec3;
    });
  }
  if (cols.length && idx('XYZ_X') >= 0) {
    return rows.map((r) => xyzD50ToLinearSrgb(r[idx('XYZ_X')] / 100, r[idx('XYZ_Y')] / 100, r[idx('XYZ_Z')] / 100));
  }
  if (cols.length && idx('LAB_L') >= 0) {
    return rows.map((r) => {
      const xyz = labD50ToXyz(r[idx('LAB_L')], r[idx('LAB_A')], r[idx('LAB_B')]);
      return xyzD50ToLinearSrgb(xyz[0], xyz[1], xyz[2]);
    });
  }
  // 无列名:假定每行是 id + 线性 RGB(0..1)
  return rows.map((r) => [r[0], r[1], r[2]] as Vec3);
}

function labD50ToXyz(L: number, a: number, b: number): Vec3 {
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const f = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
  // D50 白点
  return [0.96422 * f(fx), 1.0 * f(fy), 0.82521 * f(fz)];
}

/** XYZ(D50) → 线性 sRGB(D65),Bradford 色适应 */
export function xyzD50ToLinearSrgb(x: number, y: number, z: number): Vec3 {
  // Bradford D50→D65
  const M = [
    0.9555766, -0.0230393, 0.0631636,
    -0.0282895, 1.0099416, 0.0210077,
    0.0122982, -0.020483, 1.3299098,
  ];
  const xd = M[0] * x + M[1] * y + M[2] * z;
  const yd = M[3] * x + M[4] * y + M[5] * z;
  const zd = M[6] * x + M[7] * y + M[8] * z;
  // XYZ(D65) → 线性 sRGB
  return [
    3.2404542 * xd - 1.5371385 * yd - 0.4985314 * zd,
    -0.969266 * xd + 1.8760108 * yd + 0.041556 * zd,
    0.0556434 * xd - 0.2040259 * yd + 1.0572252 * zd,
  ];
}

// 让 xyzToLab / linearSrgbToXyz 的导入不被 tree-shake 报警(供外部复用)
export { linearSrgbToXyz, xyzToLab };
