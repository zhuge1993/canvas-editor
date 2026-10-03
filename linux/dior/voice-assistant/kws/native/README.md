# GNU ARMhf KWS worker

This directory builds a small process wrapper around the official prebuilt
sherpa-onnx v1.10.29 C API. It does not rebuild sherpa-onnx or ONNX Runtime.
The selected model is the Chinese WenetSpeech 3.3M KWS transducer, with int8
encoder/joiner and fp32 decoder. Python sends compiled ppinyin tokens over
stdin; it never loads GNU shared libraries into the musl Python process.

The verified build is ARMv7-A NEON, GNU EABI5 hard-float. Its GNU crt1.o
startup calls `__libc_start_main`; it does not use Bionic `__libc_init`.
The direct DT_NEEDED entries are `libsherpa-onnx-c-api.so` and `libc.so.6`.
The worker itself needs GLIBC 2.4 and GLIBC 2.17. The prebuilt library's own
transitive requirements are separate and must be verified with the runtime
manifest. Use the existing private GNU libc 2.31/GCC10 directory on the phone;
do not replace the phone's musl or Android libraries.

The frozen worker is 22,064 bytes, SHA256
`74cbb47f56ab1e46bd391388932e17614814203258735324689774ff5021ecf8`.
`BUILD-MANIFEST.json` and `ELF-PROOF.txt` contain the actual linker command,
architecture, symbols, dependency list, and source/header hashes.
`phone_verified` remains false here because this directory's build task did
not operate the phone. Host contract results use a fake Sherpa API and do not
measure actual KWS quality, real-time speed, or microphone behavior.

## Reproduce on Windows

Prerequisites already present in the workspace: NDK r17c Windows Clang 6 and
GCC4.9 binutils/libgcc, private Ubuntu Focal ARMhf runtime libraries, and the
official ARMhf sherpa shared libraries. `prepare-gnu.py` downloads only the
1.9 MB Ubuntu Focal `libc6-dev` package and the fixed C API header over HTTPS,
checks their pinned SHA256 values, and extracts only into the explicit external staging directory.
Nothing is installed into a system directory.

```powershell
python native/prepare-gnu.py --output EXTERNAL_GNU_STAGE
python native/build.py --clang CLANG_EXE --binutils NDK_BINUTILS --gnu-dev EXTERNAL_GNU_STAGE/gnu-dev --private-libs PRIVATE_GLIBC_LIB --sherpa-libs SHERPA_RUNTIME_LIB --output EXTERNAL_BUILD/kws-worker
python native/test-contract.py --tokens EXTERNAL_MODEL/tokens.txt --output EXTERNAL_TEST_OUTPUT
```

All build inputs have command-line path overrides; see `build.py --help`.
GNU crt1/crti/crtn and libc_nonshared supply startup. The pure C executable
supplies its standard executable `__dso_handle` anchor. It has no C++ static
constructors. GCC4.9 libgcc is linked only for the small arithmetic helpers
needed by the wrapper. No NDK Bionic crt object or C++ runtime is linked.

## Run with the private GNU loader

From the KWS staging directory on the phone, substitute the actual existing
private GNU library directory for `PRIVATE_GLIBC_LIB`:

```sh
PRIVATE_GLIBC_LIB=/path/to/existing/private-glibc/lib
LD_LIBRARY_PATH="runtime/lib:$PRIVATE_GLIBC_LIB" \
  "$PRIVATE_GLIBC_LIB/ld-linux-armhf.so.3" \
  --library-path "runtime/lib:$PRIVATE_GLIBC_LIB" \
  native/kws-worker \
  --encoder model-small/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
  --decoder model-small/decoder-epoch-12-avg-2-chunk-16-left-64.onnx \
  --joiner model-small/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx \
  --tokens model-small/tokens.txt \
  --keywords 'èr g ǒu :1.5 #0.35 @二狗' --threads 2
```

The default model loads once, uses the CPU provider and two threads, with
four active paths and one trailing blank. `--threads` accepts 1 or 2.
The parent must enforce its model-load and individual feed deadline and
terminate only its own worker on a deadline. The C API provides no
inference-abort callback; the in-process 10-second budget is checked between
decode calls. `PR_SET_PDEATHSIG` ties worker lifetime to the caller even during
model loading. Clean quit/EOF releases the stream and model.

## JSONL protocol 1

The worker emits one initial `ready` JSON record after loading and exactly one
response per request. Stdout contains protocol records; library diagnostics
go to stderr. Input lines are limited to 16,384 bytes before LF and are drained
when oversized. Embedded NUL, duplicate fields, extra fields, nested values,
noninteger IDs, invalid Unicode escapes, and negative IDs are rejected.
IDs are optional, default to 0, and must be between 0 and 2,147,483,647.

