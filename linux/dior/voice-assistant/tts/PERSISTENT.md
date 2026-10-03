# Local lazy persistent Piper

The shared inference service selects
`offline_tts.create_persistent(base,engine='piper',max_cpus=2)` by default.
The direct-runtime Piper branch also uses the lazy factory but does not set
this optional affinity limit; the factory's API default remains `None`.
The original
`OfflineTTS` class and CLI remain one-shot for compatibility; espeak is unchanged.
Constructing the wrapper, checking status or returning fixed-cache audio does
not spawn/prewarm a model. There is no cloud inference or new voice/model/library.

The factory loads only its exact root-owned immutable sibling
`persistent_tts.py`. Runtime provider loading checks the same ownership and
permissions on Linux. The wrapper forwards `_fixed_cache` and `fixed_cache_error`,
so bridge thermal/cache checks preserve the qualified11 fixed phrases. Their
currently deployed PCM assets total742144bytes, within the1MiB bound. Each
dynamic request uses one serial unmodified Piper process, reusing model and
phonemizer initialization. On cancel/error it kills/reaps only that process
group and lazily starts a new process on the next dynamic request.

Audio uses one inherited unbuffered `TemporaryFile` inode on verified tmpfs,
already unlinked, addressed internally as `/proc/self/fd/N`. Linux3.4 does not
need memfd/O_TMPFILE. No fallback to disk is allowed. The inode is truncated
before/after each request; raw microphone audio is never used or saved. WAV,
PCM, text, stdout/stderr buffers, request count and child resource limits are
bounded. Parent-death, core, VM and FD protection are retained; FSIZE adds an
audio-file byte cap.

## Shared-service CPU boundary

`max_cpus=2` selects at most two CPUs from the parent's inherited allowed set
without changing the parent. The child receives that mask before exec. Real
ONNX Runtime1.14.1 workers then expanded their masks during initialization,
so preexec alone failed qualification: the old probe reached65°C and its
warm request consumed9.21CPU seconds in2.573wall seconds (3.58average cores).
That failed result is retained in
[LOCAL-OPT-AFFINITY-PREEXEC.json](../evidence/LOCAL-OPT-AFFINITY-PREEXEC.json).

After Piper's initialized ACK, before sending any synthesis JSON, the wrapper
sets and verifies every task of its own live Piper child. Each request repeats
this barrier, and completed WAV is verified again before being returned.
Enumeration is limited to64tasks,3rounds and0.5seconds within the original
cancel/deadline. It requires a stable verified task set; failure kills/reaps
only that child and returns no audio. Child teardown is serialized with this
enumeration. Parent, LLM, ASR and global kernel/CPU policies are not changed.
This limits allowed CPUs, not the number of ORT worker threads: the qualified
device probe still had4threads, all confined to CPUs0–1 during synthesis.
Initialization-time masks are recorded separately and may be wider.

The new probe records CPU online masks and parent allowed-mask observations
without attributing hotplug-sensitive changes to a parent-affinity modification.
Status distinguishes preexec setup from post-initialization thread verification.
The fixed11phrase cache bypasses model work and these inference barriers.

Fixed upstream Piper38917ffd loads its voice once before its JSON stdin loop.
Its file-path ACK is printed before `ofstream` destruction, so the wrapper waits
for complete bounded RIFF bytes. The exact JSON/output-file source protocol is
documented in [Piper main.cpp](https://github.com/rhasspy/piper/blob/38917ffd8c0e219c6581d73e07b30ef1d572fce1/src/cpp/main.cpp).

## Current two-CPU candidate evidence

[LOCAL-OPT-AFFINITY-ENFORCED.json](../evidence/LOCAL-OPT-AFFINITY-ENFORCED.json)
is the exclusive device probe of the unchanged Piper voice/model/libraries,
with the post-initialization enforcement candidate. It used generated text,
without playback, microphone input or saved PCM. Both requests reused one PID:

| Case | Full wall | Returned PCM duration | CPU seconds/wall | Temperature after |
| --- | ---: | ---: | ---: | ---: |
| Cold “我叫二狗。” | 4.6322s | 1.272s | 1.6385 | 54°C |
| Warm “网页语音服务已经连接。” | 5.8287s | 2.888s | 1.9455 | 57°C |

The probe started at47°C and peaked at57°C. All140synthesis samples and their
560task-mask observations were0–1, with no violation. It records initialization
separately: masks1/2/3 observed then do not count as synthesis qualification.
Cold voice-load report was1.7442s and initialization observation1.8461s.
Returned RSS was42248→43060KiB; the sampled peak during initialization was75340KiB.

The persistent base combination has been installed and automatically tested on
the phone. The shared provider now selects this two-CPU source profile. Final
shared-service web and ASR-to-physical-playback validation is performed and
recorded separately by the main task; this exclusive candidate probe does not
replace it. Two sentences are not long-soak or human microphone/hearing evidence.
The lower observed temperature comes with longer synthesis time; old unrestricted
warm timings are not promises for this profile or arbitrary text.

## Historical unrestricted prototype

The parent-owned exclusive device probe is
`outputs/TTS-PERSISTENT-PHONE-PROTOTYPE.json`. It used generated text only,
without speaker playback or microphone input. The same process produced:

| Case | Full wall | PCM duration |
| --- | ---: | ---: |
| Cold short phrase | 2.9162s | 1.272s |
| Warm longer phrase | 2.1702s | 2.376s |
| Warm short phrase | 1.0049s | 1.208s |

Voice-load log was1.7052s; initialized wall observation was1.8083s. RSS rose
41788→44180KiB with4 child FDs. Five seconds idle had unchanged CPU ticks1862.
Cancel/reap and new-PID recovery passed in that prototype test. These timings
precede the qualified two-CPU enforcement and must not be reported as its
performance. The three utterances are not a long-soak, human hearing or
guaranteed-response benchmark.

Piper's `SynthesisResult` is reused across input lines: its reported inference
and generated-audio values are **cumulative**. Old prototype evidence used the
ambiguous field `onnx_infer_seconds_reported`; values1.075411422,
3.223550020 and4.215838930 are cumulative. Production reports
`onnx_infer_cumulative_seconds_reported` and computes
`onnx_infer_seconds_delta` only from adjacent counters in the same process.
Those observed deltas are2.148138598 and0.992288910s. Missing counters, gaps or
negative changes return null; no value is borrowed or guessed.

`onnx_audio_seconds_delta` is the model-generated portion; actual returned PCM
duration may include configured sentence silence. Overall synthesis wall,
initialization observation, voice-load report, cumulative statistics and derived
per-request deltas are distinct. Whole-WAV mode is not first-phoneme streaming
and does not guarantee a sub-second reply. Bounded private `tts_state` status
exposes only numeric/enum health, never user text, audio, paths or stderr.

## Host validation

`test-persistent-tts.py` uses fake sessions and real WAV/facade validation, without
starting Piper or ONNX. It covers lazy idle, cache forwarding, serial reuse,
cancel/restart, late-deadline discard, no disk fallback, full-WAV flush handling,
malformed size/format, cumulative deltas and close. The19contracts also cover
inherited CPU selection, no parent affinity change, post-ORT worker remapping,
per-request rechecks, cancellation/deadline/task-churn failures, and no synthesis
JSON before a successful barrier. These host fakes do not replace device masks.
Existing fixed-cache and
bridge contracts remain applicable. No background model test or prewarm is run
by the integration.
