/* Persistent ARMhf BERT embeddings. All inputs are bounded numeric token IDs. */
#include "onnxruntime_c_api.h"
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <math.h>
#define MAX_BATCH 8
#define MAX_TOKENS 128
#define HIDDEN 512
#define LINE_BYTES 16384
static const OrtApi *api;
static int checked(OrtStatus *status) {
    if (!status) return 1;
    api->ReleaseStatus(status);return 0;
}
int main(int argc,char **argv) {
    if(argc!=3)return 2;
    int threads=atoi(argv[2]);if(threads<1||threads>4)return 2;
    api=OrtGetApiBase()->GetApi(ORT_API_VERSION);if(!api)return 3;
    OrtEnv *env=NULL;OrtSessionOptions *options=NULL;OrtSession *session=NULL;OrtMemoryInfo *memory=NULL;
    if(!checked(api->CreateEnv(ORT_LOGGING_LEVEL_ERROR,"fast-decision",&env))||
       !checked(api->CreateSessionOptions(&options))||
       !checked(api->SetIntraOpNumThreads(options,threads))||
       !checked(api->SetInterOpNumThreads(options,1))||
       !checked(api->SetSessionGraphOptimizationLevel(options,ORT_ENABLE_BASIC))||
       !checked(api->DisableMemPattern(options))||
       !checked(api->DisableCpuMemArena(options))||
       !checked(api->AddSessionConfigEntry(options,"session.disable_prepacking","1"))||
       !checked(api->CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&memory))||
       !checked(api->CreateSession(env,argv[1],options,&session)))return 4;
    char line[LINE_BYTES];
    int64_t ids[MAX_BATCH*MAX_TOKENS],mask[MAX_BATCH*MAX_TOKENS],types[MAX_BATCH*MAX_TOKENS];
    printf("READY\n");fflush(stdout);
    while(fgets(line,LINE_BYTES,stdin)) {
        if(line[0]!='B'||line[strlen(line)-1]!='\n')return 6;
        char *cursor=line+1,*end;
        long batch=strtol(cursor,&end,10);if(end==cursor||batch<1||batch>MAX_BATCH)return 6;cursor=end;
        long width=strtol(cursor,&end,10);if(end==cursor||width<2||width>MAX_TOKENS||batch*width>512)return 6;cursor=end;
        long count=batch*width;
        for(long i=0;i<count;i++) {
            long value=strtol(cursor,&end,10);if(end==cursor||value<0||value>=21128)return 6;cursor=end;
            ids[i]=value;mask[i]=value!=0;types[i]=0;
        }
        int64_t shape[]={batch,width};
        OrtValue *input[3]={NULL,NULL,NULL},*output=NULL;OrtTensorTypeAndShapeInfo *info=NULL;
        const char *names[]={"input_ids","attention_mask","token_type_ids"},*result_name="vectors";
        int64_t *arrays[]={ids,mask,types};int ok=1;
        for(int i=0;i<3;i++)if(!checked(api->CreateTensorWithDataAsOrtValue(memory,arrays[i],(size_t)count*sizeof(int64_t),shape,2,ONNX_TENSOR_ELEMENT_DATA_TYPE_INT64,&input[i])))ok=0;
        if(ok&&!checked(api->Run(session,NULL,names,(const OrtValue *const *)input,3,&result_name,1,&output)))ok=0;
        size_t elements=0;float *values=NULL;
        if(ok&&(!checked(api->GetTensorTypeAndShape(output,&info))||!checked(api->GetTensorShapeElementCount(info,&elements))||elements!=(size_t)batch*HIDDEN||!checked(api->GetTensorMutableData(output,(void **)&values))))ok=0;
        if(ok)for(size_t i=0;i<elements;i++)if(!isfinite(values[i]))ok=0;
        if(ok){printf("OK");for(size_t i=0;i<elements;i++)printf(" %.9g",(double)values[i]);printf("\n");}
        else printf("ERROR\n");
        fflush(stdout);
        if(info)api->ReleaseTensorTypeAndShapeInfo(info);
        if(output)api->ReleaseValue(output);
        for(int i=0;i<3;i++)if(input[i])api->ReleaseValue(input[i]);
    }
    api->ReleaseSession(session);api->ReleaseSessionOptions(options);api->ReleaseMemoryInfo(memory);api->ReleaseEnv(env);
    return 0;
}
