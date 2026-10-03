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
 X(clGetSupportedImageFormats) X(clCreateImage2D) X(clEnqueueWriteImage) \
 X(clCreateProgramWithSource) X(clBuildProgram) X(clGetProgramBuildInfo) X(clCreateKernel) X(clGetKernelWorkGroupInfo) X(clCreateBuffer) X(clSetKernelArg) \
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
 "__constant sampler_t s=CLK_NORMALIZED_COORDS_FALSE|CLK_ADDRESS_CLAMP_TO_EDGE|CLK_FILTER_NEAREST;"
 "__kernel void image_dot(read_only image2d_t w,read_only image2d_t x,__global float*y,int K,int M,int N){"
 "int row=(int)get_global_id(0),token=(int)get_global_id(1);if(row<M&&token<N){float sum=0.0f;"
 "for(int p=0;p<K/4;++p){float4 a=read_imagef(w,s,(int2)(p,row));float4 b=read_imagef(x,s,(int2)(p,token));sum+=dot(a,b);}"
 "y[token*M+row]=sum;}}";
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
                       {"inputs_are_synthetic_not_model_activation",true},{"candidate","opt2_RGBA_FLOAT_image2D_dot_float4"},
                       {"kernel_tuning_sweep_performed",false},{"GPU_weight_storage","CL_RGBA CL_FLOAT IMAGE2D 224x896"}});
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
        cl_bool image_support=0;size_t max_width=0,max_height=0;cl_uint read_images=0;
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_IMAGE_SUPPORT,sizeof(image_support),&image_support,nullptr),"cap_image_support");
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_IMAGE2D_MAX_WIDTH,sizeof(max_width),&max_width,nullptr),"cap_image_width");
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_IMAGE2D_MAX_HEIGHT,sizeof(max_height),&max_height,nullptr),"cap_image_height");
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_MAX_READ_IMAGE_ARGS,sizeof(read_images),&read_images,nullptr),"cap_read_images");
        result["image_caps"]={{"supported",bool(image_support)},{"max_width",max_width},{"max_height",max_height},{"max_read_args",read_images}};
        require(image_support&&max_width>=K/4&&max_height>=M&&max_height>=size_t(n)&&read_images>=2,"FAIL_CAPABILITY_image2D");
        cl_int error=0;gpu.context=gpu.api.clCreateContext(nullptr,1,&gpu.device,nullptr,nullptr,&error);check(error,"context");require(gpu.context,"context_null");
        cl_uint format_count=0;check(gpu.api.clGetSupportedImageFormats(gpu.context,CL_MEM_READ_ONLY,CL_MEM_OBJECT_IMAGE2D,0,nullptr,&format_count),"cap_format_count");
        require(format_count>0&&format_count<=256,"FAIL_CAPABILITY_format_bound");std::vector<cl_image_format> formats(format_count);
        check(gpu.api.clGetSupportedImageFormats(gpu.context,CL_MEM_READ_ONLY,CL_MEM_OBJECT_IMAGE2D,format_count,formats.data(),nullptr),"cap_formats");
        bool rgba_float=false;Json listed=Json::array();for(auto f:formats){listed.push_back({{"channel_order",f.image_channel_order},{"channel_type",f.image_channel_data_type}});if(f.image_channel_order==CL_RGBA&&f.image_channel_data_type==CL_FLOAT)rgba_float=true;}
        result["image_caps"]["read_only_image2D_formats"]=listed;result["image_caps"]["CL_RGBA_CL_FLOAT"]=rgba_float;require(rgba_float,"FAIL_CAPABILITY_RGBA_FLOAT_image");
        gpu.queue=gpu.api.clCreateCommandQueue(gpu.context,gpu.device,CL_QUEUE_PROFILING_ENABLE,&error);check(error,"queue");require(gpu.queue,"queue_null");
        size_t len=std::strlen(KERNEL);gpu.program=gpu.api.clCreateProgramWithSource(gpu.context,1,&KERNEL,&len,&error);check(error,"program");
        double build=now();error=gpu.api.clBuildProgram(gpu.program,1,&gpu.device,"",nullptr,nullptr);
        result["program_build_ms"]=(now()-build)*1000;result["kernel_source_bytes"]=len;result["build_options"]="device default OpenCL C 1.x; no CL2/subgroups/FP16";
        size_t logn=0;gpu.api.clGetProgramBuildInfo(gpu.program,gpu.device,CL_PROGRAM_BUILD_LOG,0,nullptr,&logn);
        if(logn&&logn<=4096){std::vector<char> log(logn+1,0);gpu.api.clGetProgramBuildInfo(gpu.program,gpu.device,CL_PROGRAM_BUILD_LOG,logn,log.data(),nullptr);result["build_log"]=log.data();}
        check(error,"kernel_build");gpu.kernel=gpu.api.clCreateKernel(gpu.program,"image_dot",&error);check(error,"kernel");
        size_t device_group=0,kernel_group=0,max_items[3]={};cl_uint dimensions=0;
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_MAX_WORK_GROUP_SIZE,sizeof(device_group),&device_group,nullptr),"cap_group");
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_MAX_WORK_ITEM_DIMENSIONS,sizeof(dimensions),&dimensions,nullptr),"cap_dimensions");require(dimensions==3,"FAIL_CAPABILITY_work_dimensions");
        check(gpu.api.clGetDeviceInfo(gpu.device,CL_DEVICE_MAX_WORK_ITEM_SIZES,sizeof(max_items),max_items,nullptr),"cap_work_items");
        check(gpu.api.clGetKernelWorkGroupInfo(gpu.kernel,gpu.device,CL_KERNEL_WORK_GROUP_SIZE,sizeof(kernel_group),&kernel_group,nullptr),"cap_kernel_group");
        size_t group_limit=std::min(device_group,kernel_group),layout[2]={0,0};std::string layout_name="vendor";
        if(n==32){require(group_limit>=64&&max_items[0]>=16&&max_items[1]>=4,"FAIL_CAPABILITY_image_workgroup");layout[0]=16;layout[1]=group_limit>=128&&max_items[1]>=8?8:4;layout_name=layout[1]==8?"16x8":"16x4";}
        else if(group_limit>=64&&max_items[0]>=64){layout[0]=64;layout[1]=1;layout_name="64x1";}
        result["workgroup_caps"]={{"device_max",device_group},{"kernel_max",kernel_group},{"max_items",{max_items[0],max_items[1],max_items[2]}},{"selected_layout",layout_name},{"one_layout_only",true}};
        cl_image_format image_format{CL_RGBA,CL_FLOAT};
        gpu.w=gpu.api.clCreateImage2D(gpu.context,CL_MEM_READ_ONLY,&image_format,K/4,M,0,nullptr,&error);check(error,"weight_image");
        gpu.x=gpu.api.clCreateImage2D(gpu.context,CL_MEM_READ_ONLY,&image_format,K/4,n,0,nullptr,&error);check(error,"input_image");
        gpu.y=gpu.api.clCreateBuffer(gpu.context,CL_MEM_READ_WRITE,ybytes,nullptr,&error);check(error,"output_buffer");
        int ik=K,im=M;check(gpu.api.clSetKernelArg(gpu.kernel,0,sizeof(gpu.w),&gpu.w),"arg_weight");check(gpu.api.clSetKernelArg(gpu.kernel,1,sizeof(gpu.x),&gpu.x),"arg_input");
        check(gpu.api.clSetKernelArg(gpu.kernel,2,sizeof(gpu.y),&gpu.y),"arg_output");check(gpu.api.clSetKernelArg(gpu.kernel,3,sizeof(ik),&ik),"arg_K");
        check(gpu.api.clSetKernelArg(gpu.kernel,4,sizeof(im),&im),"arg_M");check(gpu.api.clSetKernelArg(gpu.kernel,5,sizeof(n),&n),"arg_N");
        const size_t origin[3]={0,0,0},weight_region[3]={K/4,M,1},input_region[3]={K/4,size_t(n),1};
        double upload=now();check(gpu.api.clEnqueueWriteImage(gpu.queue,gpu.w,CL_TRUE,origin,weight_region,0,0,fp.data(),0,nullptr,&gpu.pending),"weight_image_upload");
        result["weight_upload_wall_ms"]=(now()-upload)*1000;result["weight_upload_event_ms"]=gpu.event_ms();result["gpu_setup_plus_weight_upload_ms"]=(now()-setup)*1000;
        std::vector<float> got(count),poison(count,NAN);Json rounds=Json::array();bool passed=true;
        for(int i=0;i<3;++i){
            check(gpu.api.clEnqueueWriteBuffer(gpu.queue,gpu.y,CL_TRUE,0,ybytes,poison.data(),0,nullptr,nullptr),"poison_output");
            double start=now();Json round={{"number",i+1},{"weight_reuploaded",false}};
            check(gpu.api.clEnqueueWriteImage(gpu.queue,gpu.x,CL_TRUE,origin,input_region,0,0,input.data(),0,nullptr,&gpu.pending),"input_image_upload");round["input_upload_event_ms"]=gpu.event_ms();
            const size_t global[2]={M,size_t(n)};check(gpu.api.clEnqueueNDRangeKernel(gpu.queue,gpu.kernel,2,nullptr,global,layout[0]?layout:nullptr,0,nullptr,&gpu.pending),"kernel_dispatch");round["gpu_kernel_event_ms"]=gpu.event_ms();
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