```json
{"op":"ping","id":1}
{"op":"set_keywords","keywords_string":"èr g ǒu :1.5 #0.35 @二狗","id":2}
{"op":"reset","id":3}
{"op":"quit","id":4}
```

`feed` takes `pcm16_hex`, exactly 1,280 hexadecimal characters representing
640 PCM16LE bytes: 320 mono samples at 16 kHz, a 20 ms frame. Samples are
normalized by 32768 into [-1, 1). No audio or keyword data is written to disk.
For migration only, `pcm_hex` and `keywords` are aliases for the canonical
fields; sending both aliases of the same field is a duplicate and rejected.

```json
{"op":"feed","pcm16_hex":"1280_hex_characters_here","id":5}
```

The placeholder above must be replaced by actual PCM bytes; it is not a valid
feed. A successful response is shaped as follows:

```json
{"ok":true,"id":5,"op":"feed","keyword":"二狗","timestamps":[0.48,0.56,0.64],"start_time":0.0,"stream_offset_seconds":0.0,"stream_generation":1,"samples_total":12800,"decode_calls":1,"decode_ms":12.3}
```

The example values illustrate the schema, not a measured detection.
No match produces an empty `keyword` and empty timestamps. Timestamps and
`start_time` are from sherpa's current stream; `stream_offset_seconds` records
where that stream starts in the total supplied audio. A feed result names its
original stream generation. After a hit the next frame uses a new generation.
All C result objects are destroyed after the response is written.

`set_keywords` accepts at most 8,192 UTF-8 bytes and 32 newline-separated
keyword lines, with at most 64 token symbols per line. The tokens must exist
in the loaded vocabulary; blank/special symbols and slash separators are
rejected. Each line must end with its nonempty `@original_keyword` label.
Optional scores must be finite decimal values in [0,10], thresholds in
[0.001,1]. The bundled Python converter emits canonical ppinyin form.
The worker validates these strings before calling the old C API because that
API can return an outer nonnull stream with a null implementation after an
invalid keyword parse.

`set_keywords` and `reset` recreate only the stream, retaining the loaded
model. The stream is also recreated after a hit and every 30 seconds of audio
to cap feature/state retention. That periodic reset can cut across a keyword
at the boundary, so long-running microphone accuracy must be tested with it.
Any one feed is limited to 32 ready decode calls. The caller must bound its
stdout/stderr queues, feed requests, resident memory, and wall-clock deadlines.

## Replacing rather than retaining old names

In fixed v1.10.29, `CreateKeywordStreamWithKeywords` appends the spotter's
default keywords to custom keywords. Initializing the model with the real
first name would keep that name active after `set_keywords`. The worker
therefore initializes only an unreachable seed
`<blk> :0 #2 @__kws_disabled__`; every real name belongs to the current stream.
The decoder only advances its context graph for nonblank tokens, and its
acoustic match probability cannot reach 2. The seed never matches speech.
The parent should also reject that internal label, and must verify on the
phone that the old name stops triggering after a rename.

Evidence is the official fixed-tag implementation:
[custom stream defaults](https://github.com/k2-fsa/sherpa-onnx/blob/v1.10.29/sherpa-onnx/csrc/keyword-spotter-transducer-impl.h),
[blank decoding and probability check](https://github.com/k2-fsa/sherpa-onnx/blob/v1.10.29/sherpa-onnx/csrc/transducer-keyword-decoder.cc),
[keyword parser](https://github.com/k2-fsa/sherpa-onnx/blob/v1.10.29/sherpa-onnx/csrc/utils.cc),
[context graph threshold storage](https://github.com/k2-fsa/sherpa-onnx/blob/v1.10.29/sherpa-onnx/csrc/context-graph.cc).
The [official model documentation](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html#sherpa-onnx-kws-zipformer-wenetspeech-3-3m-2024-01-01-chinese)
describes the selected Chinese model and ppinyin keyword construction.

## Licensing and publication

The new wrapper, build scripts, and contract harness use the accompanying MIT
license. The downloaded sherpa header/runtime retain their upstream Apache
2.0 license. GNU libc development objects/headers and libgcc keep their own
upstream licenses; consult the downloaded package copyright records and GCC
Runtime Library Exception before packaging those dependencies.
Do not commit `.deb`, `gnu-dev`, object/executable/test binaries, downloaded
models, private GNU libraries, runtime libraries, or absolute-path build
evidence. Publish parameterized source and pin manifests separately according
to the parent project's publication policy.
