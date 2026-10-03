/* SPDX-License-Identifier: MIT
 * Small GNU ARMhf process boundary for sherpa-onnx v1.10.29 C API.
 * No audio, keyword, or transcript is written to a file.
 */
#include "c-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define LINE_CAP 16384
#define KEYWORD_CAP 8192
#define FRAME_SAMPLES 320
#define STREAM_SAMPLES_LIMIT 480000U
#define MAX_RESULT_TOKENS 128
#define MAX_DECODE_CALLS 32
#define MAX_VOCAB_TOKENS 1024
#define TOKEN_CAP 64

/* Avoid a linux-libc-dev dependency for this one Linux process-control call. */
extern int prctl(int option, ...);
/* Executable DSO anchor normally supplied by GCC crtbegin.o. Pure C has no
 * static constructors; GNU crt1/crti/crtn and libc_nonshared supply startup. */
void *__dso_handle __attribute__((visibility("hidden"))) = 0;

typedef struct Request {
  char op[32];
  char keywords[KEYWORD_CAP + 1];
  char pcm[FRAME_SAMPLES * 4 + 1];
  long id;
  unsigned fields;
} Request;

static SherpaOnnxKeywordSpotter *spotter;
static SherpaOnnxOnlineStream *stream;
static char current_keywords[KEYWORD_CAP + 1];
static unsigned stream_samples;
static unsigned long long samples_total;
static unsigned long long stream_offset_samples;
static unsigned stream_generation;
static char vocabulary[MAX_VOCAB_TOKENS][TOKEN_CAP];
static unsigned vocabulary_size;
/* v1.10.29 appends model defaults to every custom stream. Keep that base
 * graph permanently unreachable, so set_keywords fully replaces real names.
 * Blank is never emitted into a context phrase; threshold 2 exceeds any
 * acoustic probability as an additional guard. */
static const char disabled_seed[] = "<blk> :0 #2 @__kws_disabled__";

static double now_seconds(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts)) return 0;
  return (double)ts.tv_sec + (double)ts.tv_nsec / 1000000000.0;
}

static void cleanup(void) {
  if (stream) SherpaOnnxDestroyOnlineStream(stream);
  if (spotter) SherpaOnnxDestroyKeywordSpotter(spotter);
  stream = NULL;
  spotter = NULL;
}

