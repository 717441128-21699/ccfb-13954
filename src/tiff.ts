// 极简 TIFF 解码:8/16bit、灰度/RGB/RGBA、无压缩/PackBits/LZW、Predictor 2。
// 覆盖主流扫描仪的"原始 TIFF"输出;不支持的特性会明确报错而不是静默出错。
export interface DecodedImage {
  data: Uint8Array | Uint16Array; // RGB 交错
  width: number;
  height: number;
  bits: 8 | 16;
}

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

export function decodeTiff(buf: ArrayBuffer): DecodedImage {
  const dv = new DataView(buf);
  const bo = dv.getUint16(0, false);
  const le = bo === 0x4949; // 'II'
  if (!le && bo !== 0x4d4d) throw new Error('不是 TIFF 文件');
  const magic = dv.getUint16(2, le);
  if (magic === 43) throw new Error('BigTIFF 暂不支持,请在扫描软件里存普通 TIFF');
  if (magic !== 42) throw new Error('不是 TIFF 文件');
  const ifd = dv.getUint32(4, le);
  const count = dv.getUint16(ifd, le);

  const tags = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const off = ifd + 2 + i * 12;
    const tag = dv.getUint16(off, le);
    const type = dv.getUint16(off + 2, le);
    const n = dv.getUint32(off + 4, le);
    const size = (TYPE_SIZE[type] || 1) * n;
    const pos = size <= 4 ? off + 8 : dv.getUint32(off + 8, le);
    const vals: number[] = [];
    for (let k = 0; k < n; k++) {
      switch (type) {
        case 3: vals.push(dv.getUint16(pos + k * 2, le)); break;
        case 4: vals.push(dv.getUint32(pos + k * 4, le)); break;
        case 8: vals.push(dv.getInt16(pos + k * 2, le)); break;
        case 9: vals.push(dv.getInt32(pos + k * 4, le)); break;
        default: vals.push(dv.getUint8(pos + k)); break;
      }
    }
    tags.set(tag, vals);
  }
  const tag1 = (t: number, dflt?: number): number => {
    const v = tags.get(t);
    if (!v || !v.length) {
      if (dflt !== undefined) return dflt;
      throw new Error(`TIFF 缺少标签 ${t}`);
    }
    return v[0];
  };

  const width = tag1(256);
  const height = tag1(257);
  const bitsArr = tags.get(258) ?? [8];
  const bits = bitsArr[0];
  if (bits !== 8 && bits !== 16) throw new Error(`不支持 ${bits}bit,请存 8 或 16bit`);
  const compression = tag1(259, 1);
  const photometric = tag1(262, 2);
  const spp = tag1(277, 3);
  if (spp !== 1 && spp !== 3 && spp !== 4) throw new Error(`不支持 ${spp} 通道`);
  const planar = tag1(284, 1);
  if (planar !== 1) throw new Error('不支持 PlanarConfiguration=2,请存交错( chunky )格式');
  const predictor = tag1(317, 1);
  const stripOffsets = tags.get(273);
  const stripCounts = tags.get(279);
  if (!stripOffsets || !stripCounts) throw new Error('TIFF 缺少条带信息');

  // 1. 拼接并解压所有条带
  const bytesPerPixel = spp * (bits / 8);
  const expected = width * height * bytesPerPixel;
  const raw = new Uint8Array(expected);
  let written = 0;
  for (let s = 0; s < stripOffsets.length; s++) {
    const src = new Uint8Array(buf, stripOffsets[s], stripCounts[s]);
    let strip: Uint8Array;
    if (compression === 1) strip = src;
    else if (compression === 32773) strip = packBitsDecode(src);
    else if (compression === 5) strip = lzwDecode(src);
    else throw new Error(`不支持的压缩方式 ${compression}(支持:无压缩/PackBits/LZW)`);
    raw.set(strip.subarray(0, Math.min(strip.length, expected - written)), written);
    written += strip.length;
    if (written >= expected) break;
  }

  // 2. 转成样本数组
  let samples: Uint8Array | Uint16Array;
  if (bits === 16) {
    const u16 = new Uint16Array(width * height * spp);
    for (let i = 0; i < u16.length; i++) {
      u16[i] = le ? raw[i * 2] | (raw[i * 2 + 1] << 8) : (raw[i * 2] << 8) | raw[i * 2 + 1];
    }
    samples = u16;
  } else {
    samples = raw;
  }

  // 3. Predictor 2:水平差分还原(按行、按通道交错)
  if (predictor === 2) {
    const rowLen = width * spp;
    for (let y = 0; y < height; y++) {
      const row = y * rowLen;
      for (let x = spp; x < rowLen; x++) {
        samples[row + x] = (samples[row + x] + samples[row + x - spp]) as never;
      }
    }
  } else if (predictor !== 1) {
    throw new Error(`不支持的 Predictor ${predictor}`);
  }

  // 4. 归一到 RGB 三通道
  const px = width * height;
  const out = bits === 16 ? new Uint16Array(px * 3) : new Uint8Array(px * 3);
  const max = bits === 16 ? 65535 : 255;
  const invert = photometric === 0; // WhiteIsZero
  for (let i = 0; i < px; i++) {
    if (spp === 1) {
      const v = samples[i];
      out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = v as never;
    } else {
      out[i * 3] = samples[i * spp] as never;
      out[i * 3 + 1] = samples[i * spp + 1] as never;
      out[i * 3 + 2] = samples[i * spp + 2] as never;
    }
  }
  if (invert) for (let i = 0; i < out.length; i++) out[i] = (max - out[i]) as never;

  return { data: out, width, height, bits };
}

function packBitsDecode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    let n = src[i++];
    if (n > 128) n -= 256; // int8
    if (n >= 0 && n <= 127) {
      for (let k = 0; k <= n; k++) out.push(src[i++]);
    } else if (n >= -127 && n <= -1) {
      const b = src[i++];
      for (let k = 0; k < 1 - n; k++) out.push(b);
    }
    // -128 = noop
  }
  return new Uint8Array(out);
}

/** TIFF 风格 LZW:MSB 优先、Clear=256、EOI=257、early-change */
function lzwDecode(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(8192);
  let width = 9;
  let next = 258;
  let old = -1;
  let bitPos = 0;
  const totalBits = src.length * 8;

  const readCode = (): number => {
    let code = 0;
    for (let k = 0; k < width; k++) {
      const bit = (src[bitPos >> 3] >> (7 - (bitPos & 7))) & 1;
      code = (code << 1) | bit;
      bitPos++;
    }
    return code;
  };

  while (bitPos + width <= totalBits) {
    const code = readCode();
    if (code === 257) break;
    if (code === 256) {
      width = 9;
      next = 258;
      old = -1;
      continue;
    }
    if (old === -1) {
      out.push(code);
      old = code;
      continue;
    }
    let c = code;
    let extra = false;
    if (c >= next) {
      c = old;
      extra = true;
    }
    let sp = 0;
    while (c > 255) {
      stack[sp++] = suffix[c];
      c = prefix[c];
    }
    stack[sp++] = c;
    const firstChar = c;
    if (extra) stack[sp++] = firstChar;
    while (sp > 0) out.push(stack[--sp]);
    if (next < 4096) {
      prefix[next] = old;
      suffix[next] = firstChar;
      next++;
      if (next === (1 << width) - 1 && width < 12) width++;
    }
    old = code;
  }
  return new Uint8Array(out);
}

/** 转成 0..1 的 Float32,供 CPU 流水线/预览用 */
export function toFloat32(img: DecodedImage): Float32Array {
  const max = img.bits === 16 ? 65535 : 255;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = img.data[i] / max;
  return out;
}
