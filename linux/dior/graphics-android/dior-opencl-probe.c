/* Native Android/Bionic OpenCL 1.1 validation. No SDK or ICD loader is linked.
 * Run only as a separate, externally deadline-bound process. The private
 * Android linker/library environment is configured by the caller. This probe
 * never changes permissions, opens a display, or treats a CPU device as a GPU.
 */
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef int32_t cl_int;
typedef uint32_t cl_uint;
typedef uint32_t cl_bool;
typedef uint64_t cl_ulong;
typedef uint64_t cl_bitfield;
typedef cl_bitfield cl_device_type;
typedef cl_bitfield cl_mem_flags;
typedef cl_bitfield cl_command_queue_properties;
typedef intptr_t cl_context_properties;
typedef void *cl_platform_id;
typedef void *cl_device_id;
typedef void *cl_context;
typedef void *cl_command_queue;
typedef void *cl_program;
typedef void *cl_kernel;
typedef void *cl_mem;
typedef void *cl_event;
typedef void (*context_notify)(const char *, const void *, size_t, void *);
typedef void (*program_notify)(cl_program, void *);

#define CL_SUCCESS 0
#define CL_DEVICE_NOT_FOUND (-1)
#define CL_TRUE 1U
#define CL_DEVICE_TYPE_GPU UINT64_C(4)
#define CL_QUEUE_PROFILING_ENABLE UINT64_C(2)
#define CL_MEM_READ_WRITE UINT64_C(1)
#define CL_MEM_READ_ONLY UINT64_C(4)
#define CL_PLATFORM_PROFILE 0x0900U
#define CL_PLATFORM_VERSION 0x0901U
#define CL_PLATFORM_NAME 0x0902U
#define CL_PLATFORM_VENDOR 0x0903U
#define CL_DEVICE_TYPE 0x1000U
#define CL_DEVICE_MAX_COMPUTE_UNITS 0x1002U
#define CL_DEVICE_AVAILABLE 0x1027U
#define CL_DEVICE_COMPILER_AVAILABLE 0x1028U
#define CL_DEVICE_NAME 0x102BU
#define CL_DEVICE_VENDOR 0x102CU
#define CL_DRIVER_VERSION 0x102DU
#define CL_DEVICE_PROFILE 0x102EU
#define CL_DEVICE_VERSION 0x102FU
#define CL_DEVICE_EXTENSIONS 0x1030U
#define CL_CONTEXT_PLATFORM 0x1084U
#define CL_PROGRAM_BUILD_LOG 0x1183U
#define CL_PROFILING_COMMAND_START 0x1282U
#define CL_PROFILING_COMMAND_END 0x1283U

#define API_FUNCTIONS(X) \
    X(clGetPlatformIDs, cl_int, (cl_uint, cl_platform_id *, cl_uint *)) \
    X(clGetPlatformInfo, cl_int, (cl_platform_id, cl_uint, size_t, void *, size_t *)) \
    X(clGetDeviceIDs, cl_int, (cl_platform_id, cl_device_type, cl_uint, cl_device_id *, cl_uint *)) \
    X(clGetDeviceInfo, cl_int, (cl_device_id, cl_uint, size_t, void *, size_t *)) \
    X(clCreateContext, cl_context, (const cl_context_properties *, cl_uint, const cl_device_id *, context_notify, void *, cl_int *)) \
    X(clCreateCommandQueue, cl_command_queue, (cl_context, cl_device_id, cl_command_queue_properties, cl_int *)) \
    X(clCreateProgramWithSource, cl_program, (cl_context, cl_uint, const char **, const size_t *, cl_int *)) \
    X(clBuildProgram, cl_int, (cl_program, cl_uint, const cl_device_id *, const char *, program_notify, void *)) \
    X(clGetProgramBuildInfo, cl_int, (cl_program, cl_device_id, cl_uint, size_t, void *, size_t *)) \
    X(clCreateKernel, cl_kernel, (cl_program, const char *, cl_int *)) \
    X(clCreateBuffer, cl_mem, (cl_context, cl_mem_flags, size_t, void *, cl_int *)) \
    X(clSetKernelArg, cl_int, (cl_kernel, cl_uint, size_t, const void *)) \
    X(clEnqueueWriteBuffer, cl_int, (cl_command_queue, cl_mem, cl_bool, size_t, size_t, const void *, cl_uint, const cl_event *, cl_event *)) \
    X(clEnqueueNDRangeKernel, cl_int, (cl_command_queue, cl_kernel, cl_uint, const size_t *, const size_t *, const size_t *, cl_uint, const cl_event *, cl_event *)) \
    X(clEnqueueReadBuffer, cl_int, (cl_command_queue, cl_mem, cl_bool, size_t, size_t, void *, cl_uint, const cl_event *, cl_event *)) \
    X(clFinish, cl_int, (cl_command_queue)) \
    X(clGetEventProfilingInfo, cl_int, (cl_event, cl_uint, size_t, void *, size_t *)) \
    X(clReleaseEvent, cl_int, (cl_event)) \
    X(clReleaseMemObject, cl_int, (cl_mem)) \
    X(clReleaseKernel, cl_int, (cl_kernel)) \
    X(clReleaseProgram, cl_int, (cl_program)) \
    X(clReleaseCommandQueue, cl_int, (cl_command_queue)) \
    X(clReleaseContext, cl_int, (cl_context))