static int hex_value(unsigned char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static void skip_ws(const char **p) {
  while (**p == ' ' || **p == '\t' || **p == '\r' || **p == '\n') ++*p;
}

static int read_u4(const char **p, unsigned *value) {
  unsigned x = 0;
  int i;
  for (i = 0; i < 4; ++i) {
    int n = hex_value((unsigned char)**p);
    if (n < 0) return 0;
    ++*p;
    x = (x << 4) | (unsigned)n;
  }
  *value = x;
  return 1;
}

static int put_utf8(char *out, unsigned cap, unsigned *used, unsigned code) {
  unsigned char bytes[4];
  unsigned n;
  if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  if (code < 0x80) { bytes[0] = code; n = 1; }
  else if (code < 0x800) { bytes[0] = 0xc0 | (code >> 6); bytes[1] = 0x80 | (code & 63); n = 2; }
  else if (code < 0x10000) { bytes[0] = 0xe0 | (code >> 12); bytes[1] = 0x80 | ((code >> 6) & 63); bytes[2] = 0x80 | (code & 63); n = 3; }
  else { bytes[0] = 0xf0 | (code >> 18); bytes[1] = 0x80 | ((code >> 12) & 63); bytes[2] = 0x80 | ((code >> 6) & 63); bytes[3] = 0x80 | (code & 63); n = 4; }
  if (*used + n >= cap) return 0;
  memcpy(out + *used, bytes, n);
  *used += n;
  return 1;
}

static int json_string(const char **p, char *out, unsigned cap) {
  unsigned used = 0;
  if (**p != '"') return 0;
  ++*p;
  while (**p && **p != '"') {
    unsigned char c = (unsigned char)*(*p)++;
    if (c < 32) return 0;
    if (c == '\\') {
      unsigned code;
      c = (unsigned char)*(*p)++;
      switch (c) {
        case '"': case '\\': case '/': break;
        case 'b': c = '\b'; break;
        case 'f': c = '\f'; break;
        case 'n': c = '\n'; break;
        case 'r': c = '\r'; break;
        case 't': c = '\t'; break;
        case 'u':
          if (!read_u4(p, &code)) return 0;
          if (code >= 0xd800 && code <= 0xdbff) {
            unsigned low;
            if ((*p)[0] != '\\' || (*p)[1] != 'u') return 0;
            *p += 2;
            if (!read_u4(p, &low) || low < 0xdc00 || low > 0xdfff) return 0;
            code = 0x10000 + ((code - 0xd800) << 10) + low - 0xdc00;
          }
          if (!put_utf8(out, cap, &used, code)) return 0;
          continue;
        default: return 0;
      }
    }
    if (!c || used + 1 >= cap) return 0;
    out[used++] = (char)c;
  }
  if (**p != '"') return 0;
  ++*p;
  out[used] = 0;
  return 1;
}

static int parse_request(const char *p, Request *r) {
  unsigned count = 0;
  memset(r, 0, sizeof(*r));
  skip_ws(&p);
  if (*p++ != '{') return 0;
  skip_ws(&p);
  if (*p == '}') return 0;
  for (;;) {
    char key[32];
    unsigned field;
    char *dst;
    unsigned cap;
    if (++count > 4 || !json_string(&p, key, sizeof(key))) return 0;
    skip_ws(&p);
    if (*p++ != ':') return 0;
    skip_ws(&p);
    if (!strcmp(key, "id")) {
      unsigned long value = 0;
      field = 8;
      if (r->fields & field || *p < '0' || *p > '9') return 0;
      if (*p == '0' && p[1] >= '0' && p[1] <= '9') return 0;
      do {
        unsigned digit = (unsigned)(*p++ - '0');
        if (value > 214748364UL || (value == 214748364UL && digit > 7)) return 0;
        value = value * 10 + digit;
      } while (*p >= '0' && *p <= '9');
      r->id = (long)value;
    } else {
      if (!strcmp(key, "op")) { field = 1; dst = r->op; cap = sizeof(r->op); }
      else if (!strcmp(key, "keywords_string") || !strcmp(key, "keywords")) { field = 2; dst = r->keywords; cap = sizeof(r->keywords); }
      else if (!strcmp(key, "pcm16_hex") || !strcmp(key, "pcm_hex")) { field = 4; dst = r->pcm; cap = sizeof(r->pcm); }
      else return 0;
      if (r->fields & field || !json_string(&p, dst, cap)) return 0;
    }
    r->fields |= field;
    skip_ws(&p);
    if (*p == '}') { ++p; break; }
    if (*p++ != ',') return 0;
    skip_ws(&p);
  }
  skip_ws(&p);
  return !*p && (r->fields & 1);
}

static void print_string(const char *value) {
  const unsigned char *p = (const unsigned char *)(value ? value : "");
  unsigned used = 0;
  putchar('"');
  while (*p && used++ < KEYWORD_CAP) {
    unsigned char c = *p++;
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 32) printf("\\u%04x", (unsigned)c);
    else putchar(c);
  }
  putchar('"');
}

static void error_reply(long id, const char *op, const char *error) {
  printf("{\"ok\":false,\"id\":%ld,\"op\":", id);
  print_string(op);
  printf(",\"error\":");
  print_string(error);
  puts("}");
}

