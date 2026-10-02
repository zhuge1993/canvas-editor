/* SPDX-License-Identifier: MIT */
#include "freedreno/kgsl/kgsl_priv.h"
#include <stdarg.h>
static int calls, interrupted, op;
static int failure_mode, open_calls, create_calls, allocation_calls;
static int version_calls, device_calls, destroy_calls, close_calls, pipe_del_calls;
static int traversal_active, traversal_count, traversal_get_calls, traversal_set_calls;
static int traversal_new_calls, traversal_wait_calls, traversal_ref_calls, traversal_del_calls;
static uint32_t traversal_retired;
static struct fd_device traversal_device;
static struct fd_pipe traversal_sync_pipe;
static struct kgsl_bo traversal_objects[2];
static volatile unsigned traversal_runtime_id;
static int dior_test_ioctl(int, unsigned long, ...);
static int dior_test_open(const char *, int, ...);
static int dior_test_close(int);
static void *dior_test_calloc(size_t, size_t);
static void dior_test_pipe_del(struct fd_pipe *);
static struct fd_pipe *dior_test_new_pipe(struct fd_device *, enum fd_pipe_id);
static int dior_test_wait_pipe(struct fd_pipe *, uint32_t);
static struct fd_bo *dior_test_ref_bo(struct fd_bo *);
static uint32_t dior_test_get_timestamp(struct kgsl_bo *);
static void dior_test_set_timestamp(struct kgsl_bo *, uint32_t);
#define ioctl dior_test_ioctl
#define open dior_test_open
#define close dior_test_close
#define calloc dior_test_calloc
#define fd_pipe_del dior_test_pipe_del
#define fd_pipe_new dior_test_new_pipe
#define fd_pipe_wait dior_test_wait_pipe
#define fd_bo_ref dior_test_ref_bo
#define kgsl_bo_get_timestamp dior_test_get_timestamp
#define kgsl_bo_set_timestamp dior_test_set_timestamp
#include "freedreno/kgsl/kgsl_pipe.c"
#undef ioctl
#undef open
#undef close
#undef calloc
#undef fd_pipe_del
#undef fd_pipe_new
#undef fd_pipe_wait
#undef fd_bo_ref
#undef kgsl_bo_get_timestamp
#undef kgsl_bo_set_timestamp

/* Only external BO/reference/timestamp operations are injected below. The
 * actual add-submit, pre-submit, post-submit and process-pending loops are
 * compiled above unchanged, including their production list macros. */
static unsigned traversal_index(struct fd_bo *bo)
{
    unsigned index;
    assert(traversal_active);
    for (index = 0; index < (unsigned)traversal_count; index++)
        if (bo == &traversal_objects[index].base) return index;
    assert(!"a list head or unknown address was treated as a real BO");
    return 0;
}

static struct fd_pipe *dior_test_new_pipe(struct fd_device *dev, enum fd_pipe_id id)
{
    assert(traversal_active && dev == &traversal_device && id == FD_PIPE_3D);
    traversal_new_calls++;
    return &traversal_sync_pipe;
}

static int dior_test_wait_pipe(struct fd_pipe *pipe, uint32_t timestamp)
{
    assert(traversal_active && pipe == &traversal_sync_pipe && timestamp >= 10 && timestamp <= 11);
    traversal_wait_calls++;
    return 0;
}

static struct fd_bo *dior_test_ref_bo(struct fd_bo *bo)
{
    (void)traversal_index(bo);
    traversal_ref_calls++;
    atomic_inc(&bo->refcnt);
    return bo;
}

static uint32_t dior_test_get_timestamp(struct kgsl_bo *bo)
{
    unsigned index = traversal_index(&bo->base);
    traversal_get_calls++;
    return 10 + index;
}

