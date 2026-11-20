# 负片转正 neg2pos

网页端负片→正片转换工具。针对扫描仪自带软件的两个老毛病:

1. **片基按固定值减** —— 不同批次片基颜色不同,减完暗部发青亮部发红。
   这里**每卷从片边未曝光处实测片基色**,按比值扣,跟卷走不跟经验走。
2. **三个通道一起拉** —— 负片 RGB 三层反差本来就不一样。
   这里**每通道一条独立的特性曲线(D-logE)**,各自反算回线性光。

另外用 **IT8 色卡标定扫描仪**:光源偏色 + 传感器通道串扰解成一个 3×3 矩阵扣掉。
转换计算在 **WebGL2** 里跑,外壳 TypeScript,无任何运行时依赖。

## 转换流水线

```
扫描值 S ──(-黑电平)──▶ ×IT8 标定矩阵 ──▶ D = log10(片基/S)  每通道密度
   ──▶ 曲线 LUT 反算 logH(每通道独立)──▶ L = 0.18·10^logH  线性光
   ──▶ ×输出矩阵 ──▶ sRGB 编码 ──▶ PNG
```

正向合成(测试用)正好反过来:线性照片 → 特性曲线 → 密度 → 片基×光源 → 串扰 → 噪声 → 量化,
所以测试负片自带片基色和扫描仪偏色,和真扫描件同一模型。

## 快速开始

```bash
npm install
npm run build
npm run serve        # http://localhost:8123
```

使用顺序:

1. **扫描仪标定**(换一次扫描仪/光源做一次):扫 IT8 透射卡 → 载入 → 点四个角 →
   载入参考值文件 → 计算矩阵。没有色卡可先生成合成测试卡走流程。
2. **胶卷预设**:内置 Vision3 50D/250D/500T、CineStill 800T、Portra 400、Ektar 100、
   Pro 400H 等。内置曲线是合理起点——新卷用「从灰阶负片标定」:拍灰阶卡→冲洗扫描→
   从最透明到最黑依次点色块→自动生成三通道曲线,存为预设(JSON 可导入导出)。
3. **批量转换**:拖入整卷扫描件(16bit TIFF 最佳)→ 自动/手动取片基 →
   勾选 IT8 标定 → 开始。36 张一批,结果显示总耗时,可全部保存到文件夹。
4. **精度自测**:一键跑完全部预设的合成往返测试,直接看 ΔE 表格;
   另有 GPU/CPU 一致性检查和 36 张性能基准。

## 实测指标(本仓库测试)

- **偏色**:全部内置预设,16bit 扫描、带光源偏色+通道串扰+噪声,
  面积平均 CIEDE2000 **mean ≈ 0.2,max < 1.5**(要求 ΔE<2);
  不做 IT8 标定的对照组 mean ≈ 3,证明标定在起作用。
- **性能**:36 张 4000×3000 16bit,软件渲染(SwiftShader)下约 **11 秒**,
  真 GPU 更快,2 分钟预算非常宽裕。
- **GPU/CPU 一致性**:输出逐字节差 ≤ 1/255。

## 测试

```bash
npm test                                  # Node 单元/端到端测试(19 个)
# GPU 冒烟:npm run serve 后开 test/gpu-browser.html,或无头:
chrome --headless=new --use-angle=swiftshader --virtual-time-budget=90000 \
  --dump-dom http://localhost:8123/test/gpu-browser.html
```

## 目录

```
src/
  color.ts      sRGB/XYZ/Lab/CIEDE2000、3x3 矩阵、最小二乘标定
  curves.ts     PCHIP 单调特性曲线、反算、LUT
  films.ts      胶卷预设(每通道独立曲线)
  synth.ts      正向模型:照片→负片、合成 IT8 色卡
  invert.ts     CPU 参考流水线
  calibrate.ts  IT8 网格取样、矩阵求解、灰阶→预设
  tiff.ts       TIFF 解码(8/16bit、LZW/PackBits、Predictor)
  gpu/engine.ts WebGL2 引擎(LUT 纹理 + 全屏 pass)
  main.ts       UI
  selftest.ts   往返自测(Node 与浏览器共用)
test/           node:test 测试 + gpu-browser.html GPU 冒烟
```

## 已知限制

- **8bit 文件**(JPG/PNG)在负片暗部(场景高光)量化误差物理上就超 ΔE2,
  软件会提示;正式出片请扫 **16bit TIFF**。
- TIFF 支持:无压缩 / PackBits / LZW,8/16bit,灰度/RGB/RGBA;
  不支持 deflate、JPEG-in-TIFF、BigTIFF、PlanarConfiguration=2(会明确报错)。
- 扫描仪文件若是 gamma 编码,在「输入编码」里选 sRGB / Gamma 2.2 解码。
- 内置预设曲线是参数化起点,不是实测;量产前用灰阶负片标定修正成
  自己扫描仪+药水组合的实测曲线。
