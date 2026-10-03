# Dior local LLM worker

The worker is a CPU-only ARMv7/NEON build of upstream llama.cpp `b3927`, commit
`10433e8b457c4cfd759cbb41fc55fc398db4a5da`. It uses the official
[Qwen2.5-0.5B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF)
Q4_0 file, pinned at model revision `9217f5db79a29953eb74d5343926648285ec7e67`.
The file is 428,730,208 bytes, SHA256
`7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed`.

This is local language generation, not a cloud API. No kernel flashing, GPU
runtime replacement, microphone access or skill execution is part of this
worker. Small-model answer quality and Cortex-A7 latency require device tests;
compilation is not evidence of useful token speed or reliable answers.

The pinned upstream [Android build documentation](https://github.com/ggml-org/llama.cpp/blob/10433e8b457c4cfd759cbb41fc55fc398db4a5da/docs/android.md)
describes NDK/CMake builds. This integration uses the already available NDK
r17c Clang6.0.2, API19 Bionic, static libc++, and GCC4.9 linker. The ELF
interpreter is `/opt/dior-android/system/bin/linker`; its existing read-only
KitKat property descriptor must be inherited through the SDK launcher.

## Boundaries

- Model loads once; default two CPU threads, context512, logical/physical
  batches32, greedy output24tokens, maximum64tokens and30seconds/request.
- A fixed short system prefix is prefilled once at startup. Its time is
  explicitly reported. Between jobs only that fixed prefix remains cached;
  user and answer KV suffixes are removed. Python retains only the last two
  successful turns as in-memory excerpts, at most24characters per side. Older
  excerpts are dropped before exceeding the768-byte prompt limit; cancellation
  and failure are not recorded. clear_history() removes these excerpts without
  waiting for an active generation and prevents its later history save.
- Requests are bounded JSONL, 16KiB/line, depth8, one active/queued job.
- A separate input thread receives cancellation; the CPU decode abort callback
  checks cancellation and deadline inside computation. Adapter discards
  cancelled/stale replies and kills only its own worker if cancellation does
  not finish within2seconds.
- Python adapter limits VM to1GiB, descriptors64, core0, stdout queue128lines
  and stderr ring16KiB. It writes no transcript/audio logs or model caches.
- Adapter returns core `LanguageReply(text<=120characters,intent=None)`.
  Model/web text cannot execute shell commands, change volume or write wake
  words. Rule skills and confirmation belong to the voice core.
- Network evidence is quoted as untrusted data. Even if the model gives a bad
  answer, the adapter does not turn that answer into an executable intent.

API19 compatibility provides optional memory/affinity wrapper names missing
from the old libc API. `madvise` uses the existing libc syscall wrapper; file
readahead retains the kernel default; foreign-thread affinity returns ENOSYS.
These wrappers do not change weights, neural operations, CPU online settings,
frequency or thermal controls.

## Device benchmark

Stage `llm-worker`, `adapter.py`, `benchmark.py` and the qualified model as
root-owned immutable files. Then run as an ordinary local service user:

```sh
python3 benchmark.py --binary ./llm-worker \
  --model ./qwen2.5-0.5b-instruct-q4_0.gguf --threads 2 \
  --deadline 15 --report LLM-BENCHMARK.json
```

Read `native_ready` load/prefix time and per-request
first-token, prefill, total time, generated tokens and RSS independently.
Native model_load_seconds already includes prefix_prefill_seconds;
model_load_without_prefix_seconds is provided for separate accounting.
The cached prompt asks for one Chinese sentence of at most25characters and
forbids claims that hardware operations were performed; this is a model
instruction, not a measured quality guarantee.
Do not count model download time as native decode time or cached prefix work
as zero cold-start work. This scratch benchmark does not test voice capture,
TTS, barge-in acoustics or prolonged thermal behavior.

Weights, Bionic libraries, build outputs and credentials must stay outside Git.
Only source, compatibility code, build/source/model manifests and license
metadata belong in the public integration.