static int valid_utf8(const unsigned char *p) {
  while (*p) {
    unsigned c = *p++, code, count, minimum;
    if (c < 0x80) continue;
    if (c >= 0xc2 && c <= 0xdf) { code = c & 31; count = 1; minimum = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { code = c & 15; count = 2; minimum = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { code = c & 7; count = 3; minimum = 0x10000; }
    else return 0;
    while (count--) {
      c = *p++;
      if (c < 0x80 || c > 0xbf) return 0;
      code = (code << 6) | (c & 63);
    }
    if (code < minimum || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return 0;
  }
  return 1;
}

static int load_vocabulary(const char *path) {
  FILE *file = fopen(path, "rb");
  char line[256];
  unsigned bytes = 0;
  if (!file) return 0;
  while (fgets(line, sizeof(line), file)) {
    unsigned len = 0;
    bytes += (unsigned)strlen(line);
    if (bytes > 1024*1024 || vocabulary_size >= MAX_VOCAB_TOKENS) { fclose(file); return 0; }
    while (line[len] && line[len] != ' ' && line[len] != '\t' && line[len] != '\r' && line[len] != '\n') ++len;
    if (!len || len >= TOKEN_CAP || !line[len]) { fclose(file); return 0; }
    memcpy(vocabulary[vocabulary_size], line, len);
    vocabulary[vocabulary_size++][len] = 0;
  }
  if (ferror(file)) { fclose(file); return 0; }
  fclose(file);
  return vocabulary_size > 3;
}

static int known_token(const char *word) {
  unsigned i;
  if (word[0] == '<' || word[0] == '#') return 0;
  for (i = 0; i < vocabulary_size; ++i)
    if (!strcmp(word, vocabulary[i])) return 1;
  return 0;
}

static int valid_number(const char *word, double minimum, double maximum) {
  const char *p = word;
  char *end;
  double number;
  unsigned digits = 0, dots = 0;
  while (*p) {
    if (*p >= '0' && *p <= '9') ++digits;
    else if (*p == '.' && !dots) ++dots;
    else return 0;
    ++p;
  }
  if (!digits) return 0;
  number = strtod(word, &end);
  return !*end && number == number && number >= minimum && number <= maximum;
}

static int valid_keywords(const char *text) {
  unsigned lines = 1;
  unsigned size = 0;
  const unsigned char *p = (const unsigned char *)text;
  unsigned tokens = 0, metadata = 0;
  if (!*text || !valid_utf8(p)) return 0;
  for (; *p; ++p) {
    if (++size > KEYWORD_CAP || *p == '\r' || (*p < 32 && *p != '\n' && *p != '\t')) return 0;
    if (*p == '\n' && ++lines > 32) return 0;
  }
  while (*text) {
    char word[257];
    unsigned n = 0;
    while (*text == ' ' || *text == '\t') ++text;
    if (!*text || *text == '\n') {
      if (!tokens || !(metadata & 4)) return 0;
      if (!*text) break;
      ++text; tokens = 0; metadata = 0;
      continue;
    }
    while (*text && *text != ' ' && *text != '\t' && *text != '\n') {
      if (n == sizeof(word)-1 || *text == '/') return 0;
      word[n++] = *text++;
    }
    word[n] = 0;
    if (word[0] == ':') {
      if (!tokens || (metadata & 5) || !valid_number(word+1, 0, 10)) return 0;
      metadata |= 1;
    } else if (word[0] == '#') {
      if (!tokens || (metadata & 6) || !valid_number(word+1, 0.001, 1)) return 0;
      metadata |= 2;
    } else if (word[0] == '@') {
      if (!tokens || (metadata & 4) || !word[1]) return 0;
      metadata |= 4;
    } else {
      if (metadata || ++tokens > 64 || !known_token(word)) return 0;
    }
  }
  return tokens && (metadata & 4);
}

static int replace_stream(const char *keywords) {
  SherpaOnnxOnlineStream *replacement = SherpaOnnxCreateKeywordStreamWithKeywords(spotter, keywords);
  if (!replacement) return 0;
  if (stream) SherpaOnnxDestroyOnlineStream(stream);
  stream = replacement;
  stream_samples = 0;
  stream_offset_samples = samples_total;
  ++stream_generation;
  return 1;
}

static void common_reply(long id, const char *op) {
  printf("{\"ok\":true,\"id\":%ld,\"op\":", id);
  print_string(op);
  printf(",\"stream_generation\":%u,\"samples_total\":%llu}\n", stream_generation, samples_total);
}

static int read_line(char *line) {
  unsigned used = 0;
  int overflow = 0, c;
  while ((c = getchar()) != EOF && c != '\n') {
    if (c == 0) overflow = 1;
    if (used < LINE_CAP) line[used++] = (char)c;
    else overflow = 1;
  }
  if (c == EOF && !used && !overflow) return 0;
  line[used] = 0;
  return overflow ? -1 : 1;
}

static int feed(const Request *r) {
  float samples[FRAME_SAMPLES];
  unsigned i, calls = 0;
  double begin, elapsed;
  const SherpaOnnxKeywordResult *result;
  if (strlen(r->pcm) != FRAME_SAMPLES * 4) {
    error_reply(r->id, r->op, "pcm_must_be_640_bytes"); return 1;
  }
  for (i = 0; i < FRAME_SAMPLES; ++i) {
    int h0 = hex_value(r->pcm[i*4]), h1 = hex_value(r->pcm[i*4+1]);
    int h2 = hex_value(r->pcm[i*4+2]), h3 = hex_value(r->pcm[i*4+3]);
    unsigned raw;
    int signed_sample;
    if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) {
      error_reply(r->id, r->op, "invalid_pcm_hex"); return 1;
    }
    raw = (unsigned)((h0 << 4) | h1 | (h2 << 12) | (h3 << 8));
    signed_sample = raw >= 32768 ? (int)raw - 65536 : (int)raw;
    samples[i] = (float)signed_sample / 32768.0f;
  }
  if (stream_samples >= STREAM_SAMPLES_LIMIT && !replace_stream(current_keywords)) {
    error_reply(r->id, r->op, "stream_budget_reset_failed"); return 0;
  }
  begin = now_seconds();
  SherpaOnnxOnlineStreamAcceptWaveform(stream, 16000, samples, FRAME_SAMPLES);
  stream_samples += FRAME_SAMPLES;
  samples_total += FRAME_SAMPLES;
  while (SherpaOnnxIsKeywordStreamReady(spotter, stream)) {
    if (++calls > MAX_DECODE_CALLS || now_seconds() - begin > 10.0) {
      error_reply(r->id, r->op, "decode_budget_exceeded"); return 0;
    }
    SherpaOnnxDecodeKeywordStream(spotter, stream);
  }
  elapsed = (now_seconds() - begin) * 1000.0;
  result = SherpaOnnxGetKeywordResult(spotter, stream);
  if (!result || result->count < 0 || result->count > MAX_RESULT_TOKENS) {
    if (result) SherpaOnnxDestroyKeywordResult(result);
    error_reply(r->id, r->op, "invalid_result"); return 0;
  }
  printf("{\"ok\":true,\"id\":%ld,\"op\":\"feed\",\"keyword\":", r->id);
  print_string(result->keyword);
  printf(",\"timestamps\":[");
  for (i = 0; result->timestamps && i < (unsigned)result->count; ++i)
    printf("%s%.6f", i ? "," : "", (double)result->timestamps[i]);
  printf("],\"start_time\":%.6f,\"stream_offset_seconds\":%.6f,\"stream_generation\":%u,\"samples_total\":%llu,\"decode_calls\":%u,\"decode_ms\":%.3f}\n",
         (double)result->start_time, (double)stream_offset_samples / 16000.0,
         stream_generation, samples_total, calls, elapsed);
  /* This version has no dedicated C KWS reset; recreate only the stream. */
  i = result->keyword && result->keyword[0];
  SherpaOnnxDestroyKeywordResult(result);
  if (i && !replace_stream(current_keywords)) return 0;
  return 1;
}

int main(int argc, char **argv) {
  SherpaOnnxKeywordSpotterConfig config;
  const char *encoder = NULL, *decoder = NULL, *joiner = NULL, *tokens = NULL, *keywords = NULL;
  int threads = 2, i, status;
  double begin;
  char line[LINE_CAP + 1];
  Request request;
  memset(&config, 0, sizeof(config));
  for (i = 1; i < argc; ++i) {
    const char *arg = argv[i];
    if (!strcmp(arg, "--help")) {
      puts("kws-worker --encoder PATH --decoder PATH --joiner PATH --tokens PATH --keywords COMPILED_PPINYIN [--threads 2]");
      return 0;
    }
    if (i + 1 == argc) { fputs("missing option value\n", stderr); return 2; }
    ++i;
    if (!strcmp(arg, "--encoder")) encoder = argv[i];
    else if (!strcmp(arg, "--decoder")) decoder = argv[i];
    else if (!strcmp(arg, "--joiner")) joiner = argv[i];
    else if (!strcmp(arg, "--tokens")) tokens = argv[i];
    else if (!strcmp(arg, "--keywords")) keywords = argv[i];
    else if (!strcmp(arg, "--threads")) {
      if (!strcmp(argv[i], "1")) threads = 1;
      else if (!strcmp(argv[i], "2")) threads = 2;
      else { fputs("threads must be 1 or 2\n", stderr); return 2; }
    } else { fputs("unknown option\n", stderr); return 2; }
  }
  if (!encoder || !decoder || !joiner || !tokens || !keywords || !load_vocabulary(tokens) || !valid_keywords(keywords)) {
    fputs("required model paths and valid compiled keywords are missing\n", stderr); return 2;
  }
  setvbuf(stdout, NULL, _IOLBF, 0);
  atexit(cleanup);
  /* Tie this worker to its caller, including death during model loading. */
  { pid_t parent = getppid(); if (prctl(1, 15, 0, 0, 0) || getppid() != parent) return 3; }
  strcpy(current_keywords, keywords);
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = encoder;
  config.model_config.transducer.decoder = decoder;
  config.model_config.transducer.joiner = joiner;
  config.model_config.tokens = tokens;
  config.model_config.num_threads = threads;
  config.model_config.provider = "cpu";
  config.max_active_paths = 4;
  config.num_trailing_blanks = 1;
  config.keywords_score = 1.5f;
  config.keywords_threshold = 0.35f;
  config.keywords_buf = disabled_seed;
  config.keywords_buf_size = (int32_t)strlen(disabled_seed);
  begin = now_seconds();
  spotter = SherpaOnnxCreateKeywordSpotter(&config);
  if (!spotter || !replace_stream(current_keywords)) {
    error_reply(0, "ready", "model_or_stream_creation_failed"); return 4;
  }
  printf("{\"ok\":true,\"op\":\"ready\",\"protocol\":1,\"sample_rate\":16000,\"frame_samples\":320,\"threads\":%d,\"model_load_seconds\":%.6f,\"stream_limit_seconds\":30,\"stream_generation\":%u}\n",
         threads, now_seconds() - begin, stream_generation);
  while ((status = read_line(line)) != 0) {
    if (status < 0) { error_reply(0, "", "line_too_large_or_nul"); continue; }
    if (!parse_request(line, &request)) { error_reply(0, "", "invalid_request"); continue; }
    if (!strcmp(request.op, "feed") && (request.fields & 7) == 5) {
      if (!feed(&request)) return 5;
    } else if (!strcmp(request.op, "set_keywords") && (request.fields & 7) == 3) {
      if (!valid_keywords(request.keywords)) { error_reply(request.id, request.op, "invalid_keywords"); continue; }
      if (!replace_stream(request.keywords)) { error_reply(request.id, request.op, "stream_creation_failed"); continue; }
      strcpy(current_keywords, request.keywords);
      common_reply(request.id, request.op);
    } else if (!strcmp(request.op, "reset") && (request.fields & 7) == 1) {
      if (!replace_stream(current_keywords)) { error_reply(request.id, request.op, "stream_creation_failed"); return 6; }
      common_reply(request.id, request.op);
    } else if (!strcmp(request.op, "ping") && (request.fields & 7) == 1) {
      common_reply(request.id, request.op);
    } else if (!strcmp(request.op, "quit") && (request.fields & 7) == 1) {
      common_reply(request.id, request.op); return 0;
    } else error_reply(request.id, request.op, "unknown_op_or_fields");
  }
  return 0;
}
