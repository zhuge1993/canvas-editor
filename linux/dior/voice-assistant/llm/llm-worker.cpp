// Private CPU-only compatibility/quality probe. No device or skill execution.
#include "llama.h"
#include "json.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
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
static bool clear_pending=false;
static bool clear_all_pending=true;
static std::string clear_id;
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
    // Qwen2.5 text ChatML: system remains its own role, not user text.
    prompt+="<|im_start|>assistant\n";
    return prompt;
}
static int decode(llama_context *ctx,llama_batch &batch,llama_token *tokens,int count,int position,bool last){
    batch.n_tokens=count;
    for(int i=0;i<count;++i){batch.token[i]=tokens[i];batch.pos[i]=position+i;batch.n_seq_id[i]=1;
        batch.seq_id[i][0]=0;batch.logits[i]=last&&i==count-1;}
    return llama_decode(ctx,batch);
}
static Json request_messages(const Json &job){
    if(job.contains("messages")&&job.contains("text"))throw std::runtime_error("conflicting_input");
    if(job.contains("messages"))return job["messages"];
    if(!job.contains("text")||!job["text"].is_string()||job["text"].get<std::string>().empty())throw std::runtime_error("invalid_messages");
    return Json::array({{{"role","system"},{"content","你是一个中文语音助手。请简洁准确地回答，不声称执行过未完成的操作。"}},
                        {{"role","user"},{"content",job["text"]}}});
}
static void validate_system(const std::string &system){
    if(system.empty()||system.size()>4096)throw std::runtime_error("invalid_system");
    bool meaningful=false;
    for(unsigned char c:system){
        if(c<32&&c!='\n'&&c!='\t')throw std::runtime_error("invalid_system");
        if(c!=' '&&c!='\n'&&c!='\t')meaningful=true;
    }
    if(!meaningful)throw std::runtime_error("invalid_system");
    for(const std::string marker:{"<|im_start|>","<|im_end|>","<think>","</think>"})
        if(system.find(marker)!=std::string::npos)throw std::runtime_error("template_marker_rejected");
}
static std::vector<llama_token> system_prefix_tokens(const std::string &system,bool has_system,const llama_model *model){
    std::string prefix;
    if(has_system)prefix="<|im_start|>system\n"+system+"<|im_end|>\n";
    // End at a stable special-token boundary, before user-role text/NL.
    // A later user's first character cannot change these cached tokens.
    prefix+="<|im_start|>";std::vector<llama_token> tokens(kContext);
    int count=llama_tokenize(model,prefix.data(),int(prefix.size()),tokens.data(),int(tokens.size()),false,true);
    if(count<=0||count>512)return {};tokens.resize(count);return tokens;
}
static std::vector<llama_token> system_prefix(const Json &messages,const llama_model *model,const std::vector<llama_token> &full){
    bool has_system=messages[0]["role"]=="system";
    auto tokens=system_prefix_tokens(has_system?messages[0]["content"].get<std::string>():std::string(),has_system,model);
    if(tokens.size()>full.size()||!std::equal(tokens.begin(),tokens.end(),full.begin()))return {};
    return tokens;
}
static std::string prefill_range(llama_context *ctx,llama_batch &batch,std::vector<llama_token> &tokens,int begin,int end,bool final_logits=true){
    for(int at=begin;at<end;at+=32){
        if(abort_decode(nullptr))return cancelled.load()?"cancelled":"deadline";
        int n=std::min(32,end-at);
        if(decode(ctx,batch,tokens.data()+at,n,at,final_logits&&at+n==int(tokens.size()))!=0)
            return abort_decode(nullptr)?(cancelled.load()?"cancelled":"deadline"):"decode_error";
    }
    return "complete";
}
static void retain_system_prefix(llama_context *ctx,std::vector<llama_token> &cached){
    // Only the exact system/user-open prefix may survive. No user content or
    // assistant suffix is part of cached; fail closed if the KV extent differs.
    if(cached.empty()||!llama_kv_cache_seq_rm(ctx,0,int(cached.size()),-1)||
       llama_get_kv_cache_used_cells(ctx)!=int(cached.size())){
        llama_kv_cache_clear(ctx);cached.clear();
    }
}
static void inference(llama_model *model,llama_context *ctx){
    llama_batch batch=llama_batch_init(32,0,1);
    std::vector<llama_token> cached;
    while(true){
        Json job;std::string clearing;bool clear_all=true;
        {std::unique_lock<std::mutex> lock(state_mutex);changed.wait(lock,[]{return stopping||queued||clear_pending;});
            if(stopping)break;
            if(clear_pending){clearing=clear_id;clear_all=clear_all_pending;clear_pending=false;clear_id.clear();}
            else{job=std::move(pending);pending=Json();queued=false;working=true;}}
        if(!clearing.empty()){
            if(clear_all){llama_kv_cache_clear(ctx);cached.clear();}
            else retain_system_prefix(ctx,cached);
            send({{"type",clear_all?"cache_cleared":"history_cleared"},{"id",clearing},
                  {"cached_prefix_tokens",cached.size()},{"retained_kv_cells",llama_get_kv_cache_used_cells(ctx)},
                  {"user_suffix_retained",false},{"model_load_count",1}});continue;
        }
        if(job["op"]=="prepare_system"){
            std::string id=job["id"],status="complete";bool cache_hit=false;
            double start=now();stop_at=start+job.value("deadline_ms",20000)/1000.0;
            try{
                auto wanted=system_prefix_tokens(job["system"].get<std::string>(),true,model);
                if(wanted.empty())status="prompt_context_limit";
                else if(abort_decode(nullptr))status=cancelled.load()?"cancelled":"deadline";
                else{
                    if(cached==wanted){retain_system_prefix(ctx,cached);cache_hit=cached==wanted;}
                    if(!cache_hit){
                        llama_kv_cache_clear(ctx);cached.clear();
                        status=prefill_range(ctx,batch,wanted,0,int(wanted.size()),false);
                        if(status=="complete")cached=wanted;
                    }
                }
            }catch(const std::exception &){status="prepare_error";}
            retain_system_prefix(ctx,cached);
            {std::lock_guard<std::mutex> lock(state_mutex);working=false;active_id.clear();}
            send({{"type","system_prepared"},{"id",id},{"status",status},{"generated_tokens",0},
                  {"cached_prefix_tokens",cached.size()},{"retained_kv_cells",llama_get_kv_cache_used_cells(ctx)},
                  {"user_suffix_retained",false},{"prefix_cache_hit",cache_hit},{"prefill_seconds",now()-start},
                  {"total_seconds",now()-start},{"gpu_used",false},{"model_load_count",1}});continue;
        }
        std::string id=job["id"],reply,status="complete",finish="token_limit";
        int generated=0,input_tokens=0,maximum=job.value("max_tokens",96),reused=0;
        bool use_cache=job.value("use_prefix_cache",true),cache_hit=false;
        double start=now(),first=-1,prefill=0;stop_at=start+job.value("deadline_ms",30000)/1000.0;
        llama_sampler *sampler=nullptr;
        try{
            Json messages=request_messages(job);std::string prompt=format_messages(messages);
            std::vector<llama_token> tokens(kContext);
            int count=llama_tokenize(model,prompt.data(),int(prompt.size()),tokens.data(),int(tokens.size()),false,true);
            if(count<=0||count+maximum>kContext)throw std::runtime_error("prompt_context_limit");
            tokens.resize(count);input_tokens=count;
            std::vector<llama_token> wanted=use_cache?system_prefix(messages,model,tokens):std::vector<llama_token>();
            int cursor=0;
            if(!wanted.empty()&&cached==wanted&&llama_kv_cache_seq_rm(ctx,0,int(cached.size()),-1)){
                cache_hit=true;cursor=int(cached.size());reused=cursor;
            }else{
                llama_kv_cache_clear(ctx);cached.clear();
                if(!wanted.empty()){
                    status=prefill_range(ctx,batch,tokens,0,int(wanted.size()));cursor=int(wanted.size());
                    if(status=="complete")cached=wanted;
                }
            }
            if(status=="complete")status=prefill_range(ctx,batch,tokens,cursor,count);
            prefill=now()-start;
            sampler=llama_sampler_init_greedy();
            for(int i=0;i<maximum&&status=="complete";++i){
                if(abort_decode(nullptr)){status=cancelled.load()?"cancelled":"deadline";break;}
                llama_token token=llama_sampler_sample(sampler,ctx,-1);llama_sampler_accept(sampler,token);
                if(llama_token_is_eog(model,token)){finish="eos";break;}
                char piece[512];int length=llama_token_to_piece(model,token,piece,sizeof(piece),0,false);
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
        if(!use_cache){llama_kv_cache_clear(ctx);cached.clear();}
        else retain_system_prefix(ctx,cached);
        if(status!="complete")finish=status;
        {std::lock_guard<std::mutex> lock(state_mutex);working=false;active_id.clear();}
        send({{"type","done"},{"id",id},{"status",status},{"finish_reason",finish},{"text",reply},
              {"input_tokens",input_tokens},{"generated_tokens",generated},{"first_token_seconds",first},
              {"prefill_seconds",prefill},{"total_seconds",now()-start},{"max_rss_kib",rss()},
              {"cached_prefix_tokens",cached.size()},{"prefix_tokens_reused",reused},{"prefix_cache_hit",cache_hit},
              {"prefix_cache_requested",use_cache},{"retained_kv_cells",llama_get_kv_cache_used_cells(ctx)},
              {"user_suffix_retained",false},{"gpu_used",false},{"intent",nullptr},{"history_persisted",false}});
    }
    llama_batch_free(batch);
}
int main(int argc,char **argv){
    if(argc==2&&!std::strcmp(argv[1],"--help")){
        std::puts("llm-worker MODEL_GGUF [threads=2]; private JSONL generate/messages or text, prepare_system(system only, zero generated tokens, <=20s), clear_history(system prefix retained), clear_cache(all removed), ping, cancel, quit. Qwen2.5 b3927 CPU ARMv7; context1024; 12messages/8192B; output<=96tokens; deadline<=30s.");return 0;}
    if(argc<2||argc>3)return 2;int threads=argc>2?std::atoi(argv[2]):2;if(threads<1||threads>4)return 2;
    pid_t parent=getppid();if(prctl(PR_SET_PDEATHSIG,SIGTERM)!=0||getppid()!=parent)return 2;
    rlimit core{0,0};setrlimit(RLIMIT_CORE,&core);
    llama_log_set([](ggml_log_level level,const char *message,void*){
        if(level>=GGML_LOG_LEVEL_WARN)std::fwrite(message,1,std::min(std::strlen(message),size_t(2048)),stderr);},nullptr);
    double start=now();llama_backend_init();llama_model_params mp=llama_model_default_params();mp.n_gpu_layers=0;mp.use_mmap=true;mp.use_mlock=false;
    llama_model *model=llama_load_model_from_file(argv[1],mp);if(!model)return 3;
    char arch[64];llama_model_meta_val_str(model,"general.architecture",arch,sizeof(arch));
    if(std::strcmp(arch,"qwen2")!=0){llama_free_model(model);return 3;}
    llama_context_params cp=llama_context_default_params();cp.n_ctx=kContext;cp.n_batch=32;cp.n_ubatch=32;cp.n_seq_max=1;
    cp.n_threads=threads;cp.n_threads_batch=threads;cp.offload_kqv=false;
    cp.abort_callback=abort_decode;stop_at=now()+60;llama_context *ctx=llama_new_context_with_model(model,cp);
    if(!ctx){llama_free_model(model);return 3;}
    send({{"type","ready"},{"model_load_seconds",now()-start},{"model_load_count",1},{"backend","CPU_ARMV7_NEON"},
          {"gpu_used",false},{"threads",threads},{"context_tokens",kContext},{"max_messages",12},
          {"message_bytes_limit",8192},{"max_generated_tokens",96},{"max_deadline_ms",30000},{"max_rss_kib",rss()},
          {"explicit_messages_supported",true},{"clear_history_supported",true},{"prepare_system_supported",true},
          {"engine_tag","b3927"},{"engine_pin","10433e8b457c4cfd759cbb41fc55fc398db4a5da"},
          {"model_id","Qwen2.5-0.5B-Instruct-Q4_0"},{"expected_model_sha256","7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed"},
          {"expected_model_bytes",428730208},
          {"model_hash_validated_by_worker",false},{"prefix_cache_scope","exact system plus user-role im_start boundary"}});
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
            if(op=="ping"){std::lock_guard<std::mutex> lock(state_mutex);send({{"type","pong"},{"id",id},{"working",working||queued},
                {"queued_request_retained",!pending.is_null()},{"model_load_count",1},{"max_rss_kib",rss()}});continue;}
            if(op=="cancel"){std::lock_guard<std::mutex> lock(state_mutex);if(id==active_id)cancelled.store(true);send({{"type","cancel_ack"},{"id",id}});continue;}
            if(op=="clear_cache"||op=="clear_history"){
                if(job.size()!=2)throw std::runtime_error("unexpected_fields");
                std::lock_guard<std::mutex> lock(state_mutex);if(clear_pending)throw std::runtime_error("busy");
                clear_pending=true;clear_all_pending=op=="clear_cache";clear_id=id;if(working)cancelled.store(true);
                if(queued){send({{"type",pending["op"]=="prepare_system"?"system_prepared":"done"},{"id",pending["id"]},
                    {"status","cancelled"},{"generated_tokens",0},{"text",""}});queued=false;pending=Json();active_id.clear();}
                changed.notify_one();continue;
            }
            if(op=="quit"){send({{"type","bye"},{"id",id}});break;}
            if(op=="prepare_system"){
                for(auto it=job.begin();it!=job.end();++it)if(it.key()!="op"&&it.key()!="id"&&it.key()!="system"&&it.key()!="deadline_ms")throw std::runtime_error("unexpected_fields");
                if(!job.contains("system")||!job["system"].is_string())throw std::runtime_error("invalid_system");
                validate_system(job["system"].get<std::string>());
                if(job.contains("deadline_ms")&&!job["deadline_ms"].is_number_integer())throw std::runtime_error("generation_limit");
                int deadline=job.value("deadline_ms",20000);if(deadline<100||deadline>20000)throw std::runtime_error("generation_limit");
                {std::lock_guard<std::mutex> lock(state_mutex);if(working||queued)throw std::runtime_error("busy");
                    pending=std::move(job);queued=true;active_id=id;cancelled.store(false);changed.notify_one();}
                continue;
            }
            if(op!="generate")throw std::runtime_error("forbidden_operation");
            for(auto it=job.begin();it!=job.end();++it)if(it.key()!="op"&&it.key()!="id"&&it.key()!="messages"&&it.key()!="text"&&it.key()!="max_tokens"&&it.key()!="deadline_ms"&&it.key()!="use_prefix_cache")throw std::runtime_error("unexpected_fields");
            format_messages(request_messages(job));
            if((job.contains("max_tokens")&&!job["max_tokens"].is_number_integer())||(job.contains("deadline_ms")&&!job["deadline_ms"].is_number_integer()))throw std::runtime_error("generation_limit");
            if(job.contains("use_prefix_cache")&&!job["use_prefix_cache"].is_boolean())throw std::runtime_error("generation_limit");
            int maximum=job.value("max_tokens",96),deadline=job.value("deadline_ms",30000);
            if(maximum<1||maximum>96||deadline<100||deadline>30000)throw std::runtime_error("generation_limit");
            {std::lock_guard<std::mutex> lock(state_mutex);if(working||queued)throw std::runtime_error("busy");
                pending=std::move(job);queued=true;active_id=id;cancelled.store(false);changed.notify_one();}
        }catch(const std::exception &error){
            std::string code=error.what();
            static const std::vector<std::string> allowed={"invalid_id","invalid_messages","invalid_system","conflicting_input","message_bytes_limit","template_marker_rejected","invalid_roles","last_role_must_be_user","forbidden_operation","unexpected_fields","generation_limit","busy"};
            if(std::find(allowed.begin(),allowed.end(),code)==allowed.end())code="invalid_json_or_type";
            send({{"type","error"},{"code",code}});
        }
    }
    {std::lock_guard<std::mutex> lock(state_mutex);stopping=true;cancelled.store(true);changed.notify_one();}
    worker.join();llama_free(ctx);llama_free_model(model);llama_backend_free();return 0;
}