static void dior_test_set_timestamp(struct kgsl_bo *bo, uint32_t timestamp)
{
    (void)traversal_index(&bo->base);
    assert(timestamp == 55);
    traversal_set_calls++;
}

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
    if (traversal_active) {
        struct kgsl_bo *object = &traversal_objects[traversal_index(bo)];
        assert(LIST_IS_EMPTY(&object->list[traversal_runtime_id]));
        assert(object->timestamp[traversal_runtime_id] == 0);
        traversal_del_calls++;
        atomic_dec(&bo->refcnt, 1);
    } else {
        assert(!"unexpected buffer deletion from empty pending list");
    }
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
    } else if (op == 3) {
        struct kgsl_cmdstream_readtimestamp_ctxtid *value = data;
        assert(traversal_active && command == IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID);
        assert(value->context_id == 41 && value->type == KGSL_TIMESTAMP_RETIRED);
        value->timestamp = traversal_retired;
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

static void test_production_list_loops(unsigned id, unsigned object_count)
{
    struct kgsl_pipe pipe;
    unsigned index, slot;
    traversal_runtime_id = id; /* The array-member offset is runtime data. */
    memset(&pipe, 0, sizeof(pipe));
    memset(traversal_objects, 0, sizeof(traversal_objects));
    pipe.base.id = (enum fd_pipe_id)traversal_runtime_id;
    pipe.base.dev = &traversal_device;
    pipe.fd = 13;
    pipe.drawctxt_id = 41;
    list_inithead(&pipe.submit_list);
    list_inithead(&pipe.pending_list);
    traversal_active = 1;
    traversal_count = (int)object_count;
    traversal_get_calls = traversal_set_calls = traversal_new_calls = 0;
    traversal_wait_calls = traversal_ref_calls = traversal_del_calls = 0;
    traversal_retired = 0;
    op = 3;
    /* Empty heads must never reach a BO getter/setter/deletion dependency. */
    kgsl_pipe_pre_submit(&pipe);
    kgsl_pipe_post_submit(&pipe, 55);
    kgsl_pipe_process_pending(&pipe, 55);
    assert(traversal_get_calls == 0 && traversal_set_calls == 0 && traversal_del_calls == 0);
    assert(traversal_new_calls == 1);
    for (index = 0; index < object_count; index++) {
        traversal_objects[index].base.dev = &traversal_device;
        atomic_set(&traversal_objects[index].base.refcnt, 1);
        for (slot = 0; slot < FD_PIPE_MAX; slot++)
            list_inithead(&traversal_objects[index].list[slot]);
        kgsl_pipe_add_submit(&pipe, &traversal_objects[index]);
    }
    assert(traversal_ref_calls == (int)object_count);
    kgsl_pipe_pre_submit(&pipe);
    assert(traversal_get_calls == (int)object_count);
    assert(traversal_wait_calls == (int)object_count && traversal_new_calls == 1);
    kgsl_pipe_post_submit(&pipe, 55);
    assert(LIST_IS_EMPTY(&pipe.submit_list));
    assert(traversal_set_calls == (int)object_count && traversal_del_calls == 0);
    assert(!LIST_IS_EMPTY(&pipe.pending_list));
    kgsl_pipe_process_pending(&pipe, 54);
    assert(traversal_del_calls == 0); /* Future timestamps must remain queued. */
    kgsl_pipe_process_pending(&pipe, 55);
    assert(LIST_IS_EMPTY(&pipe.pending_list));
    assert(traversal_del_calls == (int)object_count);
    for (index = 0; index < object_count; index++)
        assert(atomic_read(&traversal_objects[index].base.refcnt) == 1);
    kgsl_pipe_process_pending(&pipe, 55); /* The final head is not another BO. */
    assert(traversal_del_calls == (int)object_count);
    traversal_active = 0;
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
    for (unsigned id = FD_PIPE_3D; id <= FD_PIPE_2D; id++)
        for (unsigned count = 1; count <= 2; count++)
            test_production_list_loops(id, count);
    puts("PASS production KGSL list termination: runtime pipe IDs 1/2; empty and 1/2 real BOs; pre/post/retire stop at head");
    return 0;
}
