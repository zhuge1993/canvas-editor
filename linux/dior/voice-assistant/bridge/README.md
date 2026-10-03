# Private inference bridge

Local AF_UNIX service at `/run/dior-inference/inference.sock` shares
one existing qualified Qwen/native provider between voice and website. No model
copy, audio device access, public TCP, recordings or transcript logs are added.
Voice directly streams to the existing ASR service; website STT reuses it through
the bridge. Piper uses existing readonly assets and its bounded fixed cache.

## Contract

One connection has one JSONL request, with `v:1`, ASCII `id`1..64 bytes,
`deadline_ms`1000..30000 and `op`. Request frame max1MiB, JSON depth8. Final
response has `v/id/ok`, or `error_code`, max1280KiB. Socket close cancels the job;
an optional second `{v:1,id:<same>,op:'cancel'}` also cancels. No arbitrary path,
shell, model config or administrative API is accepted.

| op | fields | result |
| --- | --- | --- |
| status | none | ready, initialized capabilities, activity/queue, actual native PID/load_count |
| chat | text≤1000chars/3000UTF8B, context≤1536UTF8B | text, truncation flags, actual model_prompt_bytes |
| chat | voice only: messages≤12, content≤8192UTF8B, strict system/user/assistant order, chat frame≤16384B | structured reply; no bridge-side history commit |
| transcribe | pcm16_base64, decoded PCM16LEmono16k≤640000B/20s | text, audio_seconds, uploaded-file scope; no microphone/endpoint claim |
| tts | text≤120chars/480UTF8B | WAV base64, rate16000, fixedcache/inference flag |
| clear_history | voice only | clears semantic epoch; sole native worker removes user/assistant KV and retains only its exact system prefix |
| prepare_system | voice only: system≤4096UTF8B, deadline≤20s | startup preparation, initialized/prefix_tokens, strictly zero generated tokens |
| begin_voice_asr | voice only, lease_id, ttl_ms≤20000 | cancels web work and closes its ASR lease before local streaming |
| end_voice_asr | voice only, same lease_id | releases priority window |

Website backend owns real user authentication and project/AI read scopes. The
bridge authenticates Linux peer UID **and primary GID**, resolved via pwd for
`dior-voice` and `flowboard`; root is status-only. Shared socket group membership
is additionally enforced by OS DAC. It does not trust a request `role/user_id`.
Web calls are stateless: each sends only the fixed website system and current
user/context data. They may reuse the fixed system's mathematical prefix; all
user/assistant KV suffixes are removed after the call. Website and voice system
prefixes differ and cannot hit each other's cache. Structured voice messages come from the controller's
bounded conversation owner and include only confirmed playback history. They
never use the legacy two-turn, 24-character summary. Explicit-message adapters
retain only bounded mathematical checkpoints; semantic clear is scheduled by
the sole worker, outside the condition lock, before subsequent jobs. Native
stdout is never consumed by a control-handler thread.

The current Qwen2.5 wrapper supports structured role messages with a1024-token
context and unchanged model weights. Older providers may explicitly report
`legacy_current_turn`; only an explicit unsupported capability permits that
fallback, while model failures and timeouts do not. The text/web compatibility
prompt remains capped at768UTF8B with truncation flags; entire-project
understanding is not claimed. Qwen3.5 qualification results and its unselected
status are in `../llm-qwen35-candidate/README.md`.

The voice runtime attempts `prepare_system` once before microphone capture,
using its actual Conversation system message. It is lower priority than real
voice or web work, cannot preempt them, and shares the one inference worker.
Failure or the20second bound is recorded as warmup_skipped and allows ordinary
startup. No background retry, dummy user turn, generated text, playback or
semantic-history commit is performed. The status describes that startup
attempt; a later stateless web call can legitimately replace the cached prefix.

Model failure feedback can use one extra fixed Piper phrase, verified in the
local readonly cache, without waiting for IPC or creating a TTS worker. The
allowlist has eleven phrases and remains capped at 1MiB. Failure speech is
attempted once, omitted after cancellation/overtemperature, and never committed
as a successful model answer.

