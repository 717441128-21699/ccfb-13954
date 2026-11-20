// WebGL2 反算引擎:每帧一次全屏 pass。
// 数学与 src/invert.ts 的 CPU 参考实现一一对应(自测页会对两者结果)。
import { Vec3, MAT3_IDENTITY, mat3Transpose } from '../color.js';

export interface GpuFrame {
  data: Uint8Array | Uint16Array; // RGB 交错
  width: number;
  height: number;
}

export interface GpuParams {
  baseCal: Vec3;       // 已换算到标定空间的片基(prepareInvert 算好)
  black: Vec3;
  scannerMatrix: number[];
  dMax: number;
  exposure: number;
  outputMatrix: number[];
}

const VERT = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  // 上传的像素第一行是图顶;clip 空间上方是 +Y,所以翻一下
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_BODY = `
uniform sampler2D uLut;      // 2048 x 3,R32F,行 = R/G/B
uniform mat3 uScanMat;
uniform vec3 uBase;
uniform vec3 uBlack;
uniform float uDMax;
uniform float uExposure;
uniform mat3 uOutMat;
uniform float uLutN;
in vec2 vUV;
out vec4 fragColor;

float lutAt(int ch, float d) {
  float u = clamp(d, 0.0, uDMax) / uDMax * (uLutN - 1.0);
  float i0 = floor(u);
  float f = u - i0;
  float y = (float(ch) + 0.5) / 3.0;
  float a = texture(uLut, vec2((i0 + 0.5) / uLutN, y)).r;
  float b = texture(uLut, vec2((min(i0 + 1.0, uLutN - 1.0) + 0.5) / uLutN, y)).r;
  return mix(a, b, f);
}

void main() {
  vec3 s = fetchScan(vUV);
  s = uScanMat * (s - uBlack);
  vec3 d = log2(max(uBase, vec3(1e-7)) / max(s, vec3(1e-7))) * 0.30102999566; // log10
  vec3 logH = vec3(lutAt(0, d.r), lutAt(1, d.g), lutAt(2, d.b));
  vec3 L = vec3(0.18) * exp2(logH * 3.32192809489) * uExposure; // 10^x
  L = uOutMat * L;
  L = max(L, vec3(0.0));
  vec3 o = mix(12.92 * L, 1.055 * pow(L, vec3(1.0 / 2.4)) - 0.055,
               step(vec3(0.0031308), L));
  fragColor = vec4(o, 1.0);
}`;

const FRAG_U8 = `#version 300 es
precision highp float;
uniform sampler2D uScan;
vec3 fetchScan(vec2 uv) { return texture(uScan, uv).rgb; }
${FRAG_BODY}`;

const FRAG_U16 = `#version 300 es
precision highp float;
uniform highp usampler2D uScan;
vec3 fetchScan(vec2 uv) { return vec3(texture(uScan, uv).rgb) * (1.0 / 65535.0); }
${FRAG_BODY}`;

export class GpuInverter {
  private gl: WebGL2RenderingContext;
  private progU8: WebGLProgram;
  private progU16: WebGLProgram;
  private lutTex: WebGLTexture;
  private scanTex: WebGLTexture;
  private lutN = 2048;
  params: GpuParams = {
    baseCal: [1, 1, 1],
    black: [0, 0, 0],
    scannerMatrix: MAT3_IDENTITY,
    dMax: 3,
    exposure: 1,
    outputMatrix: MAT3_IDENTITY,
  };

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: false });
    if (!gl) throw new Error('这个浏览器不支持 WebGL2');
    this.gl = gl;
    this.progU8 = this.build(FRAG_U8);
    this.progU16 = this.build(FRAG_U16);
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.lutTex = gl.createTexture()!;
    this.scanTex = gl.createTexture()!;
  }

  static supported(): boolean {
    return !!document.createElement('canvas').getContext('webgl2');
  }

  private build(fragSrc: string): WebGLProgram {
    const gl = this.gl;
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error('shader 编译失败: ' + gl.getShaderInfoLog(sh));
      return sh;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error('shader 链接失败: ' + gl.getProgramInfoLog(prog));
    return prog;
  }

  /** 上传三条 LUT(每通道一条),R32F 纹理 2048x3 */
  setLuts(r: Float32Array, g: Float32Array, b: Float32Array): void {
    const gl = this.gl;
    this.lutN = r.length;
    const packed = new Float32Array(this.lutN * 3);
    packed.set(r, 0);
    packed.set(g, this.lutN);
    packed.set(b, this.lutN * 2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.lutN, 3, 0, gl.RED, gl.FLOAT, packed);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** 处理一帧,返回 sRGB 的 ImageData */
  process(frame: GpuFrame): ImageData {
    const gl = this.gl;
    const { width: w, height: h } = frame;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const is16 = frame.data instanceof Uint16Array;
    // RGB → RGBA
    const px = w * h;
    let rgba: Uint8Array | Uint16Array;
    if (is16) {
      const src = frame.data as Uint16Array;
      const dst = new Uint16Array(px * 4);
      for (let i = 0, j = 0; i < px * 3; i += 3, j += 4) {
        dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 65535;
      }
      rgba = dst;
    } else {
      const src = frame.data as Uint8Array;
      const dst = new Uint8Array(px * 4);
      for (let i = 0, j = 0; i < px * 3; i += 3, j += 4) {
        dst[j] = src[i]; dst[j + 1] = src[i + 1]; dst[j + 2] = src[i + 2]; dst[j + 3] = 255;
      }
      rgba = dst;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.scanTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (is16) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16UI, w, h, 0, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, rgba);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const prog = is16 ? this.progU16 : this.progU8;
    gl.useProgram(prog);
    gl.viewport(0, 0, w, h);
    const u = (name: string) => gl.getUniformLocation(prog, name);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.scanTex);
    gl.uniform1i(u('uScan'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.uniform1i(u('uLut'), 1);
    const p = this.params;
    gl.uniformMatrix3fv(u('uScanMat'), false, mat3Transpose(p.scannerMatrix));
    gl.uniform3fv(u('uBase'), p.baseCal);
    gl.uniform3fv(u('uBlack'), p.black);
    gl.uniform1f(u('uDMax'), p.dMax);
    gl.uniform1f(u('uExposure'), p.exposure);
    gl.uniformMatrix3fv(u('uOutMat'), false, mat3Transpose(p.outputMatrix));
    gl.uniform1f(u('uLutN'), this.lutN);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const buf = new Uint8ClampedArray(px * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // readPixels 原点在左下,翻回顶行优先
    const img = new ImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) {
      img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    }
    return img;
  }
}
