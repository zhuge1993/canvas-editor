# Dior original Adreno GPU runtime

This path runs the phone's original Android 4.4.4 GPU userspace in a separate
Android/Bionic process on Dior Linux. Native OpenCL computation and offscreen
GLES rendering have passed on the actual Adreno 305. It does not replace the
system Mesa libraries or convert every Linux application to GPU rendering.

The kernel remains `msfkonsole/android_kernel_xiaomi_dior` at
`12f40d54ab4e34dabaeb8dd7979bedc3cc8fa064`, built with GCC 4. The tested
running kernel is `3.4.0-msf #9-postmarketOS` / package r8. This userspace
work requires no partition flashing or firmware/NV replacement.

## Architecture

The private runtime lives under `/opt/dior-android`. Its linker, Bionic
libraries, GPU driver, shader compiler and required hardware modules are
copied from this phone's existing Android system through a read-only mount.
The public repository and build artifacts contain no proprietary libraries.
Runtime provisioning belongs to the root installer; ordinary `dior` users
run the resulting probes without sudo.

`run-native.py` starts a bounded child process with the private Android
linker and a private library search path. It opens the immutable KitKat
property area and passes its descriptor through `ANDROID_PROPERTY_WORKSPACE`.
This supplies the original Bionic property mechanism without creating a
global `/dev/__properties__` or exposing credentials. Only immutable board
properties are needed. The launcher validates SDK paths, file ownership and
the property trie, caps output, enforces the timeout and checks native JSON
against the requested operation.

`dior-opencl-probe.c` loads the original `libOpenCL.so` through `dlopen` and
standard `dlsym`. It chooses a GPU device, creates a profiling queue, compiles
an integer kernel, uploads two input vectors and checks the complete result
against an independent CPU reference. A CPU fallback cannot pass the test.

`dior-gles-probe.c` directly loads the original `libEGL_adreno.so` and
`libGLESv2_adreno.so`. It requests a GLES 2 or GLES 3 context with an EGL
pbuffer, then renders into a 16x16 RGBA FBO. It verifies every pixel of red,
blue and white clears, a compiled green-triangle shader, and two-texture
fragment arithmetic. Vendor logs go to stderr and a private output stream
retains JSON. The display framebuffer is not changed.

Applications can use the same separate-process model for explicit GPU jobs.
The musl service communicates with a native worker through an application
protocol; it must not load Bionic driver libraries directly into its process.
These validation executables are probes, not a general image-processing RPC
service or a browser/compositor driver.

## Reproducible public build

Use **NDK r17c, revision 17.2.4988734, ARM GCC 4.9**, not a newer toolchain.
`build-native.py` checks the NDK version header and compiler, uses API19
libraries and unified headers, and builds both C sources. It works with
Windows x64 and Linux x64 NDK host toolchains; the Windows path was executed
for the current delivery.

Official pinned archives:

