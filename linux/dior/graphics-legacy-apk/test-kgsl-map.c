/* SPDX-License-Identifier: MIT
 * Compile the actual patched ION/GPU-address implementation with syscall
 * injection. Unexercised shared-library entrypoints use fail-fast traps.
 * This exercises positive and failed ION export / mmap paths without a GPU.
 */
#include "freedreno/kgsl/kgsl_priv.h"
#include <sys/mman.h>
#include <setjmp.h>
#include "freedreno_ringbuffer.h"
static int mode, alloc_calls, export_calls, map_calls, close_calls;
static char mapped[4096];
static int dior_test_command(int, unsigned long, void *, unsigned long);
static void *dior_test_mmap(void *, size_t, int, int, int, off_t);
static int dior_test_close(int);
#define drmCommandWriteRead dior_test_command
#undef drm_mmap
#define drm_mmap dior_test_mmap
#define close dior_test_close
#include "freedreno/kgsl/kgsl_bo.c"
#undef drmCommandWriteRead
#undef close

/* Including bo.c retains the public fd_bo_from_fbdev API when its shared
 * library exports the same symbol. Its private pipe discriminator cannot be
 * resolved from that library and is outside this fixture's exercised paths. */
int is_kgsl_pipe(struct fd_pipe *pipe)
{
    (void)pipe;
    assert(!"unexpected fd_bo_from_fbdev path in ION/GPU-address fixture");
    return 0;
}

/* The release-mode relocation implementation is compiled in its own source
 * unit, keeping its static function table independent of kgsl_bo.c's table. */
static jmp_buf relocation_failure;
static int abort_calls, submit_calls;
void dior_test_abort(void);
void dior_test_add_submit(struct kgsl_pipe *, struct kgsl_bo *);
void dior_test_emit_reloc(struct fd_ringbuffer *, const struct fd_reloc *);

void dior_test_abort(void)
{
    abort_calls++;
    longjmp(relocation_failure, 1);
}

void dior_test_add_submit(struct kgsl_pipe *pipe, struct kgsl_bo *bo)
{
    (void)pipe;
    (void)bo;
    submit_calls++;
}

static int dior_test_command(int fd, unsigned long command, void *data, unsigned long size)
{
    assert(fd == 13);
    if (command == DRM_KGSL_GEM_ALLOC) {
        struct drm_kgsl_gem_alloc *value = data;
        assert(size == sizeof(*value) && value->handle == 99);
        alloc_calls++;
        value->offset = 0; /* Deliberately reproduce the target shim's ABI. */
        if (mode == 2) { errno = ENOMEM; return -1; }
        return 0;
    }
    if (command == DRM_KGSL_GEM_GET_BUFINFO) {
        struct drm_kgsl_gem_bufinfo *value = data;
        assert(size == sizeof(*value) && value->handle == 99);
        export_calls++;
        if (mode == 5) { errno = EIO; return -1; }
        value->gpuaddr[0] = 0x12000000;
        return 0;
    }
    assert(command == DRM_KGSL_GEM_GET_ION_FD);
    struct drm_kgsl_gem_get_ion_fd *value = data;
    assert(size == sizeof(*value) && value->handle == 99);
    export_calls++;
    if (mode == 1) { errno = ENODEV; return -1; }
    value->ion_fd = mode == 4 ? -1 : 38;
    return 0;
}

static void *dior_test_mmap(void *address, size_t size, int prot, int flags, int fd, off_t offset)
{
    assert(address == NULL && size == 4096 && fd == 38 && offset == 0);
    assert(prot == (PROT_READ | PROT_WRITE) && flags == MAP_SHARED);
    map_calls++;
    if (mode == 3) { errno = EIO; return MAP_FAILED; }
    return mapped;
}

static int dior_test_close(int fd)
{
    assert(fd == 38);
    close_calls++;
    errno = EPERM; /* Closing must not overwrite the original mmap errno. */
    return 0;
}

int main(void)
{
    struct fd_device device = { .fd = 13 };
    struct kgsl_bo object = { .base = { .dev = &device, .handle = 99, .size = 4096 } };
    for (mode = 0; mode < 5; mode++) {
        alloc_calls = export_calls = map_calls = close_calls = 0;
        void *value = kgsl_bo_map(&object.base);
        assert(alloc_calls == 1);
        assert(export_calls == (mode == 2 ? 0 : 1));
        assert(map_calls == ((mode == 0 || mode == 3) ? 1 : 0));
        assert(close_calls == map_calls);
        assert(value == (mode == 0 ? mapped : NULL));
        if (mode == 3) assert(errno == EIO);
    }
    /* Compile the real GPU-address helper: an allocation errno cannot be
     * reinterpreted as a valid high unsigned GPU address by relocations. */
    mode = 2;
    alloc_calls = export_calls = 0;
    assert(kgsl_bo_gpuaddr(&object, 16) == 0);
    assert(alloc_calls == 1 && export_calls == 0);
    assert(object.gpuaddr == 0);
    mode = 5;
    alloc_calls = export_calls = 0;
    assert(kgsl_bo_gpuaddr(&object, 16) == 0);
    assert(alloc_calls == 1 && export_calls == 1);
    assert(object.gpuaddr == 0);
    mode = 6;
    alloc_calls = export_calls = 0;
    assert(kgsl_bo_gpuaddr(&object, 16) == 0x12000010);
    assert(alloc_calls == 1 && export_calls == 1);
    assert(object.gpuaddr == 0x12000000);
    uint32_t command = 0xfeedface;
    struct kgsl_pipe pipe = { 0 };
    struct fd_ringbuffer ring = { .pipe = &pipe.base, .cur = &command };
    struct fd_reloc relocation = { .bo = &object.base, .offset = 16, .shift = 0, .or = 0 };
    object.gpuaddr = 0;
    mode = 2;
    if (setjmp(relocation_failure) == 0) {
        dior_test_emit_reloc(&ring, &relocation);
        assert(!"allocation failure must abort before emitting GPU commands");
    }
    assert(abort_calls == 1 && submit_calls == 0);
    assert(command == 0xfeedface && ring.cur == &command);
    mode = 6;
    dior_test_emit_reloc(&ring, &relocation);
    assert(command == 0x12000010 && ring.cur == &command + 1 && submit_calls == 1);
    puts("PASS ION mapping: correct FD/offset, allocation/export failures, mmap cleanup and errno");
    puts("PASS GPU address: allocation/BUFINFO failures return zero; success preserves byte offset");
    puts("PASS NDEBUG relocation: abort before command emission/submission; valid addresses still emit");
    return 0;
}
