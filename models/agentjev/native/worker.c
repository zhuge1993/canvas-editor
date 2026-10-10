/* Bounded ARMhf ONNX inference. Input contains token ids or vectors, never commands. */
#include "onnxruntime_c_api.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
extern int *__errno_location(void);
#define errno (*__errno_location())

#define HIDDEN 1024
#define MAX_TOKENS 1024
#define MAX_CANDIDATES 16
#define LINE_BYTES (320 * 1024)

static const OrtApi *api;
static OrtMemoryInfo *memory;
static int checked(OrtStatus *status) {
    if (!status) return 1;
    fprintf(stderr, "ONNX: %s\n", api->GetErrorMessage(status));
    api->ReleaseStatus(status);
    return 0;
}

static int run(OrtSession *session, const char *name, const char *output,
               void *data, size_t bytes, const int64_t *shape, size_t rank,
               ONNXTensorElementDataType dtype, size_t expected, int64_t *lengths) {
    OrtValue *input = NULL, *result = NULL;
    OrtValue *length_input = NULL;
    OrtTensorTypeAndShapeInfo *info = NULL;
    size_t count = 0;
    float *values = NULL;
    int ok = 0;
    if (!checked(api->CreateTensorWithDataAsOrtValue(memory, data, bytes, shape, rank, dtype, &input))) goto done;
    if (lengths) {
        int64_t length_shape[] = {shape[0]};
        if (!checked(api->CreateTensorWithDataAsOrtValue(memory,lengths,(size_t)shape[0]*sizeof(int64_t),length_shape,1,ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,&length_input))) goto done;
        const char *names[] = {name,"lengths"};
        const OrtValue *inputs[] = {input,length_input};
        if (!checked(api->Run(session,NULL,names,inputs,2,&output,1,&result))) goto done;
    } else {
        if (!checked(api->Run(session, NULL, &name, (const OrtValue *const *)&input, 1, &output, 1, &result))) goto done;
    }
    if (!checked(api->GetTensorTypeAndShape(result, &info))) goto done;
    if (!checked(api->GetTensorShapeElementCount(info, &count)) || count != expected) goto done;
    if (!checked(api->GetTensorMutableData(result, (void **)&values))) goto done;
    for (size_t i = 0; i < count; ++i) if (!isfinite(values[i])) goto done;
    printf("OK");
    for (size_t i = 0; i < count; ++i) printf(" %.9g", (double)values[i]);
    printf("\n"); fflush(stdout);
    ok = 1;
done:
    if (info) api->ReleaseTensorTypeAndShapeInfo(info);
    if (result) api->ReleaseValue(result);
    if (input) api->ReleaseValue(input);
    if (length_input) api->ReleaseValue(length_input);
    return ok;
}

int main(int argc, char **argv) {
    if (argc != 4) return 2;
    const OrtApiBase *base = OrtGetApiBase();
    api = base->GetApi(ORT_API_VERSION);
    if (!api) return 3;
    int threads = atoi(argv[3]);
    if (threads < 1 || threads > 4) return 2;
    OrtEnv *env = NULL;
    OrtSessionOptions *options = NULL;
    OrtSession *encoder = NULL, *head = NULL;
    if (!checked(api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "agentjev", &env)) ||
        !checked(api->CreateSessionOptions(&options)) ||
        !checked(api->SetIntraOpNumThreads(options, threads)) ||
        !checked(api->SetInterOpNumThreads(options, 1)) ||
        !checked(api->SetSessionGraphOptimizationLevel(options, ORT_ENABLE_BASIC)) ||
        !checked(api->DisableMemPattern(options)) ||
        !checked(api->DisableCpuMemArena(options)) ||
        !checked(api->AddSessionConfigEntry(options, "session.disable_prepacking", "1")) ||
        !checked(api->CreateCpuMemoryInfo(OrtArenaAllocator, OrtMemTypeDefault, &memory)) ||
        !checked(api->CreateSession(env, argv[1], options, &encoder)) ||
        !checked(api->CreateSession(env, argv[2], options, &head))) return 4;
    char *line = malloc(LINE_BYTES);
    int64_t *tokens = malloc(4 * MAX_TOKENS * sizeof(int64_t));
    float *vectors = malloc(MAX_CANDIDATES * HIDDEN * sizeof(float));
    if (!line || !tokens || !vectors) return 5;
    printf("READY\n"); fflush(stdout);
    while (fgets(line, LINE_BYTES, stdin)) {
        size_t length = strlen(line);
        if (!length || line[length - 1] != '\n') return 6;
        char *cursor = line + 1, *end;
        errno = 0;
        long n = strtol(cursor, &end, 10);
        if (errno || end == cursor) return 6;
        cursor = end;
        int ok = 0;
        if (line[0] == 'E' && n > 0 && n <= MAX_TOKENS) {
            for (long i = 0; i < n; ++i) {
                errno = 0; tokens[i] = strtoll(cursor, &end, 10);
                if (errno || end == cursor || tokens[i] < 0 || tokens[i] >= 151936) return 6;
                cursor = end;
            }
            int64_t shape[] = {1, n};
            int64_t lengths[] = {n};
            ok = run(encoder, "input_ids", "vectors", tokens, (size_t)n * sizeof(int64_t), shape, 2, ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64, HIDDEN, lengths);
        } else if (line[0] == 'B' && n > 0 && n <= 4) {
            long width = strtol(cursor,&end,10);
            if (end == cursor || width <= 0 || width > MAX_TOKENS || (n > 1 && n*width > 256)) return 6;
            cursor = end;
            for (long i=0;i<n*width;++i) {
                errno=0;tokens[i]=strtoll(cursor,&end,10);
                if (errno || end==cursor || tokens[i]<0 || tokens[i]>=151936) return 6;
                cursor=end;
            }
            int64_t lengths[4];
            for (long i=0;i<n;++i) {
                lengths[i]=strtoll(cursor,&end,10);
                if (end==cursor || lengths[i]<=0 || lengths[i]>width) return 6;
                cursor=end;
            }
            int64_t shape[]={n,width};
            ok=run(encoder,"input_ids","vectors",tokens,(size_t)(n*width)*sizeof(int64_t),shape,2,ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,(size_t)n*HIDDEN,lengths);
        } else if (line[0] == 'H' && n >= 2 && n <= MAX_CANDIDATES) {
            for (long i = 0; i < n * HIDDEN; ++i) {
                errno = 0; vectors[i] = strtof(cursor, &end);
                if (errno || end == cursor || !isfinite(vectors[i])) return 6;
                cursor = end;
            }
            int64_t shape[] = {1, n, HIDDEN};
            ok = run(head, "vectors", "logits", vectors, (size_t)n * HIDDEN * sizeof(float), shape, 3, ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT, (size_t)n, NULL);
        } else return 6;
        if (!ok) { printf("ERROR\n"); fflush(stdout); }
    }
    free(vectors); free(tokens); free(line);
    api->ReleaseSession(head); api->ReleaseSession(encoder);
    api->ReleaseSessionOptions(options); api->ReleaseMemoryInfo(memory); api->ReleaseEnv(env);
    return 0;
}