| Host | Archive | Bytes | SHA1 |
| --- | --- | ---: | --- |
| Windows x64 | [android-ndk-r17c-windows-x86_64.zip](https://dl.google.com/android/repository/android-ndk-r17c-windows-x86_64.zip) | 650626501 | `3e3b8d1650f9d297d130be2b342db956003f5992` |
| Linux x64 | [android-ndk-r17c-linux-x86_64.zip](https://dl.google.com/android/repository/android-ndk-r17c-linux-x86_64.zip) | 709387703 | `12cacc70c3fd2f40574015631c00f41fb8a39048` |

From the repository root, for example on Windows:

```powershell
python linux/dior/graphics-android/build-native.py `
  --ndk-dir C:/Android/android-ndk-r17c `
  --ndk-archive C:/Android/android-ndk-r17c-windows-x86_64.zip `
  --output artifacts/dior-native-gpu
```

On Linux:

```sh
python3 linux/dior/graphics-android/build-native.py \
  --ndk-dir "$HOME/android-ndk-r17c" \
  --ndk-archive "$HOME/android-ndk-r17c-linux-x86_64.zip" \
  --output artifacts/dior-native-gpu
```

`--output` must be a new or empty directory. `--ndk-archive` is optional for
an already installed NDK; providing it also verifies the official archive's
size and SHA1. The manifest records whether that archive verification ran.
The builder never downloads, copies vendor libraries or installs on a phone.

Compilation uses `-std=c99 -O2 -g -march=armv7-a -mfloat-abi=softfp -mfpu=neon`,
`-fPIE -pie`, the API19 ARM platform sysroot, SysV symbol hashes and the
interpreter `/opt/dior-android/system/bin/linker`. Both probes link `libdl`;
GLES also links `libm`. The sources resolve GPU API symbols at runtime.

Output contains deployable `dior-opencl-probe` and `dior-gles-probe`, complete
debug ELFs under `debug/`, `NATIVE-GPU-BUILD.json` and `SHA256SUMS`. Only debug
data is removed from deployable copies. The builder verifies little-endian
ARM32 EABI5 PIE executables, the soft-float calling ABI and the exact private
interpreter. The manifest records source and binary SHA256, compiler/tool
SHA256, NDK pins and flags. Its physical GPU validation fields remain false:
compilation and ELF checks do not prove device execution.

## Install on this phone

Copy the public build and these installer sources to one directory on the
phone. The directory must contain `NATIVE-GPU-BUILD.json`, both checked
executables, `install-runtime.py`, `runtime-source.py`, `property-area.py`,
`run-native.py`, `verify-native.py` and `70-dior-gpu-access.rules`.

As root, mount the existing Android system read-only and install:

```sh
mkdir -p /tmp/dior-kernel-test/android-system-ro
mount -t ext4 -o ro,noload,nosuid,nodev,noexec \
  /dev/disk/by-partlabel/system /tmp/dior-kernel-test/android-system-ro
python3 install-runtime.py --build .
umount /tmp/dior-kernel-test/android-system-ro
```

Use `--update` only when replacing an existing private SDK. It retains a
`/opt/dior-android.backup-<pid>` directory and copies the original libraries
again with verified hashes. The tested unified installer resolved 35
original libraries, retained a backup, and passed fresh non-root OpenCL and
GLES 3 runs after installation.

The installer copies only original GPU dependencies and the linker, creates
private loader aliases and immutable board properties, installs the two
public executables and launchers, and grants the `video` group access to
`kgsl-3d0` and `ion`. The udev rule persists these permissions across boots.
It never flashes system/userdata/boot or writes firmware, NV, modem or
persist. Always unmount the original system after provisioning.

## Run and verify on the phone

After the root installer has provisioned the private SDK and binaries, use
the public launcher as ordinary `dior`. These commands run from the directory
containing `run-native.py`:

```sh
python3 run-native.py --kind opencl --timeout 45 -- --inventory-only
python3 run-native.py --kind opencl --timeout 45 -- --repeat 50
python3 run-native.py --kind gles --timeout 45 -- --version 2 --repeat 50
python3 run-native.py --kind gles --timeout 45 -- --version 3 --repeat 50
```

Add `--trace` after `--` for vendor-call diagnostics. Exit zero must accompany
a complete JSON success result. OpenCL requires `PASS_GPU_COMPUTE`, a GPU
device and exact per-element matches; `INVENTORY_ONLY` is not a computation
pass. GLES requires `PASS_GPU_RENDER`, hardware Adreno identification,
matching pixels, zero GL errors, all requested iterations and successful
cleanup. A timeout, signal, missing dependency or contradictory success
claim fails closed.

The installed suite runs as ordinary `dior`:

```sh
python3 /opt/dior-android/verify-native.py --output /tmp/dior-gpu-tests/result.json
```

## Actual validation and limits

The 2026-10-02 device records are `NATIVE-GPU-STABILITY.json`,
`NATIVE-opencl-50.json` and `NATIVE-gles3-50.json` in the delivery's `outputs/`
directory. All 14 stability cases passed under ordinary `dior` (UID 10000):
GLES 3 smoke, 50 rounds each of OpenCL/GLES 2/GLES 3, three fresh OpenCL/GLES
process pairs, concurrent OpenCL with GLES 3, and two concurrent GLES 3
processes. All compared values matched. Kernel taint remained 0 before and
after. The KGSL reset counter also counts normal cold starts, so its change
is not interpreted as a fault-only counter.

| Verified interface | Device result |
| --- | --- |
| EGL | Qualcomm EGL 1.4 pbuffer/FBO path |
| GLES | Explicit GLES 2 and GLES 3 contexts; `Adreno (TM) 305`; ES 3.0 / GLSL ES 3.00 |
| GLES correctness | Full clear pixels, triangle interior/exterior samples and independent texture arithmetic; 50 rounds |
| OpenCL | `OpenCL 1.1 Adreno(TM) 305`, `EMBEDDED_PROFILE`, one GPU compute unit |
| OpenCL correctness | 4096 int32 elements per round, 50 rounds, exact CPU reference, GPU profiling events |
| Queried GLES limits | Texture/renderbuffer size 4096, vertex attributes 16, combined texture units 32 |

This establishes native GPU rendering and the tested integer computation
path. It is not a complete API conformance suite, a floating-point accuracy
qualification or proof for every long-running workload, display mode,
suspend cycle and GPU fault. Zero bugs cannot be guaranteed from these tests.
The tested driver reports GLES 3.0 and OpenCL 1.1 Embedded; Vulkan and GLES
3.1 compute shaders are not exposed by this path. Extensions are recorded as
capabilities, not assumed to have passed functional tests.

The distribution's standard Mesa path still rendered through llvmpipe in
its separate baseline. No automatic global switch to the proprietary
runtime is made. A local Linux desktop, compositor or application requires
its own integration and verification before it benefits from this GPU.

FlowBoard serves files, accounts and project data on the phone, while its
Canvas 2D drawing runs in each visitor's browser. Enabling this phone's GPU
does not automatically accelerate that remote browser, WiFi throughput or
the public tunnel. A future service-side thumbnail/image renderer would
need an explicit native worker and measured end-to-end benefit.
