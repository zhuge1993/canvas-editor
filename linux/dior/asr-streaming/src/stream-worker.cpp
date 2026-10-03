#include "sherpa-ncnn/c-api/c-api.h"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <string>
#include <vector>
#include <ctime>
#include <sys/resource.h>
#include <sys/stat.h>
using Json=nlohmann::json;
static const size_t kLineBytes=65536,kChunkSamples=16000,kSegmentSamples=480000;
static double now(){timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t))std::abort();return t.tv_sec+t.tv_nsec/1e9;}
static long rss(){rusage u={};getrusage(RUSAGE_SELF,&u);return u.ru_maxrss;}
static void send(const Json&v){std::string s=v.dump(-1,' ',false,Json::error_handler_t::replace);std::fwrite(s.data(),1,s.size(),stdout);std::fputc('\n',stdout);std::fflush(stdout);}
static bool sane_depth(const std::string&s){int depth=0;bool quoted=false,escaped=false;for(char c:s){if(quoted){if(escaped){escaped=false;continue;}if(c=='\\'){escaped=true;continue;}if(c=='"')quoted=false;continue;}if(c=='"')quoted=true;else if(c=='{'||c=='['){if(++depth>8)return false;}else if(c=='}'||c==']'){if(--depth<0)return false;}}return depth==0&&!quoted;}
static int value(char c){if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;if(c=='+')return 62;if(c=='/')return 63;return -1;}
static bool pcm(const std::string&encoded,std::vector<float>&out){
 if(encoded.empty()||encoded.size()>42668||(encoded.size()%4))return false;
 std::vector<unsigned char>bytes;bytes.reserve(encoded.size()/4*3);
 for(size_t i=0;i<encoded.size();i+=4){int a=value(encoded[i]),b=value(encoded[i+1]);if(a<0||b<0)return false;char c=encoded[i+2],d=encoded[i+3];bool last=i+4==encoded.size();
  if(c=='='){if(!last||d!='='||(b&15))return false;bytes.push_back((a<<2)|(b>>4));}
  else{int cc=value(c);if(cc<0)return false;bytes.push_back((a<<2)|(b>>4));bytes.push_back((b<<4)|(cc>>2));if(d=='='){if(!last||(cc&3))return false;}else{int dd=value(d);if(dd<0)return false;bytes.push_back((cc<<6)|dd);}}
 }
 if(bytes.empty()||(bytes.size()&1)||bytes.size()/2>kChunkSamples)return false;
 out.resize(bytes.size()/2);for(size_t i=0;i<out.size();i++)out[i]=int16_t(uint16_t(bytes[i*2])|(uint16_t(bytes[i*2+1])<<8))/32768.f;return true;
}
static std::string text(SherpaNcnnRecognizer*r,SherpaNcnnStream*s){auto a=GetResult(r,s);if(!a)return "";std::string t=a->text?a->text:"";DestroyResult(a);return t;}
int main(int argc,char**argv){
 if(argc==2&&!std::strcmp(argv[1],"--help")){std::puts("stream-worker MODEL_DIR [threads=2] [greedy_search|modified_beam_search] [beam=4] [endpoint=1]");std::puts("stdin JSON lines: {op:feed,id:string,pcm16_base64:string} | {op:finish/reset/ping/quit,id:string}; mono16k only, <=1s/chunk, <=30s/segment, <=64KiB/line. No audio files written.");return 0;}
 if(argc<2||argc>6)return 2;int threads=argc>2?std::atoi(argv[2]):2,beam=argc>4?std::atoi(argv[4]):4,endpoint=argc>5?std::atoi(argv[5]):1;const char*method=argc>3?argv[3]:"greedy_search";
 if(threads<1||threads>4||beam<1||beam>8||endpoint<0||endpoint>1||(std::strcmp(method,"greedy_search")&&std::strcmp(method,"modified_beam_search")))return 2;
 std::string dir=argv[1],names[7]={dir+"/encoder_jit_trace-pnnx.ncnn.param",dir+"/encoder_jit_trace-pnnx.ncnn.bin",dir+"/decoder_jit_trace-pnnx.ncnn.param",dir+"/decoder_jit_trace-pnnx.ncnn.bin",dir+"/joiner_jit_trace-pnnx.ncnn.param",dir+"/joiner_jit_trace-pnnx.ncnn.bin",dir+"/tokens.txt"};
 for(const auto&path:names){struct stat st={};if(stat(path.c_str(),&st)||!S_ISREG(st.st_mode)||st.st_size<=0||st.st_size>128*1024*1024){std::fprintf(stderr,"Invalid required model file: %s\n",path.c_str());return 2;}}
 SherpaNcnnRecognizerConfig cfg={};cfg.feat_config.sampling_rate=16000;cfg.feat_config.feature_dim=80;cfg.model_config.encoder_param=names[0].c_str();cfg.model_config.encoder_bin=names[1].c_str();cfg.model_config.decoder_param=names[2].c_str();cfg.model_config.decoder_bin=names[3].c_str();cfg.model_config.joiner_param=names[4].c_str();cfg.model_config.joiner_bin=names[5].c_str();cfg.model_config.tokens=names[6].c_str();cfg.model_config.use_vulkan_compute=0;cfg.model_config.num_threads=threads;cfg.decoder_config.decoding_method=method;cfg.decoder_config.num_active_paths=beam;cfg.enable_endpoint=endpoint;cfg.rule1_min_trailing_silence=2.4;cfg.rule2_min_trailing_silence=.4;cfg.rule3_min_utterance_length=25;cfg.hotwords_file="";cfg.hotwords_score=1.5;
 double load_begin=now();auto rec=CreateRecognizer(&cfg);double load_seconds=now()-load_begin;if(!rec)return 3;auto stream=CreateStream(rec);if(!stream){DestroyRecognizer(rec);return 3;}
 size_t seen=0;double segment_start=now(),total_process=0;int segment=1;bool used=false;
 send({{"type","ready"},{"protocol_version",1},{"source_commit","c794e1439fce79932e989220aa1c2848ecbdcdcf"},{"upstream_version",SherpaNcnnGetVersionStr()},{"upstream_release_sha",SherpaNcnnGetGitSha1()},{"backend","CPU_NEON_OPENMP"},{"gpu_used",false},{"model_dir",dir},{"model_load_seconds",load_seconds},{"threads",threads},{"decoding_method",method},{"beam",beam},{"endpoint_enabled",bool(endpoint)},{"endpoint_trailing_silence_seconds",.4},{"max_chunk_samples",kChunkSamples},{"max_segment_samples",kSegmentSamples},{"max_line_bytes",kLineBytes},{"max_rss_kib",rss()}});
 bool running=true;char buffer[kLineBytes+2];
 while(running&&std::fgets(buffer,sizeof(buffer),stdin)){
  size_t len=std::strlen(buffer);bool complete=len&&buffer[len-1]=='\n';if(!complete&&!std::feof(stdin)){int ch;while((ch=std::fgetc(stdin))!=EOF&&ch!='\n'){}send({{"type","error"},{"code","line_too_large"}});continue;}
  std::string line(buffer,len);if(line.size()>kLineBytes||!sane_depth(line)){send({{"type","error"},{"code","invalid_bounded_json"}});continue;}
  Json id=nullptr;
  try{
   Json request=Json::parse(line);if(!request.is_object()||!request.contains("op")||!request["op"].is_string())throw std::runtime_error("invalid_request");
   if(request.contains("id")){if(!request["id"].is_string()||request["id"].get<std::string>().size()>64)throw std::runtime_error("invalid_id");id=request["id"];}
   std::string op=request["op"].get<std::string>();
   if(op=="quit"){send({{"type","bye"},{"id",id},{"max_rss_kib",rss()}});running=false;continue;}
   if(op=="ping"){send({{"type","pong"},{"id",id},{"segment",segment},{"audio_seen_seconds",seen/16000.},{"max_rss_kib",rss()}});continue;}
   if(op=="reset"){DestroyStream(stream);stream=CreateStream(rec);if(!stream)throw std::runtime_error("stream_creation_failed");seen=0;total_process=0;used=false;segment++;segment_start=now();send({{"type","reset"},{"id",id},{"segment",segment},{"max_rss_kib",rss()}});continue;}
   bool final=false;std::string reason="partial";
   if(op=="feed"){
    if(!request.contains("pcm16_base64")||!request["pcm16_base64"].is_string())throw std::runtime_error("invalid_pcm16_base64");std::vector<float>samples;
    if(!pcm(request["pcm16_base64"].get<std::string>(),samples))throw std::runtime_error("invalid_pcm16_base64");if(seen+samples.size()>kSegmentSamples)throw std::runtime_error("segment_limit_finish_or_reset");if(!used){segment_start=now();used=true;}
    double begin=now();AcceptWaveform(stream,16000,samples.data(),int(samples.size()));while(IsReady(rec,stream))Decode(rec,stream);total_process+=now()-begin;seen+=samples.size();if(endpoint&&IsEndpoint(rec,stream)){final=true;reason="endpoint";}
   }else if(op=="finish"){
    double begin=now();std::vector<float>tail(8000,0);AcceptWaveform(stream,16000,tail.data(),int(tail.size()));InputFinished(stream);while(IsReady(rec,stream))Decode(rec,stream);total_process+=now()-begin;final=true;reason="explicit_eos";
   }else throw std::runtime_error("unknown_operation");
   send({{"type",final?"final":"partial"},{"id",id},{"segment",segment},{"reason",reason},{"text",text(rec,stream)},{"audio_seen_seconds",seen/16000.},{"segment_wall_seconds",now()-segment_start},{"processing_seconds",total_process},{"max_rss_kib",rss()}});
   if(final){DestroyStream(stream);stream=CreateStream(rec);if(!stream)throw std::runtime_error("stream_creation_failed");seen=0;total_process=0;used=false;segment++;segment_start=now();}
  }catch(const std::exception&e){send({{"type","error"},{"id",id},{"code",e.what()}});if(!stream)running=false;}
 }
 if(stream)DestroyStream(stream);DestroyRecognizer(rec);return 0;
}
