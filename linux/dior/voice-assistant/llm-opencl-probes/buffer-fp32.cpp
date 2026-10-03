// Private operator qualification: one real Q4_0 weight, two batch sizes.
// No model generation, service control, recording, display or SDK writes.
#define CL_TARGET_OPENCL_VERSION 110
#include <CL/cl.h>
#include "ggml.h"
#include "json.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <dlfcn.h>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <time.h>
#include <unistd.h>
#include <vector>
using Json=nlohmann::json;
static constexpr size_t K=896,M=896,MAX_BATCH=32,QBYTES=451584;
static constexpr size_t GRAPH_BYTES=2*1024*1024;
static double now(){timespec t{};if(clock_gettime(CLOCK_MONOTONIC,&t))throw std::runtime_error("clock");return t.tv_sec+t.tv_nsec*1e-9;}
static void require(bool pass,const char *why){if(!pass)throw std::runtime_error(why);}
static void check(cl_int error,const char *what){if(error)throw std::runtime_error(std::string(what)+":"+std::to_string(error));}
template<typename T>static std::vector<T> file(const std::string &name,size_t count){
    std::ifstream f(name,std::ios::binary);require(bool(f),"fixture_open");
    std::vector<T> data(count);f.read(reinterpret_cast<char*>(data.data()),count*sizeof(T));require(size_t(f.gcount())==count*sizeof(T),"fixture_size");char extra;require(!f.read(&extra,1),"fixture_extra");return data;
}
struct ErrorMetric {double max_abs=0,rms=0;size_t nonfinite=0,mismatch=0;};
static ErrorMetric compare(const float *got,const float *reference,size_t count,bool tolerance){
    ErrorMetric m;double sum=0;
    for(size_t i=0;i<count;++i){if(!std::isfinite(got[i])||!std::isfinite(reference[i])){++m.nonfinite;++m.mismatch;continue;}
        double error=std::abs(double(got[i])-reference[i]);m.max_abs=std::max(m.max_abs,error);sum+=error*error;
        if(tolerance&&error>0.001+0.0002*std::abs(double(reference[i])))++m.mismatch;}
    m.rms=std::sqrt(sum/count);return m;
}
static Json metric(const ErrorMetric &m){return {{"max_absolute_error",m.max_abs},{"rms_error",m.rms},{"nonfinite",m.nonfinite},{"mismatched_elements",m.mismatch}};}
#define FUNCTIONS(X) X(clGetPlatformIDs) X(clGetDeviceIDs) X(clGetDeviceInfo) X(clCreateContext) X(clCreateCommandQueue) \
 X(clCreateProgramWithSource) X(clBuildProgram) X(clGetProgramBuildInfo) X(clCreateKernel) X(clCreateBuffer) X(clSetKernelArg) \
 X(clEnqueueWriteBuffer) X(clEnqueueNDRangeKernel) X(clEnqueueReadBuffer) X(clGetEventProfilingInfo) X(clWaitForEvents) \
 X(clReleaseEvent) X(clReleaseMemObject) X(clReleaseKernel) X(clReleaseProgram) X(clReleaseCommandQueue) X(clReleaseContext)
