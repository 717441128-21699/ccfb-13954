// 曲线:单调性、正反算往返、LUT 精度
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CharacteristicCurve, buildLut, lutSample, logisticCurvePoints } from '../src/curves.js';
import { FILM_PRESETS } from '../src/films.js';

test('所有预设曲线单调不减', () => {
  for (const film of FILM_PRESETS) {
    for (const ch of ['r', 'g', 'b'] as const) {
      const c = new CharacteristicCurve(film.curves[ch]);
      let prev = -Infinity;
      for (let x = -3; x <= 3; x += 0.01) {
        const y = c.eval(x);
        assert.ok(y >= prev - 1e-9, `${film.name}/${ch} 在 x=${x} 不单调`);
        prev = y;
      }
    }
  }
});

test('eval/invert 往返误差 < 1e-4', () => {
  const c = new CharacteristicCurve(logisticCurvePoints({
    dMax: 2.4, x0: 0.9, gamma: 0.58, toe: 0.55, shoulder: 0.7,
  }));
  for (let x = -2.5; x <= 2.5; x += 0.05) {
    const y = c.eval(x);
    assert.ok(Math.abs(c.invert(y) - x) < 1e-4, `x=${x} 往返偏差 ${c.invert(y) - x}`);
  }
});

test('LUT 采样误差 < 2e-3 logE', () => {
  const c = new CharacteristicCurve(logisticCurvePoints({
    dMax: 2.4, x0: 0.9, gamma: 0.58, toe: 0.55, shoulder: 0.7,
  }));
  const lut = buildLut(c, 3.0);
  for (let d = 0; d <= 3; d += 0.01) {
    assert.ok(Math.abs(lutSample(lut, 3.0, d) - c.invert(d)) < 2e-3, `D=${d}`);
  }
});
