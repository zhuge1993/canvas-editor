/* SPDX-License-Identifier: MIT */
#include "freedreno/kgsl/kgsl_priv.h"
#include <stdarg.h>
static int calls, interrupted, op;
static int dior_test_ioctl(int, unsigned long, ...);
#define ioctl dior_test_ioctl
#include "freedreno/kgsl/kgsl_pipe.c"
#undef ioctl

static int dior_test_ioctl(int fd, unsigned long command, ...)
{
    va_list args;
    va_start(args, command);
    void *data = va_arg(args, void *);
    va_end(args);
    assert(fd == 13);
    calls++;
    if (op == 0) {
        struct kgsl_device_waittimestamp_ctxtid *value = data;
        assert(command == IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID);
        assert(value->context_id == 41 && value->timestamp == 17);
        if (interrupted) { interrupted = 0; errno = EINTR; return -1; }
    } else {
        struct kgsl_cmdstream_readtimestamp_ctxtid *value = data;
        assert(command == IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID);
        assert(value->context_id == 41 && value->type == KGSL_TIMESTAMP_RETIRED);
        value->timestamp = 17;
    }
    return 0;
}

int main(void)
{
    struct kgsl_pipe pipe = { .fd = 13, .drawctxt_id = 41 };
    uint64_t value;
    pipe.devinfo.gpu_id = 335;
    pipe.devinfo.chip_id = 0x03000512;
    assert(kgsl_pipe_get_param(&pipe.base, FD_GPU_ID, &value) == 0 && value == 305);
    assert(kgsl_pipe_get_param(&pipe.base, FD_CHIP_ID, &value) == 0 && value == 0x03000512);
    pipe.devinfo.chip_id = 0x03000510;
    assert(kgsl_pipe_get_param(&pipe.base, FD_GPU_ID, &value) == 0 && value == 305);
    pipe.devinfo.chip_id = 0x03000312;
    assert(kgsl_pipe_get_param(&pipe.base, FD_GPU_ID, &value) == 0 && value == 335);
    pipe.devinfo.gpu_id = 330;
    pipe.devinfo.chip_id = 0x03000512;
    assert(kgsl_pipe_get_param(&pipe.base, FD_GPU_ID, &value) == 0 && value == 330);
    list_inithead(&pipe.pending_list);
    interrupted = 1;
    assert(kgsl_pipe_wait(&pipe.base, 17, 1000000000) == 0);
    assert(calls == 2);
    op = 1; calls = 0;
    uint32_t timestamp = 0;
    assert(kgsl_pipe_timestamp(&pipe, &timestamp) == 0);
    assert(timestamp == 17 && calls == 1);
    puts("PASS context timestamps and exact A305B identity mapping with unchanged CHIP_ID");
    return 0;
}