struct Api{
#define DECLARE(name) decltype(&name) name=nullptr;
 FUNCTIONS(DECLARE)
#undef DECLARE
};
struct Gpu{
    Api api;void *library=nullptr;cl_context context=nullptr;cl_command_queue queue=nullptr;cl_program program=nullptr;cl_kernel kernel=nullptr;
    cl_mem w=nullptr,x=nullptr,y=nullptr;cl_event pending=nullptr;cl_device_id device=nullptr;
    ~Gpu(){
        if(pending&&api.clReleaseEvent)api.clReleaseEvent(pending);
        if(y)api.clReleaseMemObject(y);if(x)api.clReleaseMemObject(x);if(w)api.clReleaseMemObject(w);
        if(kernel)api.clReleaseKernel(kernel);if(program)api.clReleaseProgram(program);
        if(queue)api.clReleaseCommandQueue(queue);if(context)api.clReleaseContext(context);if(library)dlclose(library);
    }
    void load(){
        library=dlopen("/opt/dior-android/system/vendor/lib/libOpenCL.so",RTLD_NOW|RTLD_LOCAL);require(library,"vendor_opencl_dlopen");
#define LOAD(name) api.name=reinterpret_cast<decltype(api.name)>(dlsym(library,#name));require(api.name,"missing_" #name);
        FUNCTIONS(LOAD)
#undef LOAD
        cl_uint pc=0;check(api.clGetPlatformIDs(0,nullptr,&pc),"platform_count");require(pc>0&&pc<=8,"platform_bound");
        std::vector<cl_platform_id> platforms(pc);check(api.clGetPlatformIDs(pc,platforms.data(),nullptr),"platforms");
        for(auto p:platforms){cl_uint dc=0;cl_int e=api.clGetDeviceIDs(p,CL_DEVICE_TYPE_GPU,0,nullptr,&dc);
            if(e==CL_DEVICE_NOT_FOUND)continue;check(e,"gpu_count");require(dc>0&&dc<=8,"gpu_bound");
            std::vector<cl_device_id> devices(dc);check(api.clGetDeviceIDs(p,CL_DEVICE_TYPE_GPU,dc,devices.data(),nullptr),"gpu_devices");
            for(auto d:devices){cl_device_type type=0;cl_bool available=0,compiler=0;
                check(api.clGetDeviceInfo(d,CL_DEVICE_TYPE,sizeof(type),&type,nullptr),"device_type");
                check(api.clGetDeviceInfo(d,CL_DEVICE_AVAILABLE,sizeof(available),&available,nullptr),"available");
                check(api.clGetDeviceInfo(d,CL_DEVICE_COMPILER_AVAILABLE,sizeof(compiler),&compiler,nullptr),"compiler");
                if(type==CL_DEVICE_TYPE_GPU&&available&&compiler){device=d;break;}}
            if(device)break;}
        require(device,"no_online_gpu_no_cpu_fallback");
    }
    std::string info(cl_device_info key){size_t n=0;check(api.clGetDeviceInfo(device,key,0,nullptr,&n),"device_info_size");require(n>0&&n<=4096,"device_info_bound");
        std::vector<char> text(n+1,0);check(api.clGetDeviceInfo(device,key,n,text.data(),nullptr),"device_info");return text.data();}
    double event_ms(){require(pending,"event_missing");check(api.clWaitForEvents(1,&pending),"event_wait");cl_ulong start=0,end=0;
        check(api.clGetEventProfilingInfo(pending,CL_PROFILING_COMMAND_START,sizeof(start),&start,nullptr),"profiling_start");
        check(api.clGetEventProfilingInfo(pending,CL_PROFILING_COMMAND_END,sizeof(end),&end,nullptr),"profiling_end");require(end>=start&&end>0,"profiling_range");
        check(api.clReleaseEvent(pending),"event_release");pending=nullptr;return double(end-start)/1e6;}
};
static const char *KERNEL=
 "__kernel void op(__global const float *w,__global const float *x,__global float *y,int K,int M,int N){"
 "int id=(int)get_global_id(0);if(id<M*N){int r=id%M,t=id/M;float sum=0.0f;"
 "for(int k=0;k<K;++k)sum+=w[r*K+k]*x[t*K+k];y[id]=sum;}}";