Eight connections, four active/queued jobs, one provider worker. Voice may
preempt web work; busy/preempted/deadline/cancelled are real responses. A voice
ASR presence hook runs in the background recognition thread before opening its
existing streaming ASR socket and in finally after close, not in capture callback.
It does not collect voice audio into an offline20second request.

Temperatures are sampled outside capture. Dynamic chat/prepare wait in the existing
single scheduler thread until the sensor is at or below `thermal_admit_c`
(legacy fallback52C, root config integer45..52; the supplied Dior profile is45C).
Dynamic TTS uses `tts_thermal_admit_c` (same45..52 integer range, omitted means
inherit global; supplied Dior profile50C). `active_thermal_admit_c` reports the
active dynamic job's gate, or null for idle/fixed cache. This cooling wait uses the original
request deadline and remains cancellable/preemptible; it does not create another
inference thread. Status exposes `cooling`, `thermal_waiting`, `active_state`, the
actual `thermal_c` and initialized `native_threads`. The waiting job counts in
the four-job bound. In-flight inference above65C is still cancelled; unavailable
thermal sensing rejects inference. STT retains its existing65C guard. Verified
fixed-cache ACK bypasses cooling without CPU inference. Root config
`llm_threads` is an integer1..4, default3; the actual configured count appears in
status. The supplied Dior profile uses two threads. This iteration changes the native wrapper,
while retaining the exact model weights and upstream CPU math.
Cache hit is not model inference. No governor/kernel change.

Dynamic Piper synthesis uses the lazy persistent factory described in
`../tts/PERSISTENT.md`. The same voice is reused across requests; fixed prompts
do not start it. One unlinked tmpfs inode has a hard audio limit and is truncated
after each call. Private `tts_state` contains numeric/enum health only. Whole-WAV
return is bounded local synthesis, not streaming first-phoneme playback. The
shared factory selects at most two inherited CPUs and verifies every Piper
thread after ORT initialization, before requests and before returning audio.
The pool can still have four threads; the limit is CPUs, not thread count.

## Deployment candidate

Code/config root-owned immutable, config0640. Dedicated `dior-inference` account,
primary shared group and supplementary ASR group only; no audio/wheel/video.
`dior-voice` and `flowboard` join only this shared group. Directory0750 and socket0660.
OpenRC candidate only needs localmount/ASR and writes no permanent log.

Deployment order: stop voice with `--nodeps` to remove its old direct native Qwen;
install/start inference and verify one resident worker; configure voice with
`--inference-socket /run/dior-inference/inference.sock --inference-client-module
/opt/dior-inference/bridge/client.py`; restart voice with `--nodeps`. These flags bypass
direct local Qwen and Piper provider construction. Audio/KWS remain in place.
Root deployment validates UID/socket/privacy, native count1, ASR priority and
unchanged unrelated website/tunnel state. Host contracts themselves do not deploy a phone.

The root's device evidence now records actual deployment with service UID108,
socket GID111, one native worker and website UID101 real HTTP/Unix calls.
Generated PCM recognition, real model greeting/project advice and real Piper
WAV returned successfully. This does not prove human microphone accuracy,
speaker hearing, distant wake/double-talk or a 24-hour soak.

Bridge code is installed at `/opt/dior-inference/bridge`, config at
`/etc/dior-inference.json`. Exact foreground argv:

```sh
/usr/bin/python3 -B /opt/dior-inference/bridge/server.py --config /etc/dior-inference.json
```

During bridge absence/restart, direct voice ASR is allowed only when the bridge
socket returns ENOENT/ECONNREFUSED (no website lease owner exists). Busy, permission
or other failures never bypass priority. Voice TTS may read only the already
qualified readonly fixed10phrase cache; dynamic speech is unavailable and no
second Piper/model is loaded. Main voice status polls initialized bridge status
outside capture and reports `model_ready=false` while it is absent or warming.
Root/group socket policy authenticates each process's pwd primary GID, not the
supplementary socket group. GID DAC separately restricts connect access.

```sh
python3 -B test_contracts.py
```

Host contracts use actual socket framing with fake model/ASR/TTS providers. They
verify routing/bounds/auth decisions/priority/history/cancellation, not Linux
SO_PEERCRED/DAC, model semantics or device CPU/memory. Device gates are separate.
