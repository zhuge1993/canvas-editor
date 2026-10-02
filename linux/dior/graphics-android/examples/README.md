# 独立 FP32 OpenCL 矩阵乘法应用

`matrix-multiply.c` 是可编译、可修改的独立应用例子，执行行优先 FP32 矩阵乘法 `C = A × B`，不是调用原来的固定整数向量 probe。它直接在线编译 OpenCL 1.1 kernel，只选择 `CL_DEVICE_TYPE_GPU` 且 online compiler 可用的设备；不允许 CPU fallback。

`run-matrix.py` 以普通 `dior` 用户启动同目录下唯一的 `dior-matrix-worker`。它复用 `/opt/dior-android/run-native.py` 的只读 SDK/property FD 校验与 bounded child transport，使用已安装的原机 vendor library；没有修改生产启动器白名单、SDK、全局属性文件或系统 Mesa。新 worker 是单独的 Android/Bionic 进程。

## 2026-10-02 真机结果

UID 10000 实际完成 16×16、32×32 各 3 轮改变输入的矩阵乘法，全部 3,840 个 output cells 与独立 CPU reference 一致，最大 absolute error 为 0，测试前后 kernel taint 为 0。记录为任务交付目录下的 `outputs/GPU-APPLICATION-MATRIX.json`。

输入选用小的二进制分数，逐 cell 比较容差为 `1e-6`；每轮先 poison output，检查实际 GPU 回读。结果记录设备/version/profile、online build log、GPU profiling 和 resource cleanup。这证明本例的 FP32 计算可实际调用，不构成所有 floating-point 精度、所有 OpenCL API 或任意输入的 conformance 认证。设备路径为 OpenCL 1.1 Embedded，不要求 Vulkan、CUDA 或 GLES compute shader。

本次实测 worker：44,232 bytes，SHA256 `fe7772f6f9b94f01d72dbaea5ee8454735630665b0d09f9f14c3e019b0f5a72d`。二进制不跟踪在源码仓库中；launcher 的默认 hash 对应这份实测构建。重新构建后，应在自己的输出目录内将 launcher pin 更新为新 binary 的 hash。

## 从源码构建

使用 NDK r17c / revision 17.2.4988734 的 ARM GCC 4.9，目标 API 19、ARM32、softfp PIE，沿用私有 interpreter。以下命令从仓库根目录执行；只写 `artifacts/dior-matrix-example`，不部署到手机或修改 SDK。

Windows PowerShell：

```powershell
$ndk = 'C:/Android/android-ndk-r17c'
$out = 'artifacts/dior-matrix-example'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$compiler = "$ndk/toolchains/arm-linux-androideabi-4.9/prebuilt/windows-x86_64/bin/arm-linux-androideabi-gcc.exe"
$strip = "$ndk/toolchains/arm-linux-androideabi-4.9/prebuilt/windows-x86_64/bin/arm-linux-androideabi-strip.exe"
& $compiler -std=c99 -O2 -g -Wall -Wextra -Werror `
  -D__ANDROID_API__=19 -march=armv7-a -mfloat-abi=softfp -mfpu=neon `
  -fPIE -pie "--sysroot=$ndk/platforms/android-19/arch-arm" `
  -isystem "$ndk/sysroot/usr/include" `
  -isystem "$ndk/sysroot/usr/include/arm-linux-androideabi" `
  '-Wl,--hash-style=sysv' '-Wl,--dynamic-linker,/opt/dior-android/system/bin/linker' `
  linux/dior/graphics-android/examples/matrix-multiply.c `
  -o "$out/dior-matrix-worker" -ldl -lm
if ($LASTEXITCODE -ne 0) { throw 'Matrix worker build failed' }
& $strip --strip-debug "$out/dior-matrix-worker"
if ($LASTEXITCODE -ne 0) { throw 'Matrix worker strip failed' }
Copy-Item linux/dior/graphics-android/examples/run-matrix.py "$out/run-matrix.py"
$workerHash = (Get-FileHash -Algorithm SHA256 "$out/dior-matrix-worker").Hash.ToLowerInvariant()
$launcherText = [IO.File]::ReadAllText("$out/run-matrix.py", [Text.Encoding]::UTF8)
$launcherText = $launcherText -replace "EXPECTED_WORKER_SHA256 = '[a-f0-9]{64}'", "EXPECTED_WORKER_SHA256 = '$workerHash'"
[IO.File]::WriteAllText("$out/run-matrix.py", $launcherText, [Text.UTF8Encoding]::new($false))
```

Linux 使用相同 flags，compiler/strip 路径的 host 部分改为 `prebuilt/linux-x86_64/bin/arm-linux-androideabi-gcc` 与 `arm-linux-androideabi-strip`。生成的 ELF 必须是 ARM32 EABI5 soft-float calling ABI、PIE，interpreter 必须为 `/opt/dior-android/system/bin/linker`；可以用原 `build-native.py` 的 `elf_proof()` 进行同样的检查。

## 在已配置的 Dior SDK 上运行

将输出目录里的 launcher 和 worker 放到手机同一 scratch 目录，例如 `/tmp/dior-app-tests`，赋予 worker 执行权限。使用普通 `dior` 账户：

```sh
chmod 755 /tmp/dior-app-tests/dior-matrix-worker
python3 /tmp/dior-app-tests/run-matrix.py --repeat 3 --timeout 45 \
  > /tmp/dior-app-tests/matrix-result.json
```

启动器校验 worker SHA256，16 / 32 两个 dimension 各在独立进程中执行。退出码 0 必须同时有 `hardware_application_compute_pass: true`、每个 case 完整的 GPU result、所有 output cells 正确和最终 taint 0；missing dependency、timeout、nonzero exit、错误结果会失败。

普通应用可使用同样的 separate native-worker 模型提交自己的 GPU kernel；musl 进程不要直接混装 Bionic driver library。这里仍是一个固定矩阵示例，没有增加通用 RPC、网站 API 或自动让其它应用改用 GPU 的功能。
