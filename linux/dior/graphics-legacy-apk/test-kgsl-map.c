/* SPDX-License-Identifier: MIT
 * Compile the actual patched implementation and substitute only syscalls.
 * This exercises positive and failed ION export / mmap paths without a GPU.
 */
#include "freedreno/kgsl/kgsl_priv.h"
#include <sys/mman.h>
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
    puts("PASS ION mapping: correct FD/offset, allocation/export failures, mmap cleanup and errno");
    return 0;
}