struct Context{ggml_context *p=nullptr;~Context(){if(p)ggml_free(p);}};
int main(int argc,char **argv){
    Json result={{"scope","Qwen2.5 real weight operator only; not model offload"},{"llm_acceleration_qualified",false},
                 {"gpu_requested",true},{"gpu_used",false},{"cpu_fallback_permitted",false},{"status","FAIL"}};
    try{
        require(argc==3,"usage_fixture_dir_batch");std::string dir=argv[1];int n=std::stoi(argv[2]);require(n==1||n==32,"batch_only_1_or_32");
        alarm(10);size_t count=M*size_t(n),fbytes=M*K*sizeof(float),xbytes=K*size_t(n)*sizeof(float),ybytes=count*sizeof(float);
        size_t explicit_peak=GRAPH_BYTES+QBYTES+fbytes+(K*MAX_BATCH+M*MAX_BATCH)*4+(fbytes+xbytes+ybytes)+ybytes*2;
        require(explicit_peak<=64*1024*1024,"explicit_buffer_budget");
        result.update({{"M",M},{"K",K},{"batch",n},{"tensor","blk.0.attn_q.weight"},{"ggml_type","Q4_0"},
                       {"explicit_planned_peak_bytes",explicit_peak},{"cpu_threads",2},{"gpu_math","Q4_0 dequantized to FP32 weights x original F32 activation"},
                       {"cpu_math","existing b3927 GGML Q4_0 x F32 MUL_MAT; internal Q8 activation dot path"},
                       {"reference_math","independent PC binary64 accumulation then F32 cast"},
                       {"inputs_are_synthetic_not_model_activation",true},{"kernel_is_unoptimized",true}});
        auto q4=file<unsigned char>(dir+"/weights.q4",QBYTES);
        auto input=file<float>(dir+"/inputs.f32",K*MAX_BATCH);
        auto ref=file<float>(dir+"/reference.f32",M*MAX_BATCH);
        Context ctx;ctx.p=ggml_init({GRAPH_BYTES,nullptr,false});require(ctx.p,"ggml_context");
        auto *w=ggml_new_tensor_2d(ctx.p,GGML_TYPE_Q4_0,K,M);auto *x=ggml_new_tensor_2d(ctx.p,GGML_TYPE_F32,K,n);
        std::memcpy(w->data,q4.data(),QBYTES);std::memcpy(x->data,input.data(),xbytes);
        auto *y=ggml_mul_mat(ctx.p,w,x);auto *graph=ggml_new_graph_custom(ctx.p,16,false);ggml_build_forward_expand(graph,y);
        Json cpu_times=Json::array();
        for(int i=0;i<2;++i){double t=now();require(ggml_graph_compute_with_ctx(ctx.p,graph,2)==GGML_STATUS_SUCCESS,"ggml_compute");cpu_times.push_back((now()-t)*1000);}
        result["cpu_graph_compute_ms"]=cpu_times;auto cpu_error=compare(static_cast<float*>(y->data),ref.data(),count,false);require(cpu_error.nonfinite==0,"cpu_reference_nonfinite");result["cpu_quantized_difference_vs_reference"]=metric(cpu_error);
        auto cpu_values=std::vector<float>(static_cast<float*>(y->data),static_cast<float*>(y->data)+count);
        std::vector<float> fp(M*K);double dt=now();ggml_get_type_traits(GGML_TYPE_Q4_0)->to_float(q4.data(),fp.data(),M*K);
        result["host_q4_dequantize_ms"]=(now()-dt)*1000;
        Gpu gpu;double setup=now();gpu.load();std::string device_version=gpu.info(CL_DEVICE_VERSION);require(device_version.find("Adreno")!=std::string::npos&&device_version.find("305")!=std::string::npos,"expected_adreno305");result["device_name"]=gpu.info(CL_DEVICE_NAME);result["device_version"]=device_version;result["opencl_c_version"]=gpu.info(CL_DEVICE_OPENCL_C_VERSION);result["device_type"]=4;
        cl_int error=0;gpu.context=gpu.api.clCreateContext(nullptr,1,&gpu.device,nullptr,nullptr,&error);check(error,"context");require(gpu.context,"context_null");
        gpu.queue=gpu.api.clCreateCommandQueue(gpu.context,gpu.device,CL_QUEUE_PROFILING_ENABLE,&error);check(error,"queue");require(gpu.queue,"queue_null");
        size_t len=std::strlen(KERNEL);gpu.program=gpu.api.clCreateProgramWithSource(gpu.context,1,&KERNEL,&len,&error);check(error,"program");
        double build=now();error=gpu.api.clBuildProgram(gpu.program,1,&gpu.device,"",nullptr,nullptr);
        result["program_build_ms"]=(now()-build)*1000;result["kernel_source_bytes"]=len;result["build_options"]="device default OpenCL C 1.x; no CL2/subgroups/FP16";
        size_t logn=0;gpu.api.clGetProgramBuildInfo(gpu.program,gpu.device,CL_PROGRAM_BUILD_LOG,0,nullptr,&logn);
        if(logn&&logn<=4096){std::vector<char> log(logn+1,0);gpu.api.clGetProgramBuildInfo(gpu.program,gpu.device,CL_PROGRAM_BUILD_LOG,logn,log.data(),nullptr);result["build_log"]=log.data();}
        check(error,"kernel_build");gpu.kernel=gpu.api.clCreateKernel(gpu.program,"op",&error);check(error,"kernel");
        gpu.w=gpu.api.clCreateBuffer(gpu.context,CL_MEM_READ_ONLY,fbytes,nullptr,&error);check(error,"weight_buffer");
        gpu.x=gpu.api.clCreateBuffer(gpu.context,CL_MEM_READ_ONLY,xbytes,nullptr,&error);check(error,"input_buffer");
        gpu.y=gpu.api.clCreateBuffer(gpu.context,CL_MEM_READ_WRITE,ybytes,nullptr,&error);check(error,"output_buffer");
        int ik=K,im=M;check(gpu.api.clSetKernelArg(gpu.kernel,0,sizeof(gpu.w),&gpu.w),"arg_weight");check(gpu.api.clSetKernelArg(gpu.kernel,1,sizeof(gpu.x),&gpu.x),"arg_input");
        check(gpu.api.clSetKernelArg(gpu.kernel,2,sizeof(gpu.y),&gpu.y),"arg_output");check(gpu.api.clSetKernelArg(gpu.kernel,3,sizeof(ik),&ik),"arg_K");
        check(gpu.api.clSetKernelArg(gpu.kernel,4,sizeof(im),&im),"arg_M");check(gpu.api.clSetKernelArg(gpu.kernel,5,sizeof(n),&n),"arg_N");
        double upload=now();check(gpu.api.clEnqueueWriteBuffer(gpu.queue,gpu.w,CL_TRUE,0,fbytes,fp.data(),0,nullptr,&gpu.pending),"weight_upload");
        result["weight_upload_wall_ms"]=(now()-upload)*1000;result["weight_upload_event_ms"]=gpu.event_ms();result["gpu_setup_plus_weight_upload_ms"]=(now()-setup)*1000;
        std::vector<float> got(count),poison(count,NAN);Json rounds=Json::array();bool passed=true;
        for(int i=0;i<3;++i){
            check(gpu.api.clEnqueueWriteBuffer(gpu.queue,gpu.y,CL_TRUE,0,ybytes,poison.data(),0,nullptr,nullptr),"poison_output");
            double start=now();Json round={{"number",i+1},{"weight_reuploaded",false}};
            check(gpu.api.clEnqueueWriteBuffer(gpu.queue,gpu.x,CL_TRUE,0,xbytes,input.data(),0,nullptr,&gpu.pending),"input_upload");round["input_upload_event_ms"]=gpu.event_ms();
            size_t global=count;check(gpu.api.clEnqueueNDRangeKernel(gpu.queue,gpu.kernel,1,nullptr,&global,nullptr,0,nullptr,&gpu.pending),"kernel_dispatch");round["gpu_kernel_event_ms"]=gpu.event_ms();
            check(gpu.api.clEnqueueReadBuffer(gpu.queue,gpu.y,CL_TRUE,0,ybytes,got.data(),0,nullptr,&gpu.pending),"output_readback");round["readback_event_ms"]=gpu.event_ms();
            round["input_dispatch_readback_wall_ms"]=(now()-start)*1000;
            auto e=compare(got.data(),ref.data(),count,true);round["fp32_error_vs_pc_reference"]=metric(e);round["difference_vs_quantized_cpu"]=metric(compare(got.data(),cpu_values.data(),count,false));
            bool ok=e.mismatch==0&&e.nonfinite==0;round["pass"]=ok;passed=passed&&ok;rounds.push_back(round);
            if(i==0)result["gpu_cold_setup_upload_dispatch_readback_wall_ms"]=(now()-setup)*1000;
        }
        result["rounds"]=rounds;result["gpu_used"]=true;result["status"]=passed?"PASS_GPU_OPERATOR":"FAIL_GPU_OPERATOR_ACCURACY";
        result["speedup_claimed"]=false;result["math_paths_identical"]=false;result["absolute_tolerance"]=0.001;result["relative_tolerance"]=0.0002;
        result["gpu_library"]="/opt/dior-android/system/vendor/lib/libOpenCL.so";
        std::cout<<result.dump()<<"\n";return passed?0:2;
    }catch(const std::exception &error){result["error"]=error.what();std::cout<<result.dump()<<"\n";return 1;}
}
