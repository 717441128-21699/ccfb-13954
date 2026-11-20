// TIFF 解码:手工构造 16bit 无压缩、8bit PackBits+Predictor 两种文件验证
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeTiff, toFloat32 } from '../src/tiff.js';

/** 最小 TIFF 写入器(小端、单条带) */
function writeTiff(opts: {
  width: number;
  height: number;
  bits: 8 | 16;
  spp: number;
  compression: number;
  predictor: number;
  payload: Uint8Array; // 已按压缩方式编码好的条带
}): ArrayBuffer {
  const { width, height, bits, spp, compression, predictor, payload } = opts;
  const entries: [number, number, number[]][] = [
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, new Array(spp).fill(bits)],
    [259, 3, [compression]],
    [262, 3, [spp === 1 ? 1 : 2]],
    [273, 4, [0]], // 占位,后面填
    [277, 3, [spp]],
    [278, 4, [height]],
    [279, 4, [payload.length]],
    [317, 3, [predictor]],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdSize; // 额外数据区起点
  const bitsOff = extra;
  extra += spp * 2;
  const dataOff = extra;
  const buf = new ArrayBuffer(dataOff + payload.length);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, false);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, vals], i) => {
    const off = 8 + 2 + i * 12;
    dv.setUint16(off, tag, true);
    dv.setUint16(off + 2, type, true);
    dv.setUint32(off + 4, vals.length, true);
    if (tag === 258 && vals.length > 2) dv.setUint32(off + 8, bitsOff, true);
    else if (tag === 273) dv.setUint32(off + 8, dataOff, true);
    else if (type === 3) dv.setUint16(off + 8, vals[0], true);
    else dv.setUint32(off + 8, vals[0], true);
  });
  dv.setUint32(8 + 2 + entries.length * 12, 0, true);
  vals16: {
    for (let k = 0; k < spp; k++) dv.setUint16(bitsOff + k * 2, bits, true);
  }
  new Uint8Array(buf, dataOff).set(payload);
  return buf;
}

test('16bit RGB 无压缩', () => {
  const w = 4, h = 3;
  const px = new Uint16Array(w * h * 3);
  for (let i = 0; i < px.length; i++) px[i] = (i * 997) % 65536;
  const payload = new Uint8Array(px.buffer.slice(0));
  const buf = writeTiff({ width: w, height: h, bits: 16, spp: 3, compression: 1, predictor: 1, payload });
  const img = decodeTiff(buf);
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  assert.equal(img.bits, 16);
  assert.ok(img.data instanceof Uint16Array);
  for (let i = 0; i < px.length; i++) assert.equal(img.data[i], px[i], `样本 ${i}`);
});

test('8bit 灰度 PackBits + Predictor2', () => {
  const w = 8, h = 2;
  // 原始行(差分前):递增
  const rows: number[][] = [];
  for (let y = 0; y < h; y++) rows.push(Array.from({ length: w }, (_, x) => (x * 10 + y) % 256));
  // 施加 predictor:每行存差分
  const diff = rows.map((row) => row.map((v, x) => (x === 0 ? v : (v - row[x - 1] + 256) % 256)));
  const flat = diff.flat();
  // PackBits 编码:全部走字面量包(每包最多 128)
  const payload: number[] = [];
  for (let i = 0; i < flat.length; i += 128) {
    const chunk = flat.slice(i, i + 128);
    payload.push(chunk.length - 1, ...chunk);
  }
  const buf = writeTiff({
    width: w, height: h, bits: 8, spp: 1,
    compression: 32773, predictor: 2, payload: new Uint8Array(payload),
  });
  const img = decodeTiff(buf);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      assert.equal(img.data[(y * w + x) * 3], rows[y][x], `(${x},${y})`);
});

test('toFloat32 归一化', () => {
  const f = toFloat32({ data: new Uint16Array([0, 32768, 65535]), width: 1, height: 1, bits: 16 });
  assert.equal(f[0], 0);
  assert.ok(Math.abs(f[1] - 0.5) < 1e-4);
  assert.equal(f[2], 1);
});