#define DECLARE_TYPE(name, result, arguments) typedef result (*fn_##name) arguments;
API_FUNCTIONS(DECLARE_TYPE)
#undef DECLARE_TYPE
struct opencl_api {
#define DECLARE_FIELD(name, result, arguments) fn_##name name;
    API_FUNCTIONS(DECLARE_FIELD)
#undef DECLARE_FIELD
};

struct round_result {
    unsigned int number;
    size_t mismatches;
    size_t first_mismatch;
    cl_int first_actual;
    cl_int first_expected;
    cl_int profiling_error;
    cl_ulong gpu_start_ns;
    cl_ulong gpu_end_ns;
    double transfer_and_dispatch_ms;
    int passed;
};

struct probe_result {
    const char *library_path;
    char operation[160];
    char error[768];
    char cleanup_error[768];
    cl_int error_code;
    cl_platform_id platform;
    cl_device_id device;
    cl_device_type device_type;
    cl_bool device_available;
    cl_bool compiler_available;
    cl_uint compute_units;
    char *platform_name;
    char *platform_vendor;
    char *platform_version;
    char *platform_profile;
    char *device_name;
    char *device_vendor;
    char *device_version;
    char *device_profile;
    char *driver_version;
    char *extensions;
    char *build_log;
    size_t elements;
    unsigned int iterations;
    unsigned int completed;
    struct round_result *rounds;
    int passed;
    int inventory_only;
    int inventory_pass;
};

static int trace_enabled;

static void trace_stage(const char *stage)
{
    const char prefix[] = "[dior-opencl] ";
    const char newline[] = "\n";
    if (!trace_enabled) return;
    (void)write(STDERR_FILENO, prefix, sizeof(prefix)-1);
    (void)write(STDERR_FILENO, stage, strlen(stage));
    (void)write(STDERR_FILENO, newline, sizeof(newline)-1);
}

/* GCC 4 supports these GNU expression extensions in -std=c99 mode. Evaluate
 * arguments once, and write both markers immediately even around pointer-return
 * functions. A signal inside a vendor API leaves its precise before marker. */
#define CL_CALL(name, ...) __extension__ ({ \
    __typeof__(api->name(__VA_ARGS__)) dior_call_value; \
    trace_stage("before " #name); \
    dior_call_value = api->name(__VA_ARGS__); \
    trace_stage("after " #name); \
    dior_call_value; \
})

static const char kernel_source[] =
    "__kernel void vector_fixture(__global const int *a,"
    " __global const int *b, __global int *out, const int n) {"
    " size_t i = get_global_id(0);"
    " if (i < (size_t)n) {"
    " int av = a[i]; int bv = b[i];"
    " out[i] = av * 3 + bv * 2 + (av ^ bv);"
    " }}";

static void failure(struct probe_result *result, const char *operation, cl_int code,
                    const char *description)
{
    if (result->error[0])
        return;
    snprintf(result->operation, sizeof(result->operation), "%s", operation);
    snprintf(result->error, sizeof(result->error), "%s", description ? description : "OpenCL operation failed");
    result->error_code = code;
    result->passed = 0;
}

static int check(struct probe_result *result, const char *operation, cl_int code)
{
    if (code == CL_SUCCESS)
        return 1;
    failure(result, operation, code, "OpenCL operation failed");
    return 0;
}

