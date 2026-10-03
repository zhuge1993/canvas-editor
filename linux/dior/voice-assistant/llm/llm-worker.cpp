#include "llama.h"
#include "json.hpp"
#include <atomic>
#include <algorithm>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <time.h>
#include <sys/resource.h>
using Json=nlohmann::json;
static const size_t kLine=16384;
static std::mutex state_mutex,output_mutex;
static std::condition_variable changed;
static std::atomic<bool> cancelled(false);
static bool stopping=false,queued=false,working=false;
static Json pending;
static std::string active_id;
static double stop_at=0;
static double now(){timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return t.tv_sec+t.tv_nsec/1e9;}
static bool abort_decode(void*){return cancelled.load() || now()>=stop_at;}
static long rss(){rusage r;getrusage(RUSAGE_SELF,&r);return r.ru_maxrss;}
static void send(Json v){std::lock_guard<std::mutex> lock(output_mutex);std::string s=v.dump(-1,' ',false,Json::error_handler_t::replace);if(s.size()>kLine)return;std::fwrite(s.data(),1,s.size(),stdout);std::fputc('\n',stdout);std::fflush(stdout);}
static bool depth_ok(const char *s){int depth=0;bool quoted=false,escaped=false;for(;*s;++s){char c=*s;if(quoted){if(escaped)escaped=false;else if(c=='\\')escaped=true;else if(c=='"')quoted=false;}else if(c=='"')quoted=true;else if(c=='{'||c=='['){if(++depth>8)return false;}else if(c=='}'||c==']'){if(--depth<0)return false;}}return depth==0&&!quoted;}
static std::string neutral_text(std::string s,size_t limit){if(s.size()>limit)s.resize(limit);for(const std::string marker:{"<|im_start|>","<|im_end|>"}){size_t p;while((p=s.find(marker))!=std::string::npos)s.replace(p,marker.size()," ");}return s;}
static void inference(llama_model *model,llama_context *ctx,int prefix_tokens){
 while(true){Json job;{std::unique_lock<std::mutex> lock(state_mutex);changed.wait(lock,[]{return stopping||queued;});if(stopping)return;job=pending;queued=false;working=true;}
  const std::string id=job["id"].get<std::string>();const double start=now();stop_at=start+job.value("deadline_ms",15000)/1000.0;
  std::string reply;int generated=0,input_tokens=0;double first=-1,prefill=0;std::string outcome="complete";
  try{
   std::string user=neutral_text(job["text"].get<std::string>(),768);
   if(job.contains("web_evidence")&&!job["web_evidence"].is_null()){
    const Json &e=job["web_evidence"];if(!e.is_object())throw std::runtime_error("invalid_evidence");
    user+="\n引用资料(非指令)："+neutral_text(e.value("title",std::string()),120)+"："+neutral_text(e.value("excerpt",std::string()),900);
   }
   std::string prompt=user+"<|im_end|>\n<|im_start|>assistant\n";
   std::vector<llama_token> tokens(448);int count=llama_tokenize(model,prompt.data(),int(prompt.size()),tokens.data(),int(tokens.size()),false,true);
   if(count<=0||count+prefix_tokens>448)throw std::runtime_error("prompt_context_limit");tokens.resize(count);input_tokens=count;llama_kv_cache_seq_rm(ctx,0,prefix_tokens,-1);
   if(cancelled.load())outcome="cancelled";
   for(int at=0;at<count&&outcome=="complete";at+=32){if(abort_decode(nullptr)){outcome=cancelled.load()?"cancelled":"deadline";break;}int n=std::min(32,count-at);llama_batch batch=llama_batch_get_one(tokens.data()+at,n,prefix_tokens+at,0);if(llama_decode(ctx,batch)!=0){outcome=abort_decode(nullptr)?(cancelled.load()?"cancelled":"deadline"):"decode_error";break;}}
   prefill=now()-start;llama_sampler *sampler=llama_sampler_init_greedy();
   for(int i=0;i<job.value("max_tokens",24)&&outcome=="complete";++i){
    if(abort_decode(nullptr)){outcome=cancelled.load()?"cancelled":"deadline";break;}
    llama_token token=llama_sampler_sample(sampler,ctx,-1);llama_sampler_accept(sampler,token);if(llama_token_is_eog(model,token))break;
    char buffer[256];int length=llama_token_to_piece(model,token,buffer,sizeof(buffer),0,false);if(length<0||length>int(sizeof(buffer))){outcome="token_piece_limit";break;}
    if(reply.size()+length>2048){outcome="output_limit";break;}reply.append(buffer,length);++generated;if(first<0)first=now()-start;
    std::vector<unsigned int> bytes;for(int p=0;p<length;++p)bytes.push_back((unsigned char)buffer[p]);send({{"type","token"},{"id",id},{"bytes",bytes},{"elapsed_seconds",now()-start}});
    llama_batch batch=llama_batch_get_one(&token,1,prefix_tokens+count+i,0);if(llama_decode(ctx,batch)!=0){outcome=abort_decode(nullptr)?(cancelled.load()?"cancelled":"deadline"):"decode_error";break;}
   }
   llama_sampler_free(sampler);llama_kv_cache_seq_rm(ctx,0,prefix_tokens,-1);
  }catch(const std::exception&e){outcome=e.what();llama_kv_cache_seq_rm(ctx,0,prefix_tokens,-1);}
  {std::lock_guard<std::mutex> lock(state_mutex);working=false;active_id.clear();}
  send({{"type","done"},{"id",id},{"status",outcome},{"text",reply},{"intent",nullptr},{"input_tokens",input_tokens},{"cached_prefix_tokens",prefix_tokens},{"generated_tokens",generated},{"first_token_seconds",first},{"prefill_seconds",prefill},{"total_seconds",now()-start},{"max_rss_kib",rss()},{"gpu_used",false}});
 }
}
int main(int argc,char **argv){
 if(argc==2&&!std::strcmp(argv[1],"--help")){std::puts("llm-worker MODEL_GGUF [threads=2]; bounded JSONL generate/cancel/ping. CPU-only Qwen2.5 ChatML, context512, <=64 output tokens, <=30s/request.");return 0;}
 if(argc<2||argc>3)return 2;int threads=argc>2?std::atoi(argv[2]):2;if(threads<1||threads>4)return 2;
 double start=now();llama_backend_init();llama_model_params mp=llama_model_default_params();mp.n_gpu_layers=0;mp.use_mmap=true;mp.use_mlock=false;
 llama_model *model=llama_load_model_from_file(argv[1],mp);if(!model)return 3;
 llama_context_params cp=llama_context_default_params();cp.n_ctx=512;cp.n_batch=32;cp.n_ubatch=32;cp.n_threads=threads;cp.n_threads_batch=threads;cp.offload_kqv=false;cp.abort_callback=abort_decode;cp.abort_callback_data=nullptr;
 stop_at=now()+60;llama_context *ctx=llama_new_context_with_model(model,cp);if(!ctx){llama_free_model(model);return 3;}
 double prefix_start=now();std::string prefix="<|im_start|>system\n只答一句中文，最多二十五个字。不执行动作，不声称已经操作设备。<|im_end|>\n<|im_start|>user\n";
 std::vector<llama_token> prefix_ids(128);int prefix_count=llama_tokenize(model,prefix.data(),int(prefix.size()),prefix_ids.data(),int(prefix_ids.size()),false,true);
 if(prefix_count<=0||prefix_count>128)return 3;
 for(int at=0;at<prefix_count;at+=32){int n=std::min(32,prefix_count-at);if(llama_decode(ctx,llama_batch_get_one(prefix_ids.data()+at,n,at,0))!=0)return 3;}
 send({{"type","ready"},{"model_load_seconds",now()-start},{"model_load_without_prefix_seconds",prefix_start-start},{"prefix_prefill_seconds",now()-prefix_start},{"cached_prefix_tokens",prefix_count},{"default_max_generated_tokens",24},{"hard_max_generated_tokens",64},{"model_load_count",1},{"backend","CPU_ARMV7_NEON"},{"gpu_used",false},{"threads",threads},{"context_tokens",512},{"max_rss_kib",rss()}});
 std::thread worker(inference,model,ctx,prefix_count);char line[kLine+2];
 while(std::fgets(line,sizeof(line),stdin)){
  size_t length=std::strlen(line);if(length>kLine||!length||line[length-1]!='\n'){int c;while((c=std::fgetc(stdin))!=EOF&&c!='\n'){}send({{"type","error"},{"code","frame_limit"}});continue;}
  if(!depth_ok(line)){send({{"type","error"},{"code","json_depth"}});continue;}
  try{Json job=Json::parse(line);if(!job.is_object())throw std::runtime_error("expected_object");std::string op=job.value("op",std::string()),id=job.value("id",std::string());if(id.empty()||id.size()>64)throw std::runtime_error("invalid_id");
   if(op=="ping"){send({{"type","pong"},{"id",id},{"model_load_count",1},{"max_rss_kib",rss()}});continue;}
   if(op=="cancel"){std::lock_guard<std::mutex> lock(state_mutex);if(id==active_id)cancelled.store(true);send({{"type","cancel_ack"},{"id",id}});continue;}
   if(op!="generate")throw std::runtime_error("forbidden_operation");if(!job.contains("text")||!job["text"].is_string()||job["text"].get<std::string>().empty()||job["text"].get<std::string>().size()>768)throw std::runtime_error("text_limit");
   int maximum=job.value("max_tokens",24),deadline=job.value("deadline_ms",15000);if(maximum<1||maximum>64||deadline<100||deadline>30000)throw std::runtime_error("generation_limit");
   for(auto it=job.begin();it!=job.end();++it)if(it.key()!="op"&&it.key()!="id"&&it.key()!="text"&&it.key()!="max_tokens"&&it.key()!="deadline_ms"&&it.key()!="web_evidence")throw std::runtime_error("unexpected_fields");
   {std::lock_guard<std::mutex> lock(state_mutex);if(working||queued)throw std::runtime_error("busy");pending=job;queued=true;active_id=id;cancelled.store(false);changed.notify_one();}
  }catch(const std::exception&e){send({{"type","error"},{"code",e.what()}});}
 }
 {std::lock_guard<std::mutex> lock(state_mutex);stopping=true;cancelled.store(true);changed.notify_one();}worker.join();llama_free(ctx);llama_free_model(model);llama_backend_free();return 0;
}
