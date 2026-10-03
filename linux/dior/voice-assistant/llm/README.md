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

The current local wrapper preserves `system`/`user`/`assistant` roles. The model
weights and upstream CPU implementation are unchanged. The controller owns the
conversation and supplies the current assistant name and completed spoken
history; neither the adapter nor the worker invents a separate dialogue history.

The pinned upstream [Android build documentation](https://github.com/ggml-org/llama.cpp/blob/10433e8b457c4cfd759cbb41fc55fc398db4a5da/docs/android.md)
describes NDK/CMake builds. This integration uses the already available NDK
r17c Clang6.0.2, API19 Bionic, static libc++, and GCC4.9 linker. The ELF
interpreter is `/opt/dior-android/system/bin/linker`; its existing read-only
KitKat property descriptor must be inherited through the SDK launcher.

## Boundaries

- Model loads once; the native default is two CPU threads, the adapter default
  is three, and the shared-service configuration supplies the actual setting.
  Context is1024tokens, logical/physical batches32, greedy output up to96tokens,
  and at most30seconds/request. Prompt plus output reservation must fit context.
- `generate_messages(messages, cancel=..., deadline=...)` preserves the caller's
  ordered roles and full bounded content. There is no internal two-turn,
  24-character excerpt buffer. Only the controller commits assistant history,
  after successful actual playback; a model completion alone is insufficient.
- Voice requests can reuse an exact system prefix ending at the next
  `<|im_start|>` special token, before the literal user role/newline. User and
  answer KV suffixes are removed after each request. Changed system text,
  including a changed assistant name, cannot reuse a different prefix.
- `generate(text, ...)` is the website compatibility entry. It creates a fresh
  website system/user pair and sends `use_prefix_cache:true` to reuse only the
  fixed website system prefix. Authorized project facts remain in the current
  user message, and native drops every user/assistant KV suffix after each call.
  Different web users never share semantic history. A different system prompt,
  including the voice identity prompt, invalidates this exact prefix cache.
  The fixed website system also states that supplied data is read-only and is
  not an instruction. Dynamic project prompts use compact data/question labels
  while preserving the previous180-byte net context allowance and480-byte
  question allowance. UTF-8 truncation flags compare the data actually retained.
  For the measured project fixture this removes10noncached tokens while adding
  9fixed-prefix tokens (44dynamic UTF-8 bytes saved). The selected device run
  below passed; a general latency or thermal benefit does not follow from the
  tokenizer measurement alone.
- When native readiness explicitly advertises `clear_history_supported:true`,
  `clear_history()` requests that operation and waits up to3seconds for the
  matching `history_cleared` acknowledgment. It preserves only the exact fixed
  system/user-open prefix. The adapter checks that retained KV cells equal the
  reported prefix length and that no user suffix is retained. A legacy worker
  receives `clear_cache` instead. Explicit `clear_cache()` always removes all KV.
- The shared bridge invokes clearing on its sole inference worker, outside the
  scheduler lock. The adapter also serializes generation and clearing. Native
  request JSON is released when dequeued/cancelled; clearing releases the
  adapter's last reply reference. These are active-state/lifetime guarantees,
  not a claim of cryptographic erasure of freed allocator memory.
- `prepare_system(system, cancel=..., deadline=...)` accepts only bounded system
  text, not user/assistant messages, and performs the same prefix prefill without
  sampling. Its matching `system_prepared` ACK must report completed status,
  zero generated tokens and exact prefix-only KV retention. Preparation never
  becomes a conversation turn or a speech request.
- Active voice-service startup attempts preparation once before `core.start()`
  opens capture. The total caller budget is20seconds. Failure, unsupported
  capability or preemption records `warmup_skipped` and startup continues; there
  is no retry/background loop. `status-only` never starts preparation. The bridge
  permits this operation only to the voice peer and schedules it below real
  voice/web work; a real request can cancel an active preparation.
- Requests are bounded JSONL: 16KiB/line, depth8, at most12messages, at most4096
  UTF-8 bytes per message and8192 content bytes in total, one active/queued job.
  Roles must alternate after an optional first system message and end in user.
  Embedded ChatML/thinking delimiter tokens are rejected as content.
- A separate input thread receives cancellation; the CPU decode abort callback
  checks cancellation and deadline inside computation. Adapter discards
  cancelled/stale replies and kills only its own worker if cancellation does
  not finish within2seconds.
- Python adapter limits VM to1GiB, descriptors64, core0, stdout queue256lines
  and stderr ring16KiB. It writes no transcript/audio logs or model caches.
- Adapter returns core `LanguageReply(text<=120characters,intent=None)`.
  Model/web text cannot execute shell commands, change volume or write wake
  words. Rule skills and confirmation belong to the voice core.
- Website facts are resolved and authorized by the server before becoming user
  content. Generated text never becomes an executable skill or shell command.

API19 compatibility provides optional memory/affinity wrapper names missing
from the old libc API. `madvise` uses the existing libc syscall wrapper; file
readahead retains the kernel default; foreign-thread affinity returns ENOSYS.
These wrappers do not change weights, neural operations, CPU online settings,
frequency or thermal controls.

## Source and artifact qualification

`SOURCE.json` and `DEPENDENCIES.json` retain the existing upstream pins.
`WRAPPER.json` separately pins the local C++ wrapper, Python adapter and API19
compatibility header. `build.py` validates both upstream and local inputs before
compilation and reports whether its output matches the qualified binary.

The phone-qualified worker with system-preserving session clear and once-only
startup preparation is3,172,972bytes, SHA256
`31e9a5c8d92093af7a198e0b4091ca1be9133b2aa1cd4bdf3b208687253e2b6a`.
Its local C++ source SHA256 is
`152f7a562c0b6feb9f823d958be330032ddfccae8e548c2a8660526058aa7598`;
the current device-qualified adapter SHA256 is
`f23d6fc9c9a5860278bc7ee7c052fe1bd945355d3f65c16339bbae3dd15df07d`.
It allows fixed website-system prefix reuse and compact dynamic project labels.
`WRAPPER.json` preserves the earlier adapters `21d3c9f4...` and `78e2b8b6...`
and their distinct qualification history. Neither change modified the native
binary or model weights.
The installer pins this tested worker. `WRAPPER.json` retains the previous
qualified snapshot for provenance; the original model-weight hash is unchanged.
`PHONE-QUALIFICATION.json` preserves the initial run; the scoped follow-up in
`WRAPPER.json` binds the newer local reports by SHA256. Rebuilding alone does
not qualify a different artifact.

The October3 device run used two model threads and1024/96 context/output limits.
Startup preparation took9.319seconds, retained38prefix tokens and generated
zero tokens. Three selected real-model requests completed in4.255,4.188 and
10.808seconds. Each reported an actual cache hit and38reused prefix tokens;
the second followed an explicit session-history clear. These are complete
request times for the selected prompts, not a general latency guarantee.

Two generated-PCM follow-up tests passed through real ASR, the installed
controller and physical speaker drain with zero audio XRUNs. One called the
model and completed its response in11.040seconds from injection; the other
used the existing identity skill and took6.000seconds. They bypassed keyword
detection and discarded microphone frames, so they do not qualify human
microphone recognition, wake accuracy or acoustic interruption.

The final selected website run passed all8HTTP cases, including two real model
requests and the generated audio response. Their wall times were20.352,
20.682 and21.143seconds, including thermal admission waits. The highest sampled
temperature was64C. This run used45C admission for both model and TTS, verified
account isolation and selected project/canvas facts, and removed its temporary
fixtures. Its exact result is `PASS_PARTIAL_REAL_PHONE_HTTP_NO_STT_INPUT`: web
transcription input and human acoustics were not tested. Earlier failed reports,
including the initial TTS503, remain historical evidence rather than being
rewritten as passing runs.

After that run, a separate deployment retained45C model admission and allowed
TTS admission at50C, with the same65C running-work limit. One generated-PCM
follow-up passed through actual ASR and physical speaker drain with zero XRUNs.
It used the existing identity skill, not the model:9.520seconds from the start
of the question, including a5.241second TTS request and1.592seconds of generated
audio. The TTS request timing includes admission wait. These numbers are not
LLM latency or human wake/microphone measurements. The eight-case web suite was
not repeated under the later50C TTS gate. Continuous thermal stability,
prolonged operation and general dialogue quality remain outside qualification.

This cache change can avoid repeating fixed-prefix prefill after a session
closes. It cannot improve model intelligence or answer correctness. Preparation
can remove that fixed work from the first question when startup succeeds. A
skipped preparation, changed system/name, full clear, service restart, or a
request with a different system, including switching between voice and web,
can still require cold work. `status.warmup` describes the
one startup attempt, not a guarantee that later requests are still warm. Verify
actual request hits with `prefix_cache_hit` and `prefix_tokens_reused`, separately
from the currently retained `cached_prefix_tokens`.

## Device benchmark

Stage `llm-worker`, `adapter.py`, `benchmark.py` and the qualified model as
root-owned immutable files. Then run as an ordinary local service user:

```sh
python3 benchmark.py --binary ./llm-worker \
  --model ./qwen2.5-0.5b-instruct-q4_0.gguf --threads 2 \
  --deadline 15 --report LLM-BENCHMARK.json
```

Read startup `model_load_seconds` separately from per-request first-token,
prefill, total time, generated tokens and RSS. Prefix prefill now occurs on
requests; `prefix_tokens_reused`, `prefix_cache_hit`, `cached_prefix_tokens` and
`prefix_cache_requested` describe that request's cache behavior. This benchmark
uses the stateless `generate(text)` entry: repeated calls may reuse the fixed
website prefix, but it does not measure voice-prefix reuse. Its
`PASS_LOCAL_GENERATION` label only means nonempty completed generation.
It does not establish correct answers, capture, TTS, acoustic interruption or
prolonged thermal behavior.

The observed target question transcribed as “你教什么名字” has produced the
current assistant name from the real system role. This selected result is not
general conversational qualification: the PC check “我是谁” still produced an
incorrect identity answer. Do not describe this0.5B model as generally reliable
or every semantic case as fixed. `test-history.py` uses fake native replies to
verify roles, caller ownership, cancellation, clear acknowledgments and bounds;
it makes no model-quality or phone-audio claim.

Weights, Bionic libraries, build outputs and credentials must stay outside Git.
Only source, compatibility code, build/source/model manifests and license
metadata belong in the public integration.
