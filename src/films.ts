// 胶卷预设:每通道独立的特性曲线控制点 + 可选输出矩阵
import { CurvePoint, logisticCurvePoints, CurveShapeParams } from './curves.js';

export interface FilmPreset {
  name: string;
  note?: string;
  /** LUT 覆盖的密度范围 [0, dMaxLut],默认 3.0 */
  dMaxLut: number;
  curves: { r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] };
  /** 反算后施加的 3x3 输出矩阵(染料→显示原色的微调),默认单位阵 */
  outputMatrix?: number[];
}

function mk(
  name: string,
  note: string,
  r: CurveShapeParams,
  g: CurveShapeParams,
  b: CurveShapeParams,
): FilmPreset {
  return {
    name,
    note,
    dMaxLut: 3.0,
    curves: {
      r: logisticCurvePoints(r),
      g: logisticCurvePoints(g),
      b: logisticCurvePoints(b),
    },
  };
}

/**
 * 内置预设。控制点由参数化 S 曲线生成,是"合理的起点";
 * 店里应配合灰阶实拍扫描,用「胶卷预设 → 从灰阶负片标定」修正成自己扫描仪+药水的实测曲线。
 * 注意三个通道的 gamma / dMax 本来就不同——这正是要分通道反算的原因。
 */
export const FILM_PRESETS: FilmPreset[] = [
  mk(
    'Kodak Vision3 50D / 5203',
    '电影卷·日光型,ECN-2。低感光细颗粒,反差略低。',
    { dMax: 2.30, x0: 0.92, gamma: 0.55, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.42, x0: 0.90, gamma: 0.57, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.55, x0: 0.88, gamma: 0.60, toe: 0.55, shoulder: 0.70 },
  ),
  mk(
    'Kodak Vision3 250D / 5207',
    '电影卷·日光型,ECN-2。',
    { dMax: 2.32, x0: 0.92, gamma: 0.56, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.45, x0: 0.90, gamma: 0.58, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.58, x0: 0.88, gamma: 0.61, toe: 0.55, shoulder: 0.70 },
  ),
  mk(
    'Kodak Vision3 500T / 5219',
    '电影卷·灯光型,ECN-2。蓝层感光度高,暗部偏暖需注意。',
    { dMax: 2.35, x0: 0.95, gamma: 0.58, toe: 0.52, shoulder: 0.70 },
    { dMax: 2.48, x0: 0.92, gamma: 0.60, toe: 0.52, shoulder: 0.70 },
    { dMax: 2.62, x0: 0.90, gamma: 0.63, toe: 0.52, shoulder: 0.70 },
  ),
  mk(
    'CineStill 800T',
    '电影卷去碳层版,灯光型。高光易晕( halation ),曲线同 500T 系。',
    { dMax: 2.35, x0: 0.95, gamma: 0.58, toe: 0.52, shoulder: 0.70 },
    { dMax: 2.48, x0: 0.92, gamma: 0.60, toe: 0.52, shoulder: 0.70 },
    { dMax: 2.62, x0: 0.90, gamma: 0.63, toe: 0.52, shoulder: 0.70 },
  ),
  mk(
    'Kodak Portra 400',
    'C-41。低反差人像卷,趾部长。',
    { dMax: 2.25, x0: 0.95, gamma: 0.52, toe: 0.60, shoulder: 0.72 },
    { dMax: 2.38, x0: 0.93, gamma: 0.54, toe: 0.60, shoulder: 0.72 },
    { dMax: 2.50, x0: 0.91, gamma: 0.57, toe: 0.60, shoulder: 0.72 },
  ),
  mk(
    'Kodak Ektar 100',
    'C-41。高饱和高反差。',
    { dMax: 2.45, x0: 0.90, gamma: 0.62, toe: 0.50, shoulder: 0.68 },
    { dMax: 2.58, x0: 0.88, gamma: 0.64, toe: 0.50, shoulder: 0.68 },
    { dMax: 2.72, x0: 0.86, gamma: 0.67, toe: 0.50, shoulder: 0.68 },
  ),
  mk(
    'Fujifilm Pro 400H',
    'C-41。绿通道反差略低,是"一卷发绿"投诉的常见来源。',
    { dMax: 2.28, x0: 0.94, gamma: 0.54, toe: 0.58, shoulder: 0.72 },
    { dMax: 2.36, x0: 0.92, gamma: 0.52, toe: 0.58, shoulder: 0.72 },
    { dMax: 2.52, x0: 0.90, gamma: 0.58, toe: 0.58, shoulder: 0.72 },
  ),
  mk(
    '通用 Generic CN',
    '未知卷的回退预设,务必用灰阶标定修正。',
    { dMax: 2.35, x0: 0.92, gamma: 0.56, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.45, x0: 0.90, gamma: 0.58, toe: 0.55, shoulder: 0.70 },
    { dMax: 2.58, x0: 0.88, gamma: 0.61, toe: 0.55, shoulder: 0.70 },
  ),
];

export function getPreset(name: string): FilmPreset {
  const p = FILM_PRESETS.find((f) => f.name === name);
  if (!p) throw new Error(`未知预设: ${name}`);
  return p;
}

export function presetToJson(p: FilmPreset): string {
  return JSON.stringify(p, null, 2);
}

export function presetFromJson(json: string): FilmPreset {
  const o = JSON.parse(json);
  if (!o.name || !o.curves?.r || !o.curves?.g || !o.curves?.b)
    throw new Error('预设文件格式不对:需要 name 和 curves.{r,g,b}');
  return {
    name: String(o.name),
    note: o.note,
    dMaxLut: typeof o.dMaxLut === 'number' ? o.dMaxLut : 3.0,
    curves: o.curves,
    outputMatrix: o.outputMatrix,
  };
}
