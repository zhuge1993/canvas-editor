# 重建 Dior CPU 流式识别程序

此目录公开本次 ARMv7 重建所需的本地源码、兼容代码与固定输入清单。
构建脚本不依赖开发者的 `work/asr-cpu`、私人 SDK 或某个电脑的绝对路径。
所有生成文件、依赖副本、日志、目标文件和二进制都写入显式指定的 `--out`。
请把该输出目录放在源码仓库之外。下面的命令假设当前目录是与 `canvas-editor` 仓库同级的独立工具工作目录；Sherpa、NDK、下载归档和生成目录都放在这个工作目录中。

本轮提供并验证了重建脚本的输入校验、命令计划和语法；没有使用这份新脚本
重新编译整套库。`dependencies.lock.json` 中的既有二进制 SHA 是此前构建的
来源记录，不能作为本脚本已重新构建或在手机执行的证明。新生成的
`BUILD.json` 默认同样记录 `phone_execution_verified=false`。

## 固定版本

| 输入 | 固定值 |
| --- | --- |
| Sherpa NCNN | v2.1.15，`c794e1439fce79932e989220aa1c2848ecbdcdcf` |
| NCNN | `c4193aadbbb56582aa87b1850dd3d98fb8fd936d` |
| NDK | r17c / `17.2.4988734`，Clang 6.0.2 编译，GCC 4.9 链接 |
| CPU ABI | ARMv7、NEON/VFPv4、softfp、PIE |
| C++ 标准 | Sherpa/依赖/worker 使用 C++14，纯 C API benchmark 使用 C++17 |
| 线程库 | 静态 OpenMP，运行时使用 passive waiting |
| C++ 运行库 | 静态 libc++、libc++abi、android-support、unwind、libatomic |
| ELF 解释器 | `/opt/dior-android/system/bin/linker` |
| 动态依赖 | 仅 `libc.so`、`libm.so`、`libdl.so`、`liblog.so` |

完整 URL、归档哈希、上游 CMake 配方哈希及本地四个源文件的哈希见
[build/dependencies.lock.json](build/dependencies.lock.json)。构建前要求 Git
提交与配方匹配，并校验六个依赖归档。已有工作区修改不会混入构建，实际
源文件来自固定提交的 `git archive`，在输出目录的副本上应用兼容改动。
上游三个 Kotlin 文件别名会复制其归档内的普通目标文件，输出目录不创建
符号链接；归档外目标、设备文件、越界路径和重复路径都会被拒绝。

## 准备工具与源码

需要 Python 3.10 或更新版本、Git、CMake 3.31 与 Ninja；其他 CMake 版本
需要自行重新验收。Windows 为本次实际构建的平台。Linux/macOS 的工具布局
也可通过参数选择，但该主机平台没有在本轮重新构建验收，不能承诺字节一致。

```sh
git clone https://github.com/k2-fsa/sherpa-ncnn.git sherpa-source
git -C sherpa-source checkout c794e1439fce79932e989220aa1c2848ecbdcdcf
```

