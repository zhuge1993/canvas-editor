# Dior GPU 应用调用示例

`gpu-application-smoke.py` 是普通 Linux 程序的独立 EGL/GLES2 示例。它自己创建 GBM 设备、EGL context、VBO、两个 FBO 和两套 shader，并用独立 CPU 参考逐像素检查结果；不导入既有 GPU probe 的验证函数。

2026-10-02 的手机实测记录为交付目录 `outputs/GPU-APPLICATION-SMOKE.json`。运行用户为 `dior`（UID 10000），内核为 `3.4.0-msf`，显式使用 `/opt/dior-graphics` 中的隔离 Mesa 17.3.9 runtime。

| 实测项目 | 结果 |
| --- | --- |
| 普通用户调用 | 3 个独立子进程，分别创建和销毁 EGL context，退出码全部为 0 |
| API 身份 | EGL 1.4，`freedreno` / `FD001`，OpenGL ES 2.0，GLSL ES 1.0.16 |
| 图形应用 | 128×128 affine gradient 与 256×256 animated checker，两套独立 shader |
| Uniform 变化 | 每个 context 各 3 轮，变更渐变系数、棋盘偏移与两组颜色 |
| 完整像素比较 | 18 张图像、737,280 个像素；超出容差的像素为 0 |
| 量化误差 | Gradient 最大通道差 1；checker 通道差 0；允许的 RGBA8 容差为 2 |
| 资源清理 | 每个 context 的 `cleanup_pass=true`，`cleanup_errors=[]` |
| 内核状态 | 各 context 前后 `tainted=0`，stderr 为空 |
| 查询能力 | Fragment highp 精度 23 位，范围 `[127,127]`；最大纹理尺寸 8192 |

最大纹理尺寸和扩展列表是 API 查询结果。本例实际绘制的最大尺寸是 256×256；它没有验证所有扩展、大纹理、显示输出或全部 GLES API。整套测试耗时约 15.968 秒，包含启动、CPU 参考生成、逐像素比较和清理。各帧记录的 `draw_finish_wall_ms` 包含提交与同步，不能直接当成纯 GPU 时间或应用 FPS。

以普通 `dior` / `video` 用户运行手机上已复制的脚本：

```sh
python3 /tmp/gpu-application-smoke.py \
  --contexts 3 --iterations 3 \
  --timeout 180 --child-timeout 50 \
  > /tmp/GPU-APPLICATION-SMOKE.json
```

脚本在启动每个独立子进程时设置私有库与 DRI 路径，默认访问 `/dev/dri/card0`。它要求当前经过验证的 `freedreno / FD001` 身份；软件 renderer、错误库、缺失 API、GL 错误、像素不符、超时或清理失败都会返回失败。通过时输出：

```json
{
  "status": "PASS_HARDWARE_APPLICATION_SUITE",
  "validation_pass": true,
  "hardware_application_pass": true
}
```

`--self-test` 只检查 CPU 参考和比较器，可在开发电脑运行；它会保持硬件验证标志为 false。

自己的 Linux GLES2 应用也需要在启动进程时显式选择这个 runtime，例如：

```sh
unset LIBGL_ALWAYS_SOFTWARE GALLIUM_DRIVER
LD_LIBRARY_PATH=/opt/dior-graphics/lib \
LIBGL_DRIVERS_PATH=/opt/dior-graphics/lib/dri \
MESA_LOADER_DRIVER_OVERRIDE=kgsl \
./my-gles2-application
```

应用可按示例的 `Application` 类调用标准 API：打开 DRM fd、`gbm_create_device`、`eglGetPlatformDisplayEXT(EGL_PLATFORM_GBM_KHR, ...)`、选择 GLES2 config、创建 context 并 make-current，然后编译/链接 shader、设置 uniforms、绘制到 FBO、`glFinish` 和 `glReadPixels`。当前实测使用 surfaceless context；示例也处理可用的 pbuffer config。结束时逐项删除 GL 对象，detach context，检查 EGL 销毁返回值，再销毁 GBM 设备和关闭 fd。

程序需要按报告的 GLES2 版本与扩展选择 API。这里的 KGSL runtime 针对 Mesa 的完整状态恢复 batch；它不是任意部分 raw command stream 的兼容承诺。单个示例通过说明该应用调用路径可用，不能保证所有程序或全部 API 都没有问题。

OpenCL 计算使用另一条已验证路径：`/opt/dior-android` 中本机原有 Adreno 用户态库，在独立 Android/Bionic worker 进程运行，支持报告的 **OpenCL 1.1 Embedded Profile**。Linux musl 程序通过有界输入/输出协议调用 worker；Bionic GPU 库由该独立进程加载。现有 launcher 为 worker 设置私有 linker、库搜索路径和 property-area FD。

已安装的计算 probe 可由普通 `dior` 用户运行：

```sh
python3 /opt/dior-android/run-native.py \
  --kind opencl --timeout 45 -- \
  --repeat 3 --elements 4096
```

已有 `GPU-LIVE-OPENCL.json`、`NATIVE-opencl-50.json` 和 `NATIVE-opencl-million.json` 记录分别验证 4096 元素×3 轮、4096 元素×50 轮及 1,048,576 元素×3 轮的整型 GPU 计算，返回 `PASS_GPU_COMPUTE` 且全部结果与 CPU 参考一致。当前 `run-native.py` 只启动随 runtime 登记的固定 worker；自定义计算需要自己的 native worker、结果协议和独立验证。构建及安装说明见 `../graphics-android/README.md`。

本 GLES 应用示例的 `opencl_verified` 和 `compute_shader_verified` 始终为 false；OpenCL 结果由上述独立计算记录证明。新的 FP32 matrix 应用验证另行记录，本文不把待执行项目算作通过。当前路径没有提供 Vulkan 或 GLES 3.1 compute shader 的验证。

FlowBoard 的网页 Canvas 绘制由访问者浏览器执行。要让手机 GPU 处理服务器端图像或计算任务，后端需要显式调用经过验证的 worker，并测量端到端收益；选择手机 runtime 不会自动改变所有应用的渲染方式。
