#include "sherpa-ncnn/c-api/c-api.h"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include <ctime>
#include <cerrno>
#include <sys/resource.h>

static double now() { timespec t; if(clock_gettime(CLOCK_MONOTONIC,&t)) std::abort(); return double(t.tv_sec)+t.tv_nsec/1e9; }
static void until(double deadline) { for(;;){ double wait=deadline-now(); if(wait<=0) return; timespec t={time_t(wait),long((wait-std::floor(wait))*1e9)}; if(!nanosleep(&t,nullptr)) return; if(errno!=EINTR) return; } }
static uint32_t le32(const unsigned char*p){return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24);}
static uint16_t le16(const unsigned char*p){return uint16_t(p[0])|(uint16_t(p[1])<<8);}
static bool wave(const char*path,std::vector<float>&out){
 FILE*f=std::fopen(path,"rb"); if(!f){std::perror(path);return false;} std::fseek(f,0,SEEK_END);long size=std::ftell(f);std::rewind(f);
 if(size<44||size>16000*2*120+4096){std::fclose(f);return false;}std::vector<unsigned char>d(size);bool ok=std::fread(d.data(),1,d.size(),f)==d.size();std::fclose(f);
 if(!ok||std::memcmp(d.data(),"RIFF",4)||std::memcmp(d.data()+8,"WAVE",4))return false;
 bool fmt=false;size_t pcm=0,bytes=0;for(size_t p=12;p+8<=d.size();){uint32_t n=le32(d.data()+p+4);if(n>d.size()-p-8)return false;
 if(!std::memcmp(d.data()+p,"fmt ",4)){if(n<16)return false;auto q=d.data()+p+8;fmt=le16(q)==1&&le16(q+2)==1&&le32(q+4)==16000&&le16(q+14)==16;}
 else if(!std::memcmp(d.data()+p,"data",4)){pcm=p+8;bytes=n;}p+=8+n+(n&1);}
 if(!fmt||!pcm||!bytes||(bytes&1))return false;out.resize(bytes/2);for(size_t i=0;i<out.size();i++)out[i]=int16_t(le16(d.data()+pcm+i*2))/32768.f;return true;
}
static std::string js(const std::string&s){std::string o="\"";for(unsigned char c:s){if(c=='"'||c=='\\'){o+='\\';o+=char(c);}else if(c<32){char h[7];std::snprintf(h,sizeof(h),"\\u%04x",c);o+=h;}else o+=char(c);}return o+"\"";}
static std::string text(SherpaNcnnRecognizer*r,SherpaNcnnStream*s){auto result=GetResult(r,s);if(!result)return "";std::string t=result->text?result->text:"";DestroyResult(result);return t;}
int main(int argc,char**argv){
 if(argc==2&&!std::strcmp(argv[1],"--help")){std::puts("stream-benchmark MODEL_DIR WAV [threads=4] [repeat=1] [chunk_ms=200] [paced=0] [greedy_search|modified_beam_search] [beam=4] [hotwords_file|-] [endpoint=0]");return 0;}
 if(argc<3||argc>11)return 2;int threads=argc>3?std::atoi(argv[3]):4,repeat=argc>4?std::atoi(argv[4]):1,chunk_ms=argc>5?std::atoi(argv[5]):200,paced=argc>6?std::atoi(argv[6]):0,beam=argc>8?std::atoi(argv[8]):4,endpoint=argc>10?std::atoi(argv[10]):0;
 const char*method=argc>7?argv[7]:"greedy_search";
 if(threads<1||threads>4||repeat<1||repeat>5||chunk_ms<20||chunk_ms>1000||paced<0||paced>1||beam<1||beam>8||endpoint<0||endpoint>1||(endpoint&&!paced)||(std::strcmp(method,"greedy_search")&&std::strcmp(method,"modified_beam_search")))return 2;
 std::vector<float>samples;if(!wave(argv[2],samples)){std::fprintf(stderr,"Expected bounded PCM16 mono16kHz WAV\n");return 2;}
 std::string dir=argv[1],names[7]={dir+"/encoder_jit_trace-pnnx.ncnn.param",dir+"/encoder_jit_trace-pnnx.ncnn.bin",dir+"/decoder_jit_trace-pnnx.ncnn.param",dir+"/decoder_jit_trace-pnnx.ncnn.bin",dir+"/joiner_jit_trace-pnnx.ncnn.param",dir+"/joiner_jit_trace-pnnx.ncnn.bin",dir+"/tokens.txt"};
 SherpaNcnnRecognizerConfig cfg={};cfg.feat_config.sampling_rate=16000;cfg.feat_config.feature_dim=80;
 cfg.model_config.encoder_param=names[0].c_str();cfg.model_config.encoder_bin=names[1].c_str();cfg.model_config.decoder_param=names[2].c_str();cfg.model_config.decoder_bin=names[3].c_str();cfg.model_config.joiner_param=names[4].c_str();cfg.model_config.joiner_bin=names[5].c_str();cfg.model_config.tokens=names[6].c_str();cfg.model_config.use_vulkan_compute=0;cfg.model_config.num_threads=threads;
 cfg.decoder_config.decoding_method=method;cfg.decoder_config.num_active_paths=beam;cfg.enable_endpoint=endpoint;cfg.rule1_min_trailing_silence=2.4;cfg.rule2_min_trailing_silence=.4;cfg.rule3_min_utterance_length=120;cfg.hotwords_file=(argc>9&&std::strcmp(argv[9],"-"))?argv[9]:"";cfg.hotwords_score=1.5;
 double load_start=now();auto rec=CreateRecognizer(&cfg);double load_s=now()-load_start;if(!rec)return 3;
 std::printf("{\"type\":\"model\",\"version\":%s,\"git_sha1\":%s,\"backend\":\"CPU_NEON\",\"gpu_used\":false,\"model_load_seconds\":%.6f,\"threads\":%d,\"decode_method\":%s,\"beam\":%d}\n",js(SherpaNcnnGetVersionStr()).c_str(),js(SherpaNcnnGetGitSha1()).c_str(),load_s,threads,js(method).c_str(),beam);std::fflush(stdout);
 for(int run=1;run<=repeat;run++){
  auto stream=CreateStream(rec);if(!stream){DestroyRecognizer(rec);return 4;} double begin=now(),compute=0,max_block=0,first_partial=-1,first_audio=-1,last_accept=begin,last_endpoint=-1,first_endpoint=-1;std::string previous,completed;int chunk_samples=chunk_ms*16,blocks=0,decode_count=0,endpoints=0;std::vector<double>durations;
  for(size_t p=0;p<samples.size();p+=chunk_samples){size_t n=std::min(size_t(chunk_samples),samples.size()-p);double available=(p+n)/16000.;if(paced)until(begin+available);double start=now();last_accept=start;AcceptWaveform(stream,16000,samples.data()+p,int(n));while(IsReady(rec,stream)){Decode(rec,stream);decode_count++;}std::string t=text(rec,stream);double elapsed=now()-start;compute+=elapsed;max_block=std::max(max_block,elapsed);durations.push_back(elapsed);blocks++;
   if(t!=previous){if(first_partial<0&&!t.empty()){first_partial=now()-begin;first_audio=available;}previous=t;}
   std::printf("{\"type\":\"block\",\"run\":%d,\"block\":%d,\"audio_seen_seconds\":%.6f,\"process_seconds\":%.6f,\"wall_seconds\":%.6f,\"text\":%s}\n",run,blocks,available,elapsed,now()-begin,js(t).c_str());std::fflush(stdout);
   if(endpoint&&IsEndpoint(rec,stream)){double at=now()-begin;if(first_endpoint<0)first_endpoint=at;last_endpoint=at;endpoints++;completed+=t;std::printf("{\"type\":\"endpoint\",\"run\":%d,\"during_real_input\":true,\"endpoint_wall_seconds\":%.6f,\"audio_seen_seconds\":%.6f,\"segment_text\":%s}\n",run,at,available,js(t).c_str());std::fflush(stdout);Reset(rec,stream);previous.clear();}
  }
  double before_tail=now(),tail_s=0,audio=samples.size()/16000.,endpoint_from_deadline=-1;bool endpoint_timeout=false;std::string final;
  if(endpoint){
   std::vector<float>silence(chunk_samples,0);bool done=false;
   if(!completed.empty()&&text(rec,stream).empty()&&last_endpoint>=0){done=true;final=completed;endpoint_from_deadline=last_endpoint-audio;}
   for(int k=1;!done&&k*chunk_ms<=3000;k++){until(begin+audio+k*chunk_ms/1000.);double b=now();AcceptWaveform(stream,16000,silence.data(),chunk_samples);while(IsReady(rec,stream)){Decode(rec,stream);decode_count++;}tail_s+=now()-b;if(IsEndpoint(rec,stream)){last_endpoint=now()-begin;if(first_endpoint<0)first_endpoint=last_endpoint;endpoints++;endpoint_from_deadline=last_endpoint-audio;final=completed+text(rec,stream);done=true;}}
   if(!done){endpoint_timeout=true;InputFinished(stream);while(IsReady(rec,stream)){double b=now();Decode(rec,stream);tail_s+=now()-b;decode_count++;}final=completed+text(rec,stream);}
  }else{std::vector<float>tail(8000,0);AcceptWaveform(stream,16000,tail.data(),int(tail.size()));InputFinished(stream);while(IsReady(rec,stream)){Decode(rec,stream);decode_count++;}final=text(rec,stream);tail_s=now()-before_tail;}
  double end=now();compute+=tail_s;double wall=end-begin;rusage usage={};getrusage(RUSAGE_SELF,&usage);std::sort(durations.begin(),durations.end());size_t ix=durations.empty()?0:size_t(std::ceil(durations.size()*.95))-1;double p95=durations.empty()?0:durations[ix];
  std::printf("{\"type\":\"endpoint_summary\",\"run\":%d,\"enabled\":%s,\"rule2_min_trailing_silence_seconds\":0.4,\"silent_feed_bound_seconds\":3.0,\"first_endpoint_wall_seconds\":%.6f,\"last_endpoint_wall_seconds\":%.6f,\"final_endpoint_from_audio_deadline_seconds\":%.6f,\"endpoint_count\":%d,\"endpoint_timeout\":%s,\"text\":%s}\n",run,endpoint?"true":"false",first_endpoint,last_endpoint,endpoint_from_deadline,endpoints,endpoint_timeout?"true":"false",js(final).c_str());std::fflush(stdout);
  std::printf("{\"type\":\"result\",\"run\":%d,\"backend\":\"CPU_NEON\",\"gpu_used\":false,\"threads\":%d,\"paced\":%s,\"chunk_ms\":%d,\"audio_seconds\":%.6f,\"wall_seconds\":%.6f,\"processing_seconds\":%.6f,\"real_time_factor\":%.6f,\"first_partial_wall_seconds\":%.6f,\"first_partial_audio_seconds\":%.6f,\"last_audio_accepted_wall_s\":%.6f,\"final_result_wall_s\":%.6f,\"last_audio_accept_timing\":\"before_AcceptWaveform_final_real_chunk\",\"after_last_chunk_accept_seconds\":%.6f,\"after_audio_deadline_seconds\":%.6f,\"tail_processing_seconds\":%.6f,\"max_block_seconds\":%.6f,\"p95_block_seconds\":%.6f,\"blocks\":%d,\"decode_calls\":%d,\"max_rss_kib\":%ld,\"transcript\":%s}\n",run,threads,paced?"true":"false",chunk_ms,audio,wall,compute,compute/audio,first_partial,first_audio,last_accept-begin,wall,end-last_accept,paced?std::max(0.,wall-audio):-1.,tail_s,max_block,p95,blocks,decode_count,usage.ru_maxrss,js(final).c_str());std::fflush(stdout);DestroyStream(stream);
 }
 DestroyRecognizer(rec);return 0;
}
