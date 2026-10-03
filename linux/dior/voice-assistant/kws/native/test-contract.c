/* Tests the real worker boundary with a fake C API, not KWS recognition. */
#include <time.h>
#include <assert.h>
#include <stdio.h>
#define CLOCK_MONOTONIC 1
#define __attribute__(x)
int clock_gettime(int kind, struct timespec *ts);
int mock_setvbuf(FILE *file, char *buffer, int mode, size_t size);
#define setvbuf mock_setvbuf
#define main real_worker_main
#include "kws-worker.c"
#undef main

struct SherpaOnnxKeywordSpotter { int stub; };
struct SherpaOnnxOnlineStream { char keywords[KEYWORD_CAP + 1]; };
static unsigned model_creates, model_destroys, stream_creates, stream_destroys;
static unsigned result_creates, result_destroys;
static float received[FRAME_SAMPLES];
static int trigger_result;

int clock_gettime(int kind, struct timespec *ts) {
  (void)kind; ts->tv_sec = 10; ts->tv_nsec = 0; return 0;
}
int mock_setvbuf(FILE *file, char *buffer, int mode, size_t size) {
  (void)file; (void)buffer; (void)mode; (void)size; return 0;
}
pid_t getppid(void) { return 123; }
int prctl(int option, ...) { assert(option == 1); return 0; }
SherpaOnnxKeywordSpotter *SherpaOnnxCreateKeywordSpotter(const SherpaOnnxKeywordSpotterConfig *c) {
  assert(!strcmp(c->keywords_buf, disabled_seed));
  assert(c->keywords_buf_size == (int)strlen(disabled_seed));
  assert(c->model_config.num_threads == 2);
  ++model_creates;
  return calloc(1, sizeof(SherpaOnnxKeywordSpotter));
}
void SherpaOnnxDestroyKeywordSpotter(SherpaOnnxKeywordSpotter *p) { ++model_destroys; free(p); }
SherpaOnnxOnlineStream *SherpaOnnxCreateKeywordStreamWithKeywords(const SherpaOnnxKeywordSpotter *p, const char *keywords) {
  SherpaOnnxOnlineStream *s;
  assert(p); assert(strlen(keywords) <= KEYWORD_CAP);
  s = calloc(1, sizeof(*s)); assert(s); strcpy(s->keywords, keywords);
  ++stream_creates; return s;
}
void SherpaOnnxDestroyOnlineStream(const SherpaOnnxOnlineStream *s) { ++stream_destroys; free((void *)s); }
void SherpaOnnxOnlineStreamAcceptWaveform(const SherpaOnnxOnlineStream *s, int32_t rate, const float *samples, int32_t n) {
  assert(s); assert(rate == 16000); assert(n == FRAME_SAMPLES);
  memcpy(received, samples, sizeof(received));
}
int32_t SherpaOnnxIsKeywordStreamReady(SherpaOnnxKeywordSpotter *p, SherpaOnnxOnlineStream *s) { assert(p && s); return 0; }
void SherpaOnnxDecodeKeywordStream(SherpaOnnxKeywordSpotter *p, SherpaOnnxOnlineStream *s) { assert(p && s); }
const SherpaOnnxKeywordResult *SherpaOnnxGetKeywordResult(SherpaOnnxKeywordSpotter *p, SherpaOnnxOnlineStream *s) {
  SherpaOnnxKeywordResult *r = calloc(1, sizeof(*r));
  assert(p && s && r); ++result_creates;
  r->keyword = trigger_result ? "mock-match" : ""; trigger_result = 0;
  return r;
}
void SherpaOnnxDestroyKeywordResult(const SherpaOnnxKeywordResult *r) { ++result_destroys; free((void *)r); }

int main(int argc, char **argv) {
  Request r;
  unsigned i, old;
  if (argc > 1 && !strcmp(argv[1], "--worker")) return real_worker_main(argc-1, argv+1);
  assert(argc == 2 && load_vocabulary(argv[1]));
  assert(parse_request("{\"op\":\"ping\",\"id\":2147483647}", &r));
  assert(r.id == 2147483647);
  assert(!parse_request("{\"op\":\"ping\",\"id\":2147483648}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"id\":-1}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"id\":01}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"id\":1.2}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"op\":\"quit\"}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"extra\":1}", &r));
  assert(!parse_request("{\"op\":\"ping\",}", &r));
  assert(!parse_request("{\"op\":\"ping\"} trailing", &r));
  assert(!parse_request("{\"op\":\"ping\",\"keywords_string\":\"\\u0000\"}", &r));
  assert(!parse_request("{\"op\":\"ping\",\"keywords_string\":\"\\ud800\"}", &r));
  assert(parse_request("{\"op\":\"set_keywords\",\"keywords_string\":\"n i :1.5 #0.35 @\\u4e8c\\u72d7\"}", &r));
  assert(valid_keywords(r.keywords));
  assert(!valid_keywords("n i"));
  assert(!valid_keywords("not_a_token :1.5 #0.35 @name"));
  assert(!valid_keywords("n i :NaN #0.35 @name"));
  assert(!valid_keywords("n i :1.5 #2 @name"));
  assert(!valid_keywords("n i :1.5 #0.35 @"));
  assert(!valid_keywords("n i :1.5 #0.35 @name/old"));
  assert(!valid_keywords("n i :1.5 #0.35 @name old"));
  assert(!valid_keywords("<blk> :1.5 #0.35 @name"));
  assert(!valid_keywords("n i :1.5 #0.35 @name\n\n"));
  assert(!valid_utf8((const unsigned char *)"\xc0\x80"));
  assert(!valid_utf8((const unsigned char *)"\xed\xa0\x80"));
  assert(!valid_utf8((const unsigned char *)"\xf4\x90\x80\x80"));
  assert(valid_utf8((const unsigned char *)"\xf0\x9f\x98\x80"));
  spotter = calloc(1, sizeof(*spotter));
  strcpy(current_keywords, "n i :1.5 #0.35 @name");
  assert(replace_stream(current_keywords));
  memset(&r, 0, sizeof(r)); strcpy(r.op, "feed");
  for (i = 0; i < FRAME_SAMPLES*4; ++i) r.pcm[i] = '0';
  memcpy(r.pcm, "0080ff7f", 8);
  assert(feed(&r));
  assert(received[0] == -1.0f && received[1] > 0.999f && received[2] == 0.0f);
  assert(result_creates == result_destroys);
  old = stream_creates; stream_samples = STREAM_SAMPLES_LIMIT;
  assert(feed(&r)); assert(stream_creates == old+1 && stream_samples == FRAME_SAMPLES);
  old = stream_creates; trigger_result = 1;
  assert(feed(&r)); assert(stream_creates == old+1);
  assert(result_creates == result_destroys);
  old = stream_creates;
  assert(replace_stream("n i :1.5 #0.35 @new"));
  assert(!strcmp(stream->keywords, "n i :1.5 #0.35 @new"));
  assert(stream_creates == old+1);
  cleanup(); assert(stream_creates == stream_destroys);
  puts("25 parser/keyword boundaries and PCM normalization, result freeing, stream-only reset passed; fake API, no real KWS tested.");
  return 0;
}
