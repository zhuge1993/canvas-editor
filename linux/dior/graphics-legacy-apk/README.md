# Dior Linux 原生 Mesa / KGSL 图形兼容层

此目录提供独立的 **musl Linux** 用户态：Mesa 17.3.9、libdrm 2.4.89 和针对 Dior 旧 KGSL 接口的兼容补丁。目标为 Adreno 305 与现有 Linux 3.4 内核；内核来源仍固定为 `msfkonsole/android_kernel_xiaomi_dior` 的 `12f40d54ab4e34dabaeb8dd7979bedc3cc8fa064`，内核继续使用 GCC 4 构建。

**2026-10-02，r7 已通过 Dior 真机上的 GLES 离屏渲染与 fragment 算术验收。** 源码为 `f0bfeab0777e2ce316a6df9a3727e190991de1d4`，完整构建 [run 37006893498](https://github.com/zhuge1993/canvas-editor/actions/runs/37006893498) 成功。普通 `dior` 用户（UID 10000）完成 7 项稳定性案例、80 轮改变输入的算术检查，共比较 5,242,880 个像素，mismatch 与最大 channel error 均为 0，cleanup 全部通过。案例包含单进程 50 轮、3 次进程重开以及两个并发进程。

混合运行也通过：Mesa 10 轮与 native OpenCL 的 1,048,576 元素 × 20 轮同时执行；另一次 Mesa 10 轮与 native GLES 3 的 50 轮同时执行。全部结果正确，测试前后 kernel taint 为 0，完整测试区间未新增 GPU stall/fault、protected-access 错误或 Oops。此前 r6 的算术 shader CPU SIGSEGV 经本次两个 sorting helper 修复后，同一完整 fixture 已通过；这不等于所有 API 均已认证。

当前手机已恢复并核对原有 r8 / `#9-postmarketOS` 的 GCC 4.9.4 boot，SHA256 为 `c3bf34316c4a352859e0e6d7841bf2ff09165741534fb72e8a6d582ae322c5e7`，本次恢复检查的 kernel taint 为 0。失败的 r9 内核候选已从默认 recipe 撤回；此运行库使用原有内核的用户态协议，不依赖放宽内核寄存器保护。

APK 编译、ARM32 ABI、ION 映射、timestamp 和 CPU 排序回归本身不能代替真实 GPU 渲染。包内 `share/GRAPHICS-BUILD-CHECKS.json` 作为构建记录仍保留 `physical_gpu_render_verified: false`；本次通过依据是交付目录 `outputs/` 下独立的真机结果与日志，见文末。

## 已纳入源码的兼容修复与边界

| 修复 | 本次源码处理范围 |
| --- | --- |
| Dior DRM / ION ABI 与 CPU mapping | 对照固定内核 UAPI 修正 wire 字段位置，通过真实 ION dma-buf 映射 GEM 数据，检查 allocation/map/relocation 失败并回收已取得的资源 |
| A305B 标识 | 仅对内核 enum 335 且 chip ID 为 `0x03000510` / `0x03000512` 的设备映射 Mesa family 305，保留真实 chip ID |
| libdrm 链表遍历 | 消除已发现的 typed sentinel 指针偏移问题，保留空表和真实节点的边界判断 |
| Context timestamp | 使用该 context 的 READ/WAIT 接口；private command BO fence 区分 owned pipe/context，接受合法的 wrap-zero timestamp。这不证明旧 GEM 的全部 wrap 路径 |
| Nested command BO 生命周期 | 保存 transitive、多 parent 的 BO 引用及 owned context/FD；提交前预分配 fence，失败回滚；shared reset 换用新 storage，原 parent 继续保留旧命令和依赖；retirement 失败在 unmap/FREE 前终止 |
| Mesa A3xx 完整 batch 的 2-IB 提交 | 3D context 使用 `PREAMBLE` / `NO_GMEM_ALLOC`。第一 IB 是独立持有的 immutable NOP，实际 batch 始终为第二 IB；每个实际 batch 自带完整 state restore，因此内核跳过第一 IB 不会跳过实际命令或 restore |
| GNU15 下 NIR varying 排序 | 仅修改 `insert_sorted` / `sort_varyings` 两个 helper：先按 raw `exec_node` 判断真实 tail，再转换变量；保留 stable ties、move 与相邻 uniforms/outputs 链 |

2-IB 方案限于本包与 Mesa 17.3.9 A3xx **每个 batch 都完整 restore** 的组合，不能套用于任意 partial raw command stream。NOP 和 nested command storage 同样需要 fence/dependency 生命周期管理；它不承担完整 state restore，也不访问 protected registers。此处没有修改内核保护表或所有 list 宏。源码修复与 focused tests 的范围明确，整个驱动或所有 API 的零 bug 保证仍不成立。

## 安装与权限

`dior-graphics` 软件包自己的 EGL/GLES、libdrm、DRI driver、启动器和验收脚本全部放在 `/opt/dior-graphics`，不覆盖系统 Mesa 文件。APK 的 SONAME provider 使用 `dior-graphics:` namespace，不占用系统 Mesa 的普通 provider 名称。APK 依赖系统已有的 musl、libgcc、libstdc++、zlib 和 Python 3；Python 2 仅用于构建时生成源码，不安装到手机。

取得并核对实际 ARMv7 APK 的 SHA256 后，以 root 安装本地构建；签名钥匙不在设备信任库时需 `--allow-untrusted`，例如：

```sh
sha256sum ./dior-graphics-17.3.9-r7.apk
apk add --allow-untrusted ./dior-graphics-17.3.9-r7.apk
```

运行验收使用普通 `dior` 用户。该用户应属于 `video` 组，实际 GPU/DRM 节点也应允许该组读写。先检查现有权限；安装此 APK 本身不会修改设备节点或用户组：

```sh
id
ls -l /dev/dri/card0 /dev/kgsl-3d0 /dev/ion
```

需要调整时使用针对这些节点的 udev 规则及用户组配置，完成后重新登录。权限允许访问节点，只证明可访问，不能证明渲染成功。此用户态包不生成或刷写 boot，不修改 firmware 或 NV。

## 仅对指定进程选择此运行库

`/opt/dior-graphics/bin/dior-gles-check` 在自己的进程中设置下面三个变量，并取消 `LIBGL_ALWAYS_SOFTWARE`。也可显式写出同样的单次调用：

```sh
LD_LIBRARY_PATH=/opt/dior-graphics/lib \
LIBGL_DRIVERS_PATH=/opt/dior-graphics/lib/dri \
MESA_LOADER_DRIVER_OVERRIDE=kgsl \
/opt/dior-graphics/bin/dior-gles-check \
  --route gbm --node /dev/dri/card0 \
  --repeat 50 --timeout 180 --output /tmp/dior-mesa-result.json
```

这不会修改全局 loader 配置，也不会让其他桌面、浏览器或 FlowBoard 进程自动切换驱动。系统默认 Mesa 的已测基线仍是 llvmpipe / CPU；本包候选只在上述显式环境中使用。`kgsl_dri.so` 存在或能加载，也不足以证明硬件路径可用。

探测在有 deadline 的独立子进程里执行，默认不更改屏幕 framebuffer。它先在离屏 FBO 验证红、蓝、白清屏及编译后的三角形 shader，再执行 256×256 双纹理 fragment 算术；每轮改变输入，逐像素比较独立 CPU 真值。`--timeout 180` 是该 route 整体的 180 秒 wall deadline，包含 50 轮验证和 Python CPU 真值生成、比较时间。当前真机仅测这两项 CPU fixture 工作，每轮约 988 毫秒和 706 毫秒，50 轮就超过 85 秒；这不是 GPU benchmark。超时属于未完成验收，不能当作完成 50 轮，也不能直接判定为 GPU fault。

## 判定完整验收结果

命令退出码必须为 0，且 JSON 同时满足以下条件：

- `status == "PASS_GPU"`，`validation_pass == true`。
- `hardware_render_pass == true`、`hardware_shader_arithmetic_pass == true`，识别为 Adreno/Freedreno，`software_renderer == false`；llvmpipe 等软件回退不能通过。
- `completed_iterations == requested_iterations == 50`，`stability_pass == true`；所有 `arithmetic_checks` 的 `pass` 为 true、`mismatched_pixels` 为 0。
- `cleanup_pass == true`，`cleanup_error` 为空；渲染成功但资源释放失败也不能通过。

同时保留完整 JSON、stderr，以及真机测试前后的 kernel taint 与 GPU fault 日志。KGSL `reset_count` 包含正常冷启动，不能把它直接当作仅统计故障的计数器。本次进程重开与并发已有上述实测记录；长时间持续负载、suspend/resume、完整 GLES API conformance、桌面/compositor/KMS 显示仍未验收。Vulkan 和 GLES 3.1 compute shader 未由本路径提供，整个驱动零 bug 不能保证。

此 APK 用 `--disable-opencl` 构建。fragment 算术通过仅证明 GLES shader 的已测运算，不代表 OpenCL 或 GLES 3.1 compute shader 可用。手机原有 Android/Bionic 驱动的[独立 native 路径](../graphics-android/README.md) 已真实验证 GLES 2 / 3 和 OpenCL 1.1 Embedded，提供显式 GPU rendering/computation 入口；该结果不能填作本 musl Mesa 路径的通过记录。应用还需明确接入相应运行库或独立 native worker；GPU 支持不会自动加速访客浏览器中的 Canvas 或公网网络。

## 2026-10-02 实际结果记录

| 项目 | 当前记录 |
| --- | --- |
| Mesa r7 完整构建 / 物理验收状态 | 构建成功；已测离屏渲染、fragment 算术及 cleanup 通过 |
| 源码 / 完整构建 run | `f0bfeab0777e2ce316a6df9a3727e190991de1d4` / `37006893498` |
| APK | `dior-graphics-17.3.9-r7.apk` |
| APK SHA256 | `ff1f947edbc27715c137c9cb0a2d84b370f7ff87660df757d21d8c0893c6fb26` |
| 日期、内核、普通用户 | 2026-10-02；`3.4.0-msf #9-postmarketOS` / r8；UID 10000 |
| EGL / GL | Mesa EGL 1.4；vendor `freedreno`，renderer `FD001`，`OpenGL ES 2.0 Mesa 17.3.9` |
| 硬件标识 | device ID 1；内核 GPU enum 335、chip `0x03000512`，限定映射 Mesa family 305 |
| Route | 显式 private runtime 的 GBM `/dev/dri/card0`；普通用户实际打开并执行 |
| 稳定性 | 7 案例、80 算术轮；5,242,880 像素、mismatch 0、max channel error 0、cleanup 通过 |
| 混合运行 | Mesa + native OpenCL、Mesa + native GLES 3 均通过 |
| 内核状态 | 测试前后 taint 0；测试区间新增 GPU fault / protected-access / Oops 为 0 |
| Boot SHA256 | `c3bf34316c4a352859e0e6d7841bf2ff09165741534fb72e8a6d582ae322c5e7` |

`FD001` 是该版本由 device ID 1 形成的 renderer 名称；它不表示 GPU 型号为 1，也不取代真实 chip ID 与 family 的核对。

交付目录中的证据文件（路径相对于任务交付目录）：

- `outputs/R7-MESA-SMOKE.json`：完整单次 validation、EGL/GL 标识及 cleanup。
- `outputs/R7-MESA-STABILITY.json`：7 项案例、80 轮、UID、taint 和日志区间。
- `outputs/R7-MESA-NEW-KERNEL-LOG.txt`：稳定性测试中新增加的内核日志。
- `outputs/R7-MIXED-RUNTIME.json`：两种混合运行的逐轮结果与 fault 检查。
- `outputs/GPU-VALIDATION-RESULT.json`：汇总；区分本 musl Mesa 与独立 native GLES/OpenCL 的验收范围。
