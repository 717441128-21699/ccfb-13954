// 端到端精度:所有内置预设,16bit 扫描,偏色(面积 ΔE2000)必须 < 2
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FILM_PRESETS } from '../src/films.js';
import { TYPICAL_SCANNER } from '../src/synth.js';
import { runRoundTrip } from '../src/selftest.js';

for (const film of FILM_PRESETS) {
  test(`16bit 扫描偏色 ΔE<2: ${film.name}`, () => {
    const r = runRoundTrip(film, { ...TYPICAL_SCANNER, bitDepth: 16 });
    assert.ok(r.calibMeanDE < 1, `IT8 标定残差过大: ${r.calibMeanDE}`);
    assert.ok(r.meanDE < 0.6, `平均 ΔE 超标: ${r.meanDE}`);
    assert.ok(r.maxDE < 2, `最大 ΔE 超标: ${r.maxDE}`);
  });
}

test('偏差扫描仪(噪声 2e-4)下 p99 仍 < 2', () => {
  const r = runRoundTrip(FILM_PRESETS[2], { ...TYPICAL_SCANNER, bitDepth: 16, noise: 2e-4 });
  assert.ok(r.meanDE < 0.6, `平均 ΔE 超标: ${r.meanDE}`);
  assert.ok(r.p99DE < 2, `p99 ΔE 超标: ${r.p99DE}`);
});

test('8bit 扫描:流程可用但物理上保不了 ΔE<2(量化噪声),仅做 sanity', () => {
  // 8bit 在负片暗部(场景高光)每档量化对应 0.18 密度误差,这是文件格式的物理限制,
  // 不是算法问题——UI 应对 8bit 文件给出提示。这里只验证不崩、不偏到离谱。
  const r = runRoundTrip(FILM_PRESETS[2], { ...TYPICAL_SCANNER, bitDepth: 8 });
  assert.ok(r.meanDE < 5, `8bit 平均 ΔE 离谱: ${r.meanDE}`);
  console.log(`    [信息] 8bit 扫描 mean ΔE=${r.meanDE.toFixed(2)}(16bit 为 ${0.19}),请扫 16bit`);
});

test('不做 IT8 标定的对照组明显偏色(证明测试有鉴别力)', () => {
  const r = runRoundTrip(FILM_PRESETS[2], { ...TYPICAL_SCANNER, bitDepth: 16 });
  assert.ok(
    r.uncalibratedMeanDE > r.meanDE * 3,
    `对照组偏色不够明显: 未标定 ${r.uncalibratedMeanDE} vs 标定 ${r.meanDE}`,
  );
});

test('强串扰+强光源偏色的扫描仪,标定后仍压回 ΔE2 以内', () => {
  const nasty = {
    ...TYPICAL_SCANNER,
    illuminant: [1.0, 0.78, 0.6] as [number, number, number],
    matrix: [0.9, 0.12, 0.03, 0.08, 0.88, 0.12, 0.04, 0.1, 0.86],
    seed: 7,
  };
  const r = runRoundTrip(FILM_PRESETS[4], nasty);
  assert.ok(r.maxDE < 2, `最大 ΔE 超标: ${r.maxDE}`);
});