从 [Android NDK 官方历史下载页](https://github.com/android/ndk/wiki/unsupported-downloads)
取得并完整解压 NDK r17c。Windows 64 位包的
[官方下载地址](https://dl.google.com/android/repository/android-ndk-r17c-windows-x86_64.zip)
对应 650,626,501 bytes，官方公布的 SHA1 是
`3e3b8d1650f9d297d130be2b342db956003f5992`。本轮从已使用归档实际计算的
SHA256 是 `8a2632b6c52d8b327a66240c276f09226089ef4516c43476f08723a668d30c30`。
脚本同时校验官方大小、SHA1 和该 SHA256。Linux/macOS 包另需提供可信的
`--ndk-zip-sha256`，其官方大小与 SHA1 也必须匹配清单。

`--ndk-root` 指向完整解压出的 `android-ndk-r17c`，`--ndk-zip` 指向原归档。
实际构建还会将所选编译器、链接工具和静态运行库逐项与该归档核对。
默认从 NDK 选择以下相对位置，无需复制成任何私人目录：

- `toolchains/llvm/prebuilt/<host>/bin/clang`
- `toolchains/arm-linux-androideabi-4.9/prebuilt/<host>`
- `sources/cxx-stl/llvm-libc++` 与 `sources/cxx-stl/llvm-libc++abi`
- `sources/android/support/include`
- `platforms/android-19/arch-arm` 和 `sysroot/usr/include`
- LLVM `lib64/clang/6.0.2/lib/linux/arm/libomp.a`
- GCC `arm-linux-androideabi/lib/armv7-a/libatomic.a`，不选择 hard-float 目录

Windows 可执行文件会自动添加 `.exe`。工具不在 PATH 时，用 `--cmake`、
`--ninja` 指定工具；也可以设置 `DIOR_CMAKE` 与 `DIOR_NINJA`。其余环境变量
入口为 `DIOR_NDK_ROOT`、`DIOR_NDK_ZIP`、`DIOR_NDK_ZIP_SHA256`、
`DIOR_SHERPA_SOURCE` 与 `DIOR_ASR_BUILD_DIR`。`--clang`、`--gcc-root`、
`--stl-root`、`--libcxxabi`、`--omp`、`--atomic` 可选择重定位工具，但实际
构建仍要求对应关键文件与锁定 NDK 包相同，不能借此更换为新版编译器。

## 只读检查与完整构建

先检查帮助与锁定输入，不会调用编译器或写输出文件：

```sh
python ../canvas-editor/linux/dior/asr-streaming/build/rebuild.py --help
python ../canvas-editor/linux/dior/asr-streaming/build/rebuild.py --print-lock
```

准备好六个归档后，可以把它们放进 `--archive-cache`，文件名按 lock 清单。
或者使用重复的 `--dep-archive NAME=PATH` 指定现有文件：`ncnn`、
`kaldi_native_fbank`、`kaldifst`、`openfst`、`json`、`kissfft`。

```sh
python ../canvas-editor/linux/dior/asr-streaming/build/rebuild.py \
  --sherpa-source sherpa-source \
  --ndk-root android-ndk-r17c \
  --ndk-zip android-ndk-r17c-windows-x86_64.zip \
  --host-tag windows-x86_64 \
  --out generated-asr \
  --archive-cache dependency-archives \
  --verify-only
```

`--verify-only` 要求所有归档已经存在，检查归档和源码；它不验证当前解压
工具根目录的所有文件，也不调用编译器。`--dry-run` 另外打印完整命令计划，
生成路径用 `<OUT>`、`<SRC>`、`<NDK>` 表示。两种模式都不会下载或写盘。
完整构建才检查实际关键工具文件并运行编译。

完整构建去掉 `--verify-only`。如果缺少依赖归档，可以明确加入 `--download`，
脚本才会从清单中的 HTTPS 地址下载，且必须匹配 SHA256 后才能使用。
不指定这个选项时，缺少归档直接失败。

```sh
python ../canvas-editor/linux/dior/asr-streaming/build/rebuild.py \
  --sherpa-source sherpa-source \
  --ndk-root android-ndk-r17c \
  --ndk-zip android-ndk-r17c-windows-x86_64.zip \
  --host-tag windows-x86_64 \
  --out generated-asr \
  --download --jobs 4
```

上述 shell 示例使用反斜杠续行；PowerShell 可以写在同一行，或使用其原生
反引号续行。示例均使用相对目录，按自己的位置选择参数。

输出为 `stream-worker`、`stream-benchmark`、`BUILD.json`、两份 ELF 证据及
`LIBRARIES.json`。生成目录有标记；脚本拒绝占用已有非空未管理目录，
拒绝输出进入输入源码/工具链目录，也不会递归删除任何旧输入。
复用生成的源码副本时会校验完整文件清单；参数变化、来源变化或副本被修改
应使用新的输出目录。生成文件没有必要提交到 Git。

## 只重建 wrapper

已有本次固定来源的八个静态库时，可跳过整套库编译：

```sh
python ../canvas-editor/linux/dior/asr-streaming/build/rebuild.py \
  --sherpa-source sherpa-source \
  --ndk-root android-ndk-r17c \
  --ndk-zip android-ndk-r17c-windows-x86_64.zip \
  --host-tag windows-x86_64 \
  --out generated-wrapper \
  --archive-cache dependency-archives \
  --mode wrappers --wrapper worker \
  --libs-dir previous-build/lib \
  --libs-manifest previous-build/LIBRARIES.json
```

`--libs-manifest` 也兼容此前含 `archives` 的 `BUILD.json`，但要求提交匹配，
且八个库逐个匹配哈希；不会把目录里任意 `.a` 文件都链接进去。
`--mode libraries` 则只生成静态库。默认 `--mode all --wrapper both`。

## 兼容改动和验收边界

- `DIOR_NO_ANDROID_ASSETS` 仅屏蔽 API19 不具备的 APK AssetManager 入口，
  普通文件模型推理保留；改动只在输出目录的 19 个源码副本中应用。
- API19 本地 `rand_r` 兼容函数解决可选 dither 路径符号；ASR 默认 dither 为 0。
- OpenFST/库使用 C++14，绕过 Clang 6 的 C++17 数组地址模板限制。
- NCNN Vulkan 和 Android platform API 关闭，ARM82/ARM84 关闭，CPU NEON 保留。
- 不修改模型权重、推理算子、手机 SDK、内核、GPU 或网站服务。

新构建成功并通过 ELF 校验后，仍需要单独进行模型加载、协议、识别准确率、
温度和流式时延真机验收。文件 EOS 时间与真实 endpoint 时间必须分别记录；
paced WAV 不代表真实麦克风端到端延迟。
