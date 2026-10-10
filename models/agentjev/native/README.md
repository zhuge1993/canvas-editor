# ARMv7 native runtime

The phone uses the full quantized Qwen3 encoder and the original trained AgentJev candidate head. It does not contain speech models or token generation.

On a Python 3.12 desktop, prepare the pinned assets, then install ONNX export dependencies and export:

```sh
python -m pip install -r models/agentjev/requirements.txt
python -m pip install onnx==1.17.0 onnxruntime==1.20.1 onnxscript
python models/agentjev/prepare.py
python models/agentjev/export_onnx.py
python models/agentjev/native/prepare-runtime.py --root models/agentjev/runtime
```

`prepare-runtime.py` verifies locked official archive sizes/hashes and extracts only the necessary GNU and ONNX Runtime ELF libraries. The ONNX library is distributed in the pinned ARMv7 release archive; no Piper executable, speech data or voice weights are installed. GNU libraries remain private and do not replace system libraries. Libraries and exported weights are ignored by Git.

The checked Windows cross build uses LLVM 6 clang, Android NDK r17c GNU binutils/libgcc, and Ubuntu Focal ARMhf libc6-dev 2.31 headers/startup objects. The libc6-dev archive is `https://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6-dev_2.31-0ubuntu9.18_armhf.deb`, 1917948 bytes, SHA256 `fedd4b12c29a45094dacedf727101b6674c3f89ed07656eb5baffc072e0f411c`. Extract its data archive into the GNU development directory. This build script expects that existing cross toolchain; it does not install a toolchain automatically.

```sh
python models/agentjev/native/build.py --clang CLANG_EXE --binutils NDK_BIN_DIRECTORY --gnu-dev GNU_HEADERS_DIRECTORY --private-libs models/agentjev/runtime/runtime/lib --onnx-libs models/agentjev/runtime/runtime/lib --output models/agentjev/runtime/agentjev-worker
```

Copy Python files from models/agentjev to `/opt/agentjev/app`, tokenizer/config/temperatures files from runtime/assets to `/opt/agentjev/assets`, the three exported graphs to `/opt/agentjev/model`, the worker to `/opt/agentjev/agentjev-worker`, and private libraries to `/opt/agentjev/runtime/lib`. Keep these root-owned and readable by the service account. Verify transferred SHA256 hashes against an independently generated manifest before starting the service. Installation and current observed limits are documented in the parent README.

ONNX exports use dynamic token and candidate dimensions, explicit causal/padding masks and the last valid token. Constant transposed weights are folded before quantization to avoid duplicating the full model. INT8 numerical differences and the original model's semantic mistakes remain; the exported-load checks do not establish broad accuracy. The 506-text tokenizer comparison can be rerun with `python models/agentjev/tests/tokenizer-parity.py --assets models/agentjev/runtime/assets` in the desktop environment.
