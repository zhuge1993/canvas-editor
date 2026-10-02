/* SPDX-License-Identifier: MIT */
#include "freedreno/kgsl/kgsl_priv.h"
#include <stdarg.h>
static int calls, interrupted, op;
static int failure_mode, open_calls, create_calls, allocation_calls;
static int version_calls, device_calls, destroy_calls, close_calls, pipe_del_calls;
static int dior_test_ioctl(int, unsigned long, ...);
static int dior_test_open(const char *, int, ...);
static int dior_test_close(int);
static void *dior_test_calloc(size_t, size_t);
static void dior_test_pipe_del(struct fd_pipe *);
#define ioctl dior_test_ioctl
#define open dior_test_open
#define close dior_test_close
#define calloc dior_test_calloc
#define fd_pipe_del dior_test_pipe_del
#include "freedreno/kgsl/kgsl_pipe.c"
#undef ioctl
#undef open
#undef close
#undef calloc
#undef fd_pipe_del

/* The real constructor's function table references this private callback.
 * Command-stream construction is outside the timestamp/ownership fixture. */
struct fd_ringbuffer *kgsl_ringbuffer_new(struct fd_pipe *pipe, uint32_t size)
{
    (void)pipe;
    (void)size;
    assert(!"unexpected ringbuffer creation in timestamp/pipe-ownership fixture");
    return NULL;
}

/* Timestamp waits use an empty pending list in this fixture. Any attempted
 * buffer deletion is a failure, never a successful simulated release. */
void fd_bo_del(struct fd_bo *bo)
{
    (void)bo;
    assert(!"unexpected buffer deletion from empty pending list");
}

static int dior_test_open(const char *path, int flags, ...)
{
    assert(strcmp(path, "/dev/kgsl-3d0") == 0 && flags == O_RDWR);
    open_calls++;
    if (failure_mode == 0) { errno = ENODEV; return -1; }
    return 13;
}

static int dior_test_close(int fd)
{
    assert(fd == 13);
    close_calls++;
    return 0;
}

static void *dior_test_calloc(size_t count, size_t size)
{
    assert(count == 1 && size == sizeof(struct kgsl_pipe));
    allocation_calls++;
    if (failure_mode == 2) { errno = ENOMEM; return NULL; }
    return calloc(count, size);
}

static void dior_test_pipe_del(struct fd_pipe *pipe)
{
    pipe_del_calls++;
    /* The actual destructor owns and releases the fd/context after calloc. */
    kgsl_pipe_destroy(pipe);
}

static int dior_test_ioctl(int fd, unsigned long command, ...)
{
    va_list args;
    va_start(args, command);
    void *data = va_arg(args, void *);
    va_end(args);
    assert(fd == 13);
    calls++;
    if (op == 2) {
        if (command == IOCTL_KGSL_DRAWCTXT_CREATE) {
            struct kgsl_drawctxt_create *value = data;
            assert(value->flags == KGSL_CONTEXT_PER_CONTEXT_TS);
            create_calls++;
            value->drawctxt_id = 41;
            if (failure_mode == 1) { errno = ENOMEM; return -1; }
            return 0;
        }
        if (command == IOCTL_KGSL_DRAWCTXT_DESTROY) {
            struct kgsl_drawctxt_destroy *value = data;
            assert(value->drawctxt_id == 41);
            destroy_calls++;
            return 0;
        }
        assert(command == IOCTL_KGSL_DEVICE_GETPROPERTY);
        struct kgsl_device_getproperty *value = data;
        if (value->type == KGSL_PROP_VERSION) {
            version_calls++;
            assert(value->sizebytes == sizeof(struct kgsl_version));
            if (failure_mode == 3) { errno = EIO; return -1; }
            memset(value->value, 0, value->sizebytes);
        } else {
            assert(value->type == KGSL_PROP_DEVICE_INFO);
            device_calls++;
            assert(value->sizebytes == sizeof(struct kgsl_devinfo));
            if (failure_mode == 4) { errno = EIO; return -1; }
            struct kgsl_devinfo *info = value->value;
            memset(info, 0, sizeof(*info));
            info->gpu_id = failure_mode == 5 ? 530 : 335;
            info->chip_id = 0x03000512;
        }
    } else if (op == 0) {
        fprintf(stderr, "TRACE wait ioctl: call=%d interrupted=%d\n", calls, interrupted);
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
    fprintf(stderr, "TRACE timestamps: identity parameters\n");
    struct kgsl_pipe pipe = { .base = { .id = FD_PIPE_3D }, .fd = 13, .drawctxt_id = 41 };
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
    fprintf(stderr, "TRACE pending state: id=%d head=%p next=%p prev=%p\n", pipe.base.id,
            (void *)&pipe.pending_list, (void *)pipe.pending_list.next,
            (void *)pipe.pending_list.prev);
    fprintf(stderr, "TRACE timestamps: empty pending-list processing\n");
    kgsl_pipe_process_pending(&pipe, 17);
    fprintf(stderr, "TRACE timestamps: empty pending-list returned\n");
    interrupted = 1;
    fprintf(stderr, "TRACE timestamps: context wait and EINTR\n");
    assert(kgsl_pipe_wait(&pipe.base, 17, 1000000000) == 0);
    assert(calls == 2);
    op = 1; calls = 0;
    uint32_t timestamp = 0;
    fprintf(stderr, "TRACE timestamps: context timestamp read\n");
    assert(kgsl_pipe_timestamp(&pipe, &timestamp) == 0);
    assert(timestamp == 17 && calls == 1);
    op = 2;
    for (failure_mode = 0; failure_mode <= 6; failure_mode++) {
        fprintf(stderr, "TRACE pipe ownership: constructor mode=%d\n", failure_mode);
        open_calls = create_calls = allocation_calls = version_calls = device_calls = 0;
        destroy_calls = close_calls = pipe_del_calls = 0;
        struct fd_pipe *created = kgsl_pipe_new(NULL, FD_PIPE_3D, 0);
        fprintf(stderr, "TRACE pipe ownership: mode=%d constructor returned\n", failure_mode);
        assert(open_calls == 1);
        assert(create_calls == (failure_mode == 0 ? 0 : 1));
        assert(allocation_calls == (failure_mode <= 1 ? 0 : 1));
        assert(version_calls == (failure_mode <= 2 ? 0 : 1));
        assert(device_calls == (failure_mode <= 3 ? 0 : 1));
        if (failure_mode == 6) {
            assert(created != NULL && close_calls == 0 && destroy_calls == 0);
            kgsl_pipe_destroy(created);
        } else {
            assert(created == NULL);
        }
        assert(close_calls == (failure_mode == 0 ? 0 : 1));
        /* A failed CREATE must not destroy a context even if its input/output
         * structure was changed; ownership begins only on ioctl success. */
        assert(destroy_calls == (failure_mode <= 1 ? 0 : 1));
        assert(pipe_del_calls == ((failure_mode >= 3 && failure_mode <= 5) ? 1 : 0));
    }
    puts("PASS context timestamps and exact A305B identity mapping with unchanged CHIP_ID");
    puts("PASS pipe ownership: open/create/calloc/property failures and success release fd/context once");
    return 0;
}