static int load_api(void *library_handle, struct opencl_api *api, struct probe_result *result)
{
#define LOAD_SYMBOL(name, result_type, arguments) do { \
        void *symbol; const char *loader_error; \
        trace_stage("before dlsym " #name); \
        dlerror(); symbol = dlsym(library_handle, #name); loader_error = dlerror(); \
        trace_stage("after dlsym " #name); \
        if (loader_error || !symbol || sizeof(api->name) != sizeof(symbol)) { \
            failure(result, "dlsym " #name, -10000, loader_error ? loader_error : "required symbol missing"); \
            return 0; \
        } \
        memcpy(&api->name, &symbol, sizeof(symbol)); \
    } while (0);
    API_FUNCTIONS(LOAD_SYMBOL)
#undef LOAD_SYMBOL
    return 1;
}

static char *platform_string(struct opencl_api *api, struct probe_result *result,
                             cl_platform_id platform, cl_uint name)
{
    size_t size = 0;
    char *value;
    cl_int error = CL_CALL(clGetPlatformInfo, platform, name, 0, NULL, &size);
    if (!check(result, "clGetPlatformInfo size", error))
        return NULL;
    if (!size || size > 32768) {
        failure(result, "clGetPlatformInfo size", -10001, "invalid or excessive information length");
        return NULL;
    }
    value = calloc(size + 1, 1);
    if (!value) {
        failure(result, "calloc platform info", -10002, "out of memory");
        return NULL;
    }
    error = CL_CALL(clGetPlatformInfo, platform, name, size, value, NULL);
    if (!check(result, "clGetPlatformInfo value", error)) {
        free(value);
        return NULL;
    }
    return value;
}

static char *device_string(struct opencl_api *api, struct probe_result *result,
                           cl_uint name)
{
    size_t size = 0;
    char *value;
    cl_int error = CL_CALL(clGetDeviceInfo, result->device, name, 0, NULL, &size);
    if (!check(result, "clGetDeviceInfo size", error))
        return NULL;
    if (!size || size > 32768) {
        failure(result, "clGetDeviceInfo size", -10001, "invalid or excessive information length");
        return NULL;
    }
    value = calloc(size + 1, 1);
    if (!value) {
        failure(result, "calloc device info", -10002, "out of memory");
        return NULL;
    }
    error = CL_CALL(clGetDeviceInfo, result->device, name, size, value, NULL);
    if (!check(result, "clGetDeviceInfo value", error)) {
        free(value);
        return NULL;
    }
    return value;
}

static int select_gpu(struct opencl_api *api, struct probe_result *result)
{
    cl_uint count = 0, p;
    cl_platform_id *platforms = NULL;
    cl_int error;
    if (!check(result, "clGetPlatformIDs count", CL_CALL(clGetPlatformIDs, 0, NULL, &count)))
        return 0;
    if (!count || count > 64) {
        failure(result, "clGetPlatformIDs count", -10003, "no platform or excessive platform count");
        return 0;
    }
    platforms = calloc(count, sizeof(*platforms));
    if (!platforms) {
        failure(result, "calloc platforms", -10002, "out of memory");
        return 0;
    }
    if (!check(result, "clGetPlatformIDs list", CL_CALL(clGetPlatformIDs, count, platforms, NULL))) {
        free(platforms);
        return 0;
    }
    for (p = 0; p < count && !result->device; ++p) {
        cl_uint devices_count = 0, d;
        cl_device_id *devices;
        error = CL_CALL(clGetDeviceIDs, platforms[p], CL_DEVICE_TYPE_GPU, 0, NULL, &devices_count);
        if (error == CL_DEVICE_NOT_FOUND)
            continue;
        if (!check(result, "clGetDeviceIDs GPU count", error))
            break;
        if (!devices_count)
            continue;
        if (devices_count > 256) {
            failure(result, "clGetDeviceIDs GPU count", -10003, "excessive device count");
            break;
        }
        devices = calloc(devices_count, sizeof(*devices));
        if (!devices) {
            failure(result, "calloc GPU devices", -10002, "out of memory");
            break;
        }
        if (!check(result, "clGetDeviceIDs GPU list",
                   CL_CALL(clGetDeviceIDs, platforms[p], CL_DEVICE_TYPE_GPU, devices_count, devices, NULL))) {
            free(devices);
            break;
        }
        for (d = 0; d < devices_count; ++d) {
            cl_device_type type = 0;
            cl_bool available = 0, compiler = 0;
            error = CL_CALL(clGetDeviceInfo, devices[d], CL_DEVICE_TYPE, sizeof(type), &type, NULL);
            if (error != CL_SUCCESS || type != CL_DEVICE_TYPE_GPU)
                continue;
            error = CL_CALL(clGetDeviceInfo, devices[d], CL_DEVICE_AVAILABLE, sizeof(available), &available, NULL);
            if (error != CL_SUCCESS || available != CL_TRUE)
                continue;
            error = CL_CALL(clGetDeviceInfo, devices[d], CL_DEVICE_COMPILER_AVAILABLE, sizeof(compiler), &compiler, NULL);
            if (error != CL_SUCCESS || compiler != CL_TRUE)
                continue;
            result->platform = platforms[p];
            result->device = devices[d];
            result->device_type = type;
            result->device_available = available;
            result->compiler_available = compiler;
            break;
        }
        free(devices);
    }
    free(platforms);
    if (!result->device && !result->error[0])
        failure(result, "select GPU", CL_DEVICE_NOT_FOUND,
                "no available GPU device with an online compiler; CPU fallback is forbidden");
    return result->device != NULL && !result->error[0];
}

static int collect_metadata(struct opencl_api *api, struct probe_result *result)
{
    result->platform_name = platform_string(api, result, result->platform, CL_PLATFORM_NAME);
    result->platform_vendor = platform_string(api, result, result->platform, CL_PLATFORM_VENDOR);
    result->platform_version = platform_string(api, result, result->platform, CL_PLATFORM_VERSION);
    result->platform_profile = platform_string(api, result, result->platform, CL_PLATFORM_PROFILE);
    result->device_name = device_string(api, result, CL_DEVICE_NAME);
    result->device_vendor = device_string(api, result, CL_DEVICE_VENDOR);
    result->device_version = device_string(api, result, CL_DEVICE_VERSION);
    result->device_profile = device_string(api, result, CL_DEVICE_PROFILE);
    result->driver_version = device_string(api, result, CL_DRIVER_VERSION);
    result->extensions = device_string(api, result, CL_DEVICE_EXTENSIONS);
    check(result, "clGetDeviceInfo compute units",
          CL_CALL(clGetDeviceInfo, result->device, CL_DEVICE_MAX_COMPUTE_UNITS,
                               sizeof(result->compute_units), &result->compute_units, NULL));
    return !result->error[0];
}

static void collect_build_log(struct opencl_api *api, struct probe_result *result,
                              cl_program program)
{
    size_t size = 0;
    cl_int error = CL_CALL(clGetProgramBuildInfo, program, result->device, CL_PROGRAM_BUILD_LOG, 0, NULL, &size);
    if (error != CL_SUCCESS || !size || size > 262144)
        return;
    result->build_log = calloc(size + 1, 1);
    if (!result->build_log)
        return;
    error = CL_CALL(clGetProgramBuildInfo, program, result->device, CL_PROGRAM_BUILD_LOG,
                                      size, result->build_log, NULL);
    if (error != CL_SUCCESS) {
        free(result->build_log);
        result->build_log = NULL;
    }
}

static double monotonic_ms(void)
{
    struct timespec stamp;
    if (clock_gettime(CLOCK_MONOTONIC, &stamp) != 0)
        return 0;
    return (double)stamp.tv_sec * 1000.0 + (double)stamp.tv_nsec / 1000000.0;
}

static void released(struct probe_result *result, const char *operation, cl_int code)
{
    if (code != CL_SUCCESS) {
        if (!result->cleanup_error[0])
            snprintf(result->cleanup_error, sizeof(result->cleanup_error), "%s failed with %d", operation, (int)code);
        failure(result, operation, code, "resource release failed");
    }
}

static void execute_fixture(struct opencl_api *api, struct probe_result *result)
{
    cl_context context = NULL;
    cl_command_queue queue = NULL;
    cl_program program = NULL;
    cl_kernel kernel = NULL;
    cl_mem first_buffer = NULL, second_buffer = NULL, output_buffer = NULL;
    cl_event event = NULL;
    cl_int *first = NULL, *second = NULL, *output = NULL;
    cl_int error = CL_SUCCESS, element_count = (cl_int)result->elements;
    size_t bytes = result->elements * sizeof(cl_int), global_work = result->elements;
    cl_context_properties properties[3];
    unsigned int round;
    const char *source = kernel_source;
    properties[0] = (cl_context_properties)CL_CONTEXT_PLATFORM;
    properties[1] = (cl_context_properties)result->platform;
    properties[2] = 0;
    context = CL_CALL(clCreateContext, properties, 1, &result->device, NULL, NULL, &error);
    if (!check(result, "clCreateContext", error) || !context) {
        if (!context && !result->error[0]) failure(result, "clCreateContext", -10004, "NULL context");
        goto cleanup;
    }
    queue = CL_CALL(clCreateCommandQueue, context, result->device, CL_QUEUE_PROFILING_ENABLE, &error);
    if (!check(result, "clCreateCommandQueue profiling", error) || !queue) {
        if (!queue && !result->error[0]) failure(result, "clCreateCommandQueue", -10004, "NULL queue");
        goto cleanup;
    }
    program = CL_CALL(clCreateProgramWithSource, context, 1, &source, NULL, &error);
    if (!check(result, "clCreateProgramWithSource", error) || !program) {
        if (!program && !result->error[0]) failure(result, "clCreateProgramWithSource", -10004, "NULL program");
        goto cleanup;
    }
    error = CL_CALL(clBuildProgram, program, 1, &result->device, "", NULL, NULL);
    collect_build_log(api, result, program);
    if (!check(result, "clBuildProgram", error)) goto cleanup;
    kernel = CL_CALL(clCreateKernel, program, "vector_fixture", &error);
    if (!check(result, "clCreateKernel", error) || !kernel) {
        if (!kernel && !result->error[0]) failure(result, "clCreateKernel", -10004, "NULL kernel");
        goto cleanup;
    }
    first = malloc(bytes); second = malloc(bytes); output = malloc(bytes);
    result->rounds = calloc(result->iterations, sizeof(*result->rounds));
    if (!first || !second || !output || !result->rounds) {
        failure(result, "allocate fixture", -10002, "out of memory"); goto cleanup;
    }
    first_buffer = CL_CALL(clCreateBuffer, context, CL_MEM_READ_ONLY, bytes, NULL, &error);
    if (!check(result, "clCreateBuffer first", error) || !first_buffer) {
        if (!first_buffer && !result->error[0]) failure(result, "clCreateBuffer first", -10004, "NULL buffer");
        goto cleanup;
    }
    second_buffer = CL_CALL(clCreateBuffer, context, CL_MEM_READ_ONLY, bytes, NULL, &error);
    if (!check(result, "clCreateBuffer second", error) || !second_buffer) {
        if (!second_buffer && !result->error[0]) failure(result, "clCreateBuffer second", -10004, "NULL buffer");
        goto cleanup;
    }
    output_buffer = CL_CALL(clCreateBuffer, context, CL_MEM_READ_WRITE, bytes, NULL, &error);
    if (!check(result, "clCreateBuffer output", error) || !output_buffer) {
        if (!output_buffer && !result->error[0]) failure(result, "clCreateBuffer output", -10004, "NULL buffer");
        goto cleanup;
    }
    if (!check(result, "clSetKernelArg first", CL_CALL(clSetKernelArg, kernel, 0, sizeof(first_buffer), &first_buffer)) ||
        !check(result, "clSetKernelArg second", CL_CALL(clSetKernelArg, kernel, 1, sizeof(second_buffer), &second_buffer)) ||
        !check(result, "clSetKernelArg output", CL_CALL(clSetKernelArg, kernel, 2, sizeof(output_buffer), &output_buffer)) ||
        !check(result, "clSetKernelArg count", CL_CALL(clSetKernelArg, kernel, 3, sizeof(element_count), &element_count))) goto cleanup;

    for (round = 0; round < result->iterations; ++round) {
        size_t i;
        struct round_result *entry = &result->rounds[round];
        double start;
        entry->number = round + 1;
        entry->first_mismatch = result->elements;
        for (i = 0; i < result->elements; ++i) {
            first[i] = (cl_int)((i * 17 + round * 37) % 1024);
            second[i] = (cl_int)((i * 31 + round * 53 + 7) % 1024);
            output[i] = -1;
        }
        start = monotonic_ms();
        if (!check(result, "clEnqueueWriteBuffer first",
                   CL_CALL(clEnqueueWriteBuffer, queue, first_buffer, CL_TRUE, 0, bytes, first, 0, NULL, NULL)) ||
            !check(result, "clEnqueueWriteBuffer second",
                   CL_CALL(clEnqueueWriteBuffer, queue, second_buffer, CL_TRUE, 0, bytes, second, 0, NULL, NULL))) goto cleanup;
        /* Poison the device output each round; an unwritten or stale result
         * cannot accidentally match a previously successful run. */
        if (!check(result, "clEnqueueWriteBuffer poison output",
                   CL_CALL(clEnqueueWriteBuffer, queue, output_buffer, CL_TRUE, 0, bytes, output, 0, NULL, NULL))) goto cleanup;
        if (!check(result, "clEnqueueNDRangeKernel",
                   CL_CALL(clEnqueueNDRangeKernel, queue, kernel, 1, NULL, &global_work, NULL, 0, NULL, &event))) goto cleanup;
        if (!event) { failure(result, "clEnqueueNDRangeKernel", -10004, "profiling event absent"); goto cleanup; }
        if (!check(result, "clEnqueueReadBuffer",
                   CL_CALL(clEnqueueReadBuffer, queue, output_buffer, CL_TRUE, 0, bytes, output, 0, NULL, NULL)) ||
            !check(result, "clFinish", CL_CALL(clFinish, queue))) goto cleanup;
        entry->transfer_and_dispatch_ms = monotonic_ms() - start;
        entry->profiling_error = CL_CALL(clGetEventProfilingInfo, event, CL_PROFILING_COMMAND_START,
                                                             sizeof(entry->gpu_start_ns), &entry->gpu_start_ns, NULL);
        if (entry->profiling_error == CL_SUCCESS)
            entry->profiling_error = CL_CALL(clGetEventProfilingInfo, event, CL_PROFILING_COMMAND_END,
                                                                 sizeof(entry->gpu_end_ns), &entry->gpu_end_ns, NULL);
        for (i = 0; i < result->elements; ++i) {
            cl_int expected = first[i] * 3 + second[i] * 2 + (first[i] ^ second[i]);
            if (output[i] != expected) {
                if (!entry->mismatches) {
                    entry->first_mismatch = i;
                    entry->first_actual = output[i]; entry->first_expected = expected;
                }
                ++entry->mismatches;
            }
        }
        entry->passed = !entry->mismatches;
        released(result, "clReleaseEvent", CL_CALL(clReleaseEvent, event)); event = NULL;
        if (!entry->passed) {
            failure(result, "CPU reference comparison", -10005, "GPU readback differs from the integer CPU reference");
            goto cleanup;
        }
        if (result->error[0]) goto cleanup;
        ++result->completed;
    }
    result->passed = result->completed == result->iterations && result->iterations >= 3 &&
                     result->device_type == CL_DEVICE_TYPE_GPU && !result->error[0];

cleanup:
    if (event) released(result, "clReleaseEvent", CL_CALL(clReleaseEvent, event));
    if (output_buffer) released(result, "clReleaseMemObject output", CL_CALL(clReleaseMemObject, output_buffer));
    if (second_buffer) released(result, "clReleaseMemObject second", CL_CALL(clReleaseMemObject, second_buffer));
    if (first_buffer) released(result, "clReleaseMemObject first", CL_CALL(clReleaseMemObject, first_buffer));
    if (kernel) released(result, "clReleaseKernel", CL_CALL(clReleaseKernel, kernel));
    if (program) released(result, "clReleaseProgram", CL_CALL(clReleaseProgram, program));
    if (queue) released(result, "clReleaseCommandQueue", CL_CALL(clReleaseCommandQueue, queue));
    if (context) released(result, "clReleaseContext", CL_CALL(clReleaseContext, context));
    free(output); free(second); free(first);
}

static void json_string(FILE *stream, const char *value)
{
    const unsigned char *cursor = (const unsigned char *)value;
    if (!value) { fputs("null", stream); return; }
    fputc('"', stream);
    while (*cursor) {
        unsigned char c = *cursor++;
        if (c == '"' || c == '\\') { fputc('\\', stream); fputc(c, stream); }
        else if (c < 0x20) fprintf(stream, "\\u%04x", (unsigned int)c);
        else fputc(c, stream);
    }
    fputc('"', stream);
}

static void json_field(FILE *stream, const char *name, const char *value)
{
    fputs(",\n  ", stream); json_string(stream, name); fputs(": ", stream); json_string(stream, value);
}

static void emit_result(FILE *stream, const struct probe_result *result)
{
    unsigned int i;
    fprintf(stream, "{\n  \"status\": \"%s\",\n  \"hardware_compute_pass\": %s,\n"
                    "  \"api\": \"OpenCL 1.1 vendor runtime\",\n  \"cpu_fallback_permitted\": false",
            result->passed ? "PASS_GPU_COMPUTE" :
            result->inventory_pass ? "INVENTORY_ONLY" : "FAIL", result->passed ? "true" : "false");
    json_field(stream, "library", result->library_path);
    json_field(stream, "platform_name", result->platform_name);
    json_field(stream, "platform_vendor", result->platform_vendor);
    json_field(stream, "platform_version", result->platform_version);
    json_field(stream, "platform_profile", result->platform_profile);
    json_field(stream, "device_name", result->device_name);
    json_field(stream, "device_vendor", result->device_vendor);
    json_field(stream, "device_version", result->device_version);
    json_field(stream, "device_profile", result->device_profile);
    json_field(stream, "driver_version", result->driver_version);
    json_field(stream, "device_extensions", result->extensions);
    json_field(stream, "build_log", result->build_log);
    json_field(stream, "failed_operation", result->operation[0] ? result->operation : NULL);
    json_field(stream, "error", result->error[0] ? result->error : NULL);
    json_field(stream, "cleanup_error", result->cleanup_error[0] ? result->cleanup_error : NULL);
    fprintf(stream, ",\n  \"error_code\": %d,\n  \"device_type\": %" PRIu64 ",\n"
                    "  \"device_available\": %s,\n  \"compiler_available\": %s,\n"
                    "  \"compute_units\": %u,\n  \"elements\": %zu,\n"
                    "  \"requested_iterations\": %u,\n  \"completed_iterations\": %u,\n"
                    "  \"inventory_only\": %s,\n  \"inventory_pass\": %s,\n"
                    "  \"profiling_queue_requested\": %s,\n"
                    "  \"fixture\": \"out[i] = a[i]*3 + b[i]*2 + (a[i] XOR b[i]); exact int32 reference\",\n"
                    "  \"rounds\": [", (int)result->error_code, result->device_type,
            result->device_available == CL_TRUE ? "true" : "false",
            result->compiler_available == CL_TRUE ? "true" : "false",
            result->compute_units, result->elements, result->iterations, result->completed,
            result->inventory_only ? "true" : "false", result->inventory_pass ? "true" : "false",
            result->inventory_only ? "false" : "true");
    for (i = 0; result->rounds && i < result->iterations && result->rounds[i].number; ++i) {
        const struct round_result *entry = &result->rounds[i];
        fprintf(stream, "%s\n    {\"iteration\": %u, \"pass\": %s, \"mismatched_elements\": %zu, "
                        "\"transfer_dispatch_readback_ms\": %.3f, \"profiling_error\": %d, "
                        "\"gpu_start_ns\": %" PRIu64 ", \"gpu_end_ns\": %" PRIu64 ", \"gpu_kernel_ms\": ",
                i ? "," : "", entry->number, entry->passed ? "true" : "false", entry->mismatches,
                entry->transfer_and_dispatch_ms, (int)entry->profiling_error,
                entry->gpu_start_ns, entry->gpu_end_ns);
        if (entry->profiling_error == CL_SUCCESS && entry->gpu_end_ns >= entry->gpu_start_ns && entry->gpu_end_ns)
            fprintf(stream, "%.6f", (double)(entry->gpu_end_ns - entry->gpu_start_ns) / 1000000.0);
        else fputs("null", stream);
        if (entry->mismatches)
            fprintf(stream, ", \"first_mismatch\": %zu, \"first_actual\": %d, \"first_expected\": %d",
                    entry->first_mismatch, (int)entry->first_actual, (int)entry->first_expected);
        fputc('}', stream);
    }
    fputs("\n  ]\n}\n", stream);
    fflush(stream);
}

static void free_result(struct probe_result *result)
{
    free(result->platform_name); free(result->platform_vendor); free(result->platform_version);
    free(result->platform_profile); free(result->device_name); free(result->device_vendor);
    free(result->device_version); free(result->device_profile); free(result->driver_version);
    free(result->extensions); free(result->build_log); free(result->rounds);
}

static int positive_number(const char *value, unsigned long minimum, unsigned long maximum,
                           unsigned long *parsed)
{
    char *end;
    unsigned long number;
    if (!value[0] || value[0] == '-' || value[0] == '+') return 0;
    errno = 0; number = strtoul(value, &end, 10);
    if (errno || *end || number < minimum || number > maximum) return 0;
    *parsed = number; return 1;
}

int main(int argc, char **argv)
{
    struct probe_result result;
    struct opencl_api api;
    void *library_handle = NULL;
    FILE *json_output = NULL;
    int saved_stdout = -1, i, exit_code;
    unsigned long number;
    memset(&result, 0, sizeof(result)); memset(&api, 0, sizeof(api));
    result.library_path = "/opt/dior-android/system/vendor/lib/libOpenCL.so";
    result.elements = 4096; result.iterations = 3;
    for (i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--trace") == 0) trace_enabled = 1;
        else if (strcmp(argv[i], "--inventory-only") == 0) result.inventory_only = 1;
        else if (strcmp(argv[i], "--library") == 0 && i + 1 < argc) {
            result.library_path = argv[++i];
            if (result.library_path[0] != '/') failure(&result, "arguments", -10006, "--library requires an absolute path");
        } else if (strcmp(argv[i], "--repeat") == 0 && i + 1 < argc) {
            if (!positive_number(argv[++i], 3, 1000, &number)) failure(&result, "arguments", -10006, "--repeat must be 3..1000");
            else result.iterations = (unsigned int)number;
        } else if (strcmp(argv[i], "--elements") == 0 && i + 1 < argc) {
            if (!positive_number(argv[++i], 4096, 1048576, &number)) failure(&result, "arguments", -10006, "--elements must be 4096..1048576");
            else result.elements = (size_t)number;
        } else failure(&result, "arguments", -10006, "usage: dior-opencl-probe [--trace] [--inventory-only] [--library /absolute/vendor.so] [--repeat 3..1000] [--elements 4096..1048576]");
    }
    /* Vendor libraries sometimes write diagnostics to stdout. Preserve a JSON
     * stream on the original pipe and send all native diagnostics to stderr. */
    trace_stage("arguments parsed; before dup stdout");
    saved_stdout = dup(STDOUT_FILENO);
    trace_stage("after dup stdout; before fdopen JSON stream");
    if (saved_stdout >= 0) json_output = fdopen(saved_stdout, "w");
    trace_stage("after fdopen JSON stream");
    if (!json_output) {
        const char fd_failure[] = "{\"status\":\"FAIL\",\"hardware_compute_pass\":false,\"error\":\"cannot preserve JSON output descriptor\"}\n";
        if (saved_stdout >= 0) close(saved_stdout);
        (void)write(STDOUT_FILENO, fd_failure, sizeof(fd_failure)-1);
        free_result(&result);
        return 1;
    }
    /* Do not refer to stdout/stderr FILE globals or __sF. KitKat's FILE object
     * stays entirely inside its own libc; fdopen returns the matching object. */
    trace_stage("before redirect vendor diagnostics");
    if (dup2(STDERR_FILENO, STDOUT_FILENO) < 0)
        failure(&result, "redirect vendor diagnostics", -10007, strerror(errno));
    trace_stage("after redirect vendor diagnostics");
    if (!result.error[0]) {
        trace_stage("before dlopen vendor OpenCL");
        library_handle = dlopen(result.library_path, RTLD_NOW | RTLD_LOCAL);
        trace_stage("after dlopen vendor OpenCL");
        if (!library_handle) failure(&result, "dlopen vendor OpenCL", -10008, dlerror());
        else {
            int ready;
            trace_stage("before load_api"); ready = load_api(library_handle, &api, &result); trace_stage("after load_api");
            if (ready) { trace_stage("before select_gpu"); ready = select_gpu(&api, &result); trace_stage("after select_gpu"); }
            if (ready) { trace_stage("before collect_metadata"); ready = collect_metadata(&api, &result); trace_stage("after collect_metadata"); }
            if (ready) {
                if (result.inventory_only) result.inventory_pass = 1;
                else { trace_stage("before execute_fixture"); execute_fixture(&api, &result); trace_stage("after execute_fixture"); }
            }
        }
    }
    if (library_handle) {
        trace_stage("before dlclose vendor OpenCL");
        if (dlclose(library_handle) != 0) failure(&result, "dlclose vendor OpenCL", -10008, dlerror());
        trace_stage("after dlclose vendor OpenCL");
    }
    if (result.error[0]) result.inventory_pass = 0;
    trace_stage("before emit JSON");
    emit_result(json_output, &result);
    trace_stage("after emit JSON");
    exit_code = (result.passed || result.inventory_pass) ? 0 : 1;
    free_result(&result);
    trace_stage("before fclose JSON stream");
    fclose(json_output);
    trace_stage("after fclose JSON stream");
    return exit_code;
}
