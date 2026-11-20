// IT8 标定矩阵还原精度
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeIt8, TYPICAL_SCANNER, measuredBase } from '../src/synth.js';
import { sampleGrid, calibrateFromIt8 } from '../src/calibrate.js';
import { mat3MulVec, Vec3 } from '../src/color.js';

test('标定矩阵把色块平均 ΔE 压到 1 以内', () => {
  const it8 = synthesizeIt8(TYPICAL_SCANNER);
  const corners: [number, number][] = [
    [0, 0],
    [it8.width - 1, 0],
    [it8.width - 1, it8.height - 1],
    [0, it8.height - 1],
  ];
  const measured = sampleGrid(it8, corners, it8.rows, it8.cols);
  const { matrix, before, after } = calibrateFromIt8(measured, it8.refs);
  assert.ok(before.mean > 3, `校正前应该明显偏色: ${before.mean}`);
  assert.ok(after.mean < 1, `校正后残差过大: ${after.mean}`);
  assert.ok(after.max < 2, `校正后最大残差过大: ${after.max}`);

  // 矩阵作用在片基测量值上应还原出片基透过率本身(光源与串扰都被撤销):
  // W·C·diag(illum)·mask = mask
  const base = measuredBase(TYPICAL_SCANNER);
  const fixed = mat3MulVec(matrix, base);
  const expect: Vec3 = [
    TYPICAL_SCANNER.baseMask[0],
    TYPICAL_SCANNER.baseMask[1],
    TYPICAL_SCANNER.baseMask[2],
  ];
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(fixed[c] - expect[c]) < 0.01, `通道 ${c}: ${fixed[c]} vs ${expect[c]}`);
  }
});
