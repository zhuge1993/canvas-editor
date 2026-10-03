// Private CPU-only compatibility/quality probe. No device or skill execution.
#include "llama.h"
#include "json.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

using Json=nlohmann::json;
static constexpr size_t kFrame=16384;
static constexpr int kContext=1024;
static std::mutex state_mutex,output_mutex;
static std::condition_variable changed;
static bool stopping=false,queued=false,working=false;
static bool clear_cache_pending=false,active_cache_job=false;
static std::string clear_cache_id,last_voice_id;
static uint64_t dialogue_epoch=0;
static Json pending;
static std::string active_id;
static std::atomic<bool> cancelled(false);
static double stop_at=0;
static double now(){return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();}
static long rss(){rusage value{};getrusage(RUSAGE_SELF,&value);return value.ru_maxrss;}
static bool abort_decode(void*){return cancelled.load()||now()>=stop_at;}
static void send(const Json &value){
    std::lock_guard<std::mutex> lock(output_mutex);
    std::string line=value.dump(-1,' ',false,Json::error_handler_t::replace)+"\n";
    if(line.size()>65536)return;
    std::fwrite(line.data(),1,line.size(),stdout);std::fflush(stdout);
}
static bool depth_ok(const char *line){
    int depth=0;bool quoted=false,escaped=false;
    for(const char *p=line;*p;++p){char c=*p;
        if(quoted){if(escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='"')quoted=false;}
        else if(c=='"')quoted=true;else if(c=='{'||c=='['){if(++depth>8)return false;}
        else if(c=='}'||c==']'){if(--depth<0)return false;}
    }
    return depth==0&&!quoted;
}
static bool valid_id(const std::string &id){
    if(id.empty()||id.size()>64)return false;
    for(unsigned char c:id)if(!((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_'||c=='-'||c=='.'))return false;
    return true;
}
static std::string format_messages(const Json &messages){
    if(!messages.is_array()||messages.empty()||messages.size()>12)throw std::runtime_error("invalid_messages");
    size_t content_bytes=0;std::string prompt;bool expect_user=true;
    for(size_t index=0;index<messages.size();++index){
        const Json &message=messages[index];
        if(!message.is_object()||message.size()!=2||!message.contains("role")||!message["role"].is_string()||
           !message.contains("content")||!message["content"].is_string())throw std::runtime_error("invalid_messages");
        std::string role=message["role"],content=message["content"];
        if(content.empty()||content.size()>4096||(content_bytes+=content.size())>8192)throw std::runtime_error("message_bytes_limit");
        for(const std::string marker:{"<|im_start|>","<|im_end|>","<think>","</think>"})
            if(content.find(marker)!=std::string::npos)throw std::runtime_error("template_marker_rejected");
        if(role=="system"){if(index!=0)throw std::runtime_error("invalid_roles");}
        else if(role==(expect_user?"user":"assistant"))expect_user=!expect_user;
        else throw std::runtime_error("invalid_roles");
        prompt+="<|im_start|>"+role+"\n"+content+"<|im_end|>\n";
    }
    if(expect_user)throw std::runtime_error("last_role_must_be_user");
    // Exact text-only/no-tools generation tail from pinned official Qwen
    // tokenizer_config.json, enable_thinking=false (0.8B default).
    prompt+="<|im_start|>assistant\n<think>\n\n</think>\n\n";
    return prompt;
}
static int decode(llama_context *ctx,llama_batch &batch,llama_token *tokens,int count,int position,bool last){
    batch.n_tokens=count;
    for(int i=0;i<count;++i){batch.token[i]=tokens[i];batch.pos[i]=position+i;batch.n_seq_id[i]=1;
        batch.seq_id[i][0]=0;batch.logits[i]=last&&i==count-1;}
    return llama_decode(ctx,batch);
}
static constexpr size_t kCheckpointLimit=64*1024*1024;
struct PrefixCache {
    std::vector<llama_token> tokens;
    std::vector<uint8_t> state;
    void clear(){tokens.clear();std::vector<uint8_t>().swap(state);}
};
struct DialogueCache:PrefixCache {
    size_t message_count=0;
    bool complete=false;
    std::string reply;
    void clear(){PrefixCache::clear();message_count=0;complete=false;reply.clear();}
};
static bool token_prefix_matches(const std::vector<llama_token> &prefix,const std::vector<llama_token> &full){
    return !prefix.empty()&&prefix.size()<full.size()&&std::equal(prefix.begin(),prefix.end(),full.begin());
}
static bool confirmed_history_matches(const DialogueCache &cache,const Json &messages){
    if(!cache.complete||cache.reply.empty()||messages.size()<=cache.message_count)return false;
    const Json &message=messages[cache.message_count];
    if(message["role"]!="assistant")return false;
    const std::string spoken=message["content"];
    if(spoken.empty()||cache.reply.compare(0,spoken.size(),spoken)!=0)return false;
    if(spoken==cache.reply)return true;
    size_t characters=0;for(unsigned char ch:spoken)if((ch&0xc0)!=0x80)++characters;
    return characters<=120;
}
static std::vector<llama_token> dialogue_prefix_tokens(const std::string &prompt,const llama_vocab *vocab,const std::vector<llama_token> &full){
    const std::string tail="<think>\n\n</think>\n\n";
    if(prompt.size()<tail.size()||prompt.compare(prompt.size()-tail.size(),tail.size(),tail)!=0)return {};
    std::string prefix=prompt.substr(0,prompt.size()-tail.size());std::vector<llama_token> result(kContext);
    int count=llama_tokenize(vocab,prefix.data(),int(prefix.size()),result.data(),int(result.size()),false,true);
    if(count<=0||count>=kContext)return {};result.resize(count);size_t common=0;
    while(common<result.size()&&common<full.size()&&result[common]==full[common])++common;
    result.resize(common);return result;
}
static std::vector<llama_token> prefix_tokens(const Json &messages,const llama_vocab *vocab,const std::vector<llama_token> &full){
    std::string prefix;
    if(messages[0]["role"]=="system")prefix="<|im_start|>system\n"+messages[0]["content"].get<std::string>()+"<|im_end|>\n";
    prefix+="<|im_start|>user\n";
    std::vector<llama_token> result(kContext);
    int count=llama_tokenize(vocab,prefix.data(),int(prefix.size()),result.data(),int(result.size()),false,true);
    if(count<=0||count>512)return {};
    result.resize(count);size_t common=0;
    while(common<result.size()&&common<full.size()&&result[common]==full[common])++common;
    result.resize(common);return result;
}
static std::string prefill_range(llama_context *ctx,llama_batch &batch,std::vector<llama_token> &tokens,int begin,int end){
    for(int at=begin;at<end;at+=32){
        if(abort_decode(nullptr))return cancelled.load()?"cancelled":"deadline";
        int n=std::min(32,end-at);
        if(decode(ctx,batch,tokens.data()+at,n,at,at+n==int(tokens.size()))!=0)
            return abort_decode(nullptr)?(cancelled.load()?"cancelled":"deadline"):"decode_error";
    }
    return "complete";
}
static Json compare_logits(const std::vector<float> &cached,const float *baseline){
    double maximum=0,total=0;bool finite=true,bitwise=true;size_t a=0,b=0;
    for(size_t i=0;i<cached.size();++i){
        if(!std::isfinite(cached[i])||!std::isfinite(baseline[i]))finite=false;
        double delta=std::fabs(double(cached[i])-baseline[i]);maximum=std::max(maximum,delta);total+=delta;
        if(std::memcmp(&cached[i],&baseline[i],sizeof(float))!=0)bitwise=false;
        if(cached[i]>cached[a])a=i;if(baseline[i]>baseline[b])b=i;
    }
    return {{"logits_compared",cached.size()},{"finite",finite},{"bitwise_equal",bitwise},
            {"max_abs_delta",maximum},{"mean_abs_delta",total/cached.size()},
            {"cached_argmax",a},{"baseline_argmax",b},{"argmax_equal",a==b}};
}
static void inference(llama_model *model,llama_context *ctx){
    const llama_vocab *vocab=llama_model_get_vocab(model);
    llama_batch batch=llama_batch_init(32,0,1);
    PrefixCache cache;DialogueCache dialog;uint64_t seen_epoch=0;
    while(true){
        Json job;std::string clearing;uint64_t job_epoch;
        {std::unique_lock<std::mutex> lock(state_mutex);
            changed.wait(lock,[&]{return stopping||queued||clear_cache_pending||seen_epoch!=dialogue_epoch;});
            if(stopping)break;
            if(seen_epoch!=dialogue_epoch){dialog.clear();seen_epoch=dialogue_epoch;}
            if(clear_cache_pending){clearing=clear_cache_id;clear_cache_pending=false;cache.clear();dialog.clear();}
            else if(queued){job=pending;queued=false;working=true;}
            job_epoch=dialogue_epoch;}
        if(!clearing.empty()){
            llama_memory_clear(llama_get_memory(ctx),true);
            send({{"type","cache_cleared"},{"id",clearing},{"checkpoint_bytes",0},{"cache_slots",0},{"model_load_count",1}});continue;
        }
        if(job.is_null())continue;
        std::string id=job["id"],reply,status="complete",finish="token_limit";
        int generated=0,input_tokens=0,maximum=job.value("max_tokens",64);
        double start=now(),first=-1,prefill=0;stop_at=start+job.value("deadline_ms",30000)/1000.0;
        bool use_cache=job.value("use_prefix_cache",true),verify=job.value("verify_cache",false),cache_hit=false,dialogue_hit=false,verified_restore=false;
        int reused_tokens=0;double restore_seconds=0,build_seconds=0,cached_prefill=0,verification_seconds=0;
        Json verification=nullptr;
        llama_sampler *sampler=nullptr;
        try{
            // DeltaNet recurrent state cannot be treated as old transformer
            // prefix-only KV. Clear the full state for every explicit turn.
            llama_memory_clear(llama_get_memory(ctx),true);
            std::string prompt=format_messages(job["messages"]);
            std::vector<llama_token> tokens(kContext);
            int count=llama_tokenize(vocab,prompt.data(),int(prompt.size()),tokens.data(),int(tokens.size()),false,true);
            if(count<=0||count+maximum>kContext)throw std::runtime_error("prompt_context_limit");
            tokens.resize(count);input_tokens=count;
            std::vector<llama_token> wanted=use_cache?prefix_tokens(job["messages"],vocab,tokens):std::vector<llama_token>();
            std::vector<llama_token> future=use_cache?dialogue_prefix_tokens(prompt,vocab,tokens):std::vector<llama_token>();
            int cursor=0;
            if(use_cache&&confirmed_history_matches(dialog,job["messages"])&&token_prefix_matches(dialog.tokens,tokens)){
                double restore_start=now();size_t restored=llama_state_seq_set_data(ctx,dialog.state.data(),dialog.state.size(),0);
                restore_seconds=now()-restore_start;
                if(restored==dialog.state.size()&&llama_memory_seq_pos_max(llama_get_memory(ctx),0)==int(dialog.tokens.size())-1){
                    cache_hit=true;dialogue_hit=true;cursor=int(dialog.tokens.size());reused_tokens=cursor;
                }else{dialog.clear();llama_memory_clear(llama_get_memory(ctx),true);}
            }
            if(!cache_hit&&!wanted.empty()){
                if(cache.tokens==wanted&&!cache.state.empty()){
                    double restore_start=now();size_t restored=llama_state_seq_set_data(ctx,cache.state.data(),cache.state.size(),0);
                    restore_seconds=now()-restore_start;
                    if(restored==cache.state.size()&&llama_memory_seq_pos_max(llama_get_memory(ctx),0)==int(wanted.size())-1){
                        cache_hit=true;cursor=int(wanted.size());reused_tokens=cursor;
                    }else{cache.clear();llama_memory_clear(llama_get_memory(ctx),true);}
                }
                if(!cache_hit){
                    cache.clear();dialog.clear();double prefix_start=now();status=prefill_range(ctx,batch,tokens,0,int(wanted.size()));
                    build_seconds=now()-prefix_start;cursor=int(wanted.size());
                    if(status=="complete"){
                        size_t bytes=llama_state_seq_get_size(ctx,0);
                        if(bytes>0&&bytes<=kCheckpointLimit){
                            cache.state.resize(bytes);
                            if(llama_state_seq_get_data(ctx,cache.state.data(),bytes,0)==bytes)cache.tokens=wanted;
                            else cache.clear();
                        }
                    }
                }
            }
            if(use_cache&&status=="complete"&&!future.empty()&&int(future.size())>=cursor){
                status=prefill_range(ctx,batch,tokens,cursor,int(future.size()));cursor=int(future.size());
                // Drop the previous dialogue bytes before allocating the new
                // single dialogue slot. System+dialogue never exceed64MiB.
                dialog.clear();
                if(status=="complete"){
                    size_t bytes=llama_state_seq_get_size(ctx,0);
                    if(bytes>0&&bytes<=kCheckpointLimit-cache.state.size()){
                        dialog.state.resize(bytes);
                        if(llama_state_seq_get_data(ctx,dialog.state.data(),bytes,0)==bytes){
                            dialog.tokens=future;dialog.message_count=job["messages"].size();
                        }else dialog.clear();
                    }
                }
            }
            if(verify&&status=="complete"){
                if(!use_cache||dialog.state.empty())throw std::runtime_error("verification_checkpoint_missing");
                llama_memory_clear(llama_get_memory(ctx),true);double restore_start=now();
                size_t restored=llama_state_seq_set_data(ctx,dialog.state.data(),dialog.state.size(),0);
                restore_seconds+=now()-restore_start;
                if(restored!=dialog.state.size()||llama_memory_seq_pos_max(llama_get_memory(ctx),0)!=int(dialog.tokens.size())-1)
                    throw std::runtime_error("verification_restore_failed");
                cursor=int(dialog.tokens.size());verified_restore=true;
            }
            if(status=="complete")status=prefill_range(ctx,batch,tokens,cursor,count);
            cached_prefill=now()-start;
            if(verify&&status=="complete"){
                int n_vocab=llama_vocab_n_tokens(vocab);
                if(n_vocab<=0||n_vocab>262144)throw std::runtime_error("verification_vocab_limit");
                const float *logits=llama_get_logits_ith(ctx,-1);if(!logits)throw std::runtime_error("verification_logits_missing");
                std::vector<float> saved(logits,logits+n_vocab);
                llama_memory_clear(llama_get_memory(ctx),true);double verify_start=now();
                status=prefill_range(ctx,batch,tokens,0,count);verification_seconds=now()-verify_start;
                if(status=="complete")verification=compare_logits(saved,llama_get_logits_ith(ctx,-1));
                // Verification leaves the uncached reference state for output.
                // It is never advertised as a fast cached generation timing.
            }
            prefill=now()-start;
            sampler=llama_sampler_init_greedy();
            for(int i=0;i<maximum&&status=="complete";++i){
                if(abort_decode(nullptr)){status=cancelled.load()?"cancelled":"deadline";break;}
                llama_token token=llama_sampler_sample(sampler,ctx,-1);llama_sampler_accept(sampler,token);
                if(llama_vocab_is_eog(vocab,token)){finish="eos";break;}
                char piece[512];int length=llama_token_to_piece(vocab,token,piece,sizeof(piece),0,false);
                if(length<0||length>int(sizeof(piece))||reply.size()+length>8192){status="piece_limit";break;}
                reply.append(piece,length);++generated;if(first<0)first=now()-start;
                std::vector<unsigned int> bytes;for(int p=0;p<length;++p)bytes.push_back((unsigned char)piece[p]);
                send({{"type","token"},{"id",id},{"bytes",bytes},{"elapsed_seconds",now()-start}});
                if(i+1<maximum&&decode(ctx,batch,&token,1,count+i,true)!=0){
                    status=abort_decode(nullptr)?(cancelled.load()?"cancelled":"deadline"):"decode_error";break;}
            }
        }catch(const std::exception &error){
            status=std::strcmp(error.what(),"prompt_context_limit")==0?"prompt_context_limit":"inference_error";
        }
        if(sampler)llama_sampler_free(sampler);
        llama_memory_clear(llama_get_memory(ctx),true);
        if(status!="complete")finish=status;
        {std::lock_guard<std::mutex> lock(state_mutex);
            if(use_cache){
                last_voice_id=id;
                if(status=="complete"&&!cancelled.load()&&job_epoch==dialogue_epoch&&!dialog.state.empty()){
                    dialog.complete=true;dialog.reply=reply;
                }else dialog.clear();
            }
            working=false;active_id.clear();active_cache_job=false;}
        send({{"type","done"},{"id",id},{"status",status},{"finish_reason",finish},{"text",reply},
              {"input_tokens",input_tokens},{"generated_tokens",generated},{"first_token_seconds",first},
              {"prefill_seconds",prefill},{"total_seconds",now()-start},{"max_rss_kib",rss()},
              {"prefix_cache_requested",use_cache},{"prefix_cache_hit",cache_hit},{"prefix_tokens_reused",reused_tokens},
              {"dialogue_cache_hit",dialogue_hit},{"dialogue_checkpoint_tokens",dialog.tokens.size()},
              {"dialogue_checkpoint_bytes",dialog.state.size()},
              {"checkpoint_bytes_total",cache.state.size()+dialog.state.size()},
              {"prefix_checkpoint_bytes",cache.state.size()},{"prefix_checkpoint_tokens",cache.tokens.size()},
              {"prefix_cache_build_seconds",build_seconds},{"prefix_restore_seconds",restore_seconds},
              {"cached_path_prefill_seconds",cached_prefill},{"verification_uncached_seconds",verification_seconds},
              {"cache_restore_checked",verified_restore},{"cache_verification",verification},
              {"verification_generation_uses_uncached_reference",verify},
              {"gpu_used",false},{"history_persisted",false},{"non_thinking",true}});
    }
    llama_batch_free(batch);
}
int main(int argc,char **argv){
    if(argc==2&&!std::strcmp(argv[1],"--help")){
        std::puts("qwen35-worker-dialog MODEL_GGUF [threads=2]; private JSONL generate/messages, use_prefix_cache, verify_cache, clear_cache, ping, cancel, quit. CPU ARMv7; context1024; 2 RAM checkpoints total<=64MiB; authenticated confirmed voice role history; output<=128tokens; probe deadline<=120s.");return 0;}
    if(argc<2||argc>3)return 2;int threads=argc>2?std::atoi(argv[2]):2;if(threads<1||threads>4)return 2;
    pid_t parent=getppid();if(prctl(PR_SET_PDEATHSIG,SIGTERM)!=0||getppid()!=parent)return 2;
    rlimit core{0,0};setrlimit(RLIMIT_CORE,&core);
    llama_log_set([](ggml_log_level level,const char *message,void*){
        if(level>=GGML_LOG_LEVEL_WARN)std::fwrite(message,1,std::min(std::strlen(message),size_t(2048)),stderr);},nullptr);
    double start=now();llama_backend_init();llama_model_params mp=llama_model_default_params();mp.n_gpu_layers=0;mp.load_mtp=false;
    llama_model *model=llama_model_load_from_file(argv[1],mp);if(!model)return 3;
    char arch[64];llama_model_meta_val_str(model,"general.architecture",arch,sizeof(arch));
    if(std::strcmp(arch,"qwen35")!=0){llama_model_free(model);return 3;}
    llama_context_params cp=llama_context_default_params();cp.n_ctx=kContext;cp.n_batch=32;cp.n_ubatch=32;cp.n_seq_max=1;
    cp.n_threads=threads;cp.n_threads_batch=threads;cp.offload_kqv=false;cp.op_offload=false;
    cp.abort_callback=abort_decode;stop_at=now()+120;llama_context *ctx=llama_init_from_model(model,cp);
    if(!ctx){llama_model_free(model);return 3;}
    send({{"type","ready"},{"model_load_seconds",now()-start},{"model_load_count",1},{"backend","CPU_ARMV7_NEON"},
          {"gpu_used",false},{"threads",threads},{"context_tokens",kContext},{"max_messages",12},
          {"message_bytes_limit",8192},{"max_generated_tokens",128},{"max_rss_kib",rss()},
          {"prefix_cache_checkpoint_limit_bytes",kCheckpointLimit},{"prefix_cache_slots",2},
          {"prefix_cache_key","exact system/user-open tokens in this fixed loaded model/template"},
          {"non_thinking",true},{"engine_tag","b11371"},{"engine_pin","99b95488cac0f00ce3f05af113a8c1e287753f87"}});
    std::thread worker(inference,model,ctx);char line[kFrame+2];
    while(std::fgets(line,sizeof(line),stdin)){
        size_t length=std::strlen(line);
        if(!length||length>kFrame||line[length-1]!='\n'){
            if(length&&line[length-1]!='\n'){int c;while((c=std::fgetc(stdin))!=EOF&&c!='\n'){}}
            send({{"type","error"},{"code","frame_limit"}});continue;}
        if(!depth_ok(line)){send({{"type","error"},{"code","json_depth"}});continue;}
        try{
            Json job=Json::parse(line);if(!job.is_object()||!job.contains("id")||!job["id"].is_string())throw std::runtime_error("invalid_id");
            std::string id=job["id"],op=job.value("op",std::string());if(!valid_id(id))throw std::runtime_error("invalid_id");
            if(op=="ping"){std::lock_guard<std::mutex> lock(state_mutex);send({{"type","pong"},{"id",id},{"working",working||queued},{"model_load_count",1},{"max_rss_kib",rss()}});continue;}
            if(op=="cancel"){
                std::lock_guard<std::mutex> lock(state_mutex);
                if(id==active_id){cancelled.store(true);if(active_cache_job)++dialogue_epoch;}
                else if(id==last_voice_id)++dialogue_epoch;
                changed.notify_one();send({{"type","cancel_ack"},{"id",id}});continue;
            }
            if(op=="clear_cache"){
                if(job.size()!=2)throw std::runtime_error("unexpected_fields");
                std::lock_guard<std::mutex> lock(state_mutex);if(clear_cache_pending)throw std::runtime_error("busy");
                clear_cache_pending=true;clear_cache_id=id;++dialogue_epoch;
                if(working)cancelled.store(true);
                if(queued){send({{"type","done"},{"id",pending["id"]},{"status","cancelled"},{"text",""}});queued=false;}
                changed.notify_one();continue;
            }
            if(op=="quit"){send({{"type","bye"},{"id",id}});break;}
            if(op!="generate")throw std::runtime_error("forbidden_operation");
            for(auto it=job.begin();it!=job.end();++it)if(it.key()!="op"&&it.key()!="id"&&it.key()!="messages"&&it.key()!="max_tokens"&&it.key()!="deadline_ms"&&it.key()!="use_prefix_cache"&&it.key()!="verify_cache")throw std::runtime_error("unexpected_fields");
            if(!job.contains("messages"))throw std::runtime_error("invalid_messages");format_messages(job["messages"]);
            if((job.contains("max_tokens")&&!job["max_tokens"].is_number_integer())||(job.contains("deadline_ms")&&!job["deadline_ms"].is_number_integer()))throw std::runtime_error("generation_limit");
            if((job.contains("use_prefix_cache")&&!job["use_prefix_cache"].is_boolean())||
               (job.contains("verify_cache")&&!job["verify_cache"].is_boolean()))throw std::runtime_error("generation_limit");
            if(job.value("verify_cache",false)&&!job.value("use_prefix_cache",true))throw std::runtime_error("generation_limit");
            int maximum=job.value("max_tokens",64),deadline=job.value("deadline_ms",30000);
            if(maximum<1||maximum>128||deadline<100||deadline>120000)throw std::runtime_error("generation_limit");
            {std::lock_guard<std::mutex> lock(state_mutex);if(working||queued)throw std::runtime_error("busy");
                pending=job;queued=true;active_id=id;active_cache_job=job.value("use_prefix_cache",true);cancelled.store(false);changed.notify_one();}
        }catch(const std::exception &error){
            std::string code=error.what();
            static const std::vector<std::string> allowed={"invalid_id","invalid_messages","message_bytes_limit","template_marker_rejected","invalid_roles","last_role_must_be_user","forbidden_operation","unexpected_fields","generation_limit","busy"};
            if(std::find(allowed.begin(),allowed.end(),code)==allowed.end())code="invalid_json_or_type";
            send({{"type","error"},{"code",code}});
        }
    }
    {std::lock_guard<std::mutex> lock(state_mutex);stopping=true;cancelled.store(true);changed.notify_one();}
    worker.join();llama_free(ctx);llama_model_free(model);llama_backend_free();return 0;
}
