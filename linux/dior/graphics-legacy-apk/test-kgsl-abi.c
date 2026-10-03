/* SPDX-License-Identifier: MIT */
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/ioctl.h>
#include "drm.h"
#ifndef DIOR_DRM_HEADER
#define DIOR_DRM_HEADER "freedreno/kgsl/kgsl_drm.h"
#endif
#include DIOR_DRM_HEADER
#include DIOR_DRM_HEADER
#include "freedreno/kgsl/msm_kgsl.h"

/* These are the actual arm32 UAPI values of the locked Dior source. */
_Static_assert(sizeof(void *) == 4, "test must run in the target armv7 chroot");
_Static_assert(DRM_KGSL_GEM_MAX_BUFFERS == 3, "Dior has three buffer entries");
_Static_assert(sizeof(struct drm_kgsl_gem_bufinfo) == 36, "BUFINFO size");
_Static_assert(offsetof(struct drm_kgsl_gem_bufinfo, gpuaddr) == 24, "BUFINFO GPU addresses");
_Static_assert(sizeof(struct drm_kgsl_gem_get_ion_fd) == 8, "ION export size");
_Static_assert(offsetof(struct drm_kgsl_gem_get_ion_fd, ion_fd) == 0, "ION output FD offset");
_Static_assert(offsetof(struct drm_kgsl_gem_get_ion_fd, handle) == 4, "ION input GEM handle offset");
_Static_assert(sizeof(((struct drm_kgsl_gem_get_ion_fd *)0)->ion_fd) == 4, "ION output FD wire width");
_Static_assert(sizeof(((struct drm_kgsl_gem_get_ion_fd *)0)->handle) == 4, "ION input handle wire width");
_Static_assert(DRM_KGSL_GEM_GET_ION_FD == 0x0f, "ION export command");
_Static_assert(DRM_IOWR(DRM_COMMAND_BASE + DRM_KGSL_GEM_GET_ION_FD,
                      struct drm_kgsl_gem_get_ion_fd) == 0xc008644fU, "ION export ioctl");
_Static_assert(DRM_IOCTL_KGSL_GEM_GET_BUFINFO == 0xc0246448U, "BUFINFO ioctl");
_Static_assert(IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID == 0x400c0907U, "context wait ioctl");
_Static_assert(IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID == 0xc00c0916U, "context read ioctl");
_Static_assert(IOCTL_KGSL_RINGBUFFER_ISSUEIBCMDS == 0xc0140910U, "legacy submission ioctl");
_Static_assert(KGSL_CONTEXT_NO_GMEM_ALLOC == 0x2, "no kernel GMEM shadow");
_Static_assert(KGSL_CONTEXT_SUBMIT_IB_LIST == 0x4, "submission IB list");
_Static_assert(KGSL_CONTEXT_PREAMBLE == 0x10, "first IB preamble");
_Static_assert(KGSL_CONTEXT_PER_CONTEXT_TS == 0x40, "per-context timestamp");
_Static_assert(sizeof(struct kgsl_ibdesc) == 16, "ARM32 IB descriptor size");
_Static_assert(offsetof(struct kgsl_ibdesc, gpuaddr) == 0, "IB GPU address");
_Static_assert(offsetof(struct kgsl_ibdesc, hostptr) == 4, "IB host pointer");
_Static_assert(offsetof(struct kgsl_ibdesc, sizedwords) == 8, "IB dword count");
_Static_assert(offsetof(struct kgsl_ibdesc, ctrl) == 12, "IB control word");

int main(void)
{
    printf("BUFINFO=%zu gpuaddr=%zu ION=%zu/%u ion_fd=%zu handle=%zu wait=%lx read=%lx issue=%lx context_flags=%x ibdesc=%zu/%zu/%zu/%zu/%zu\n",
        sizeof(struct drm_kgsl_gem_bufinfo), offsetof(struct drm_kgsl_gem_bufinfo, gpuaddr),
        sizeof(struct drm_kgsl_gem_get_ion_fd), DRM_KGSL_GEM_GET_ION_FD,
        offsetof(struct drm_kgsl_gem_get_ion_fd, ion_fd),
        offsetof(struct drm_kgsl_gem_get_ion_fd, handle),
        (unsigned long)IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID,
        (unsigned long)IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID,
        (unsigned long)IOCTL_KGSL_RINGBUFFER_ISSUEIBCMDS,
        KGSL_CONTEXT_PER_CONTEXT_TS | KGSL_CONTEXT_PREAMBLE | KGSL_CONTEXT_NO_GMEM_ALLOC,
        sizeof(struct kgsl_ibdesc), offsetof(struct kgsl_ibdesc, gpuaddr),
        offsetof(struct kgsl_ibdesc, hostptr), offsetof(struct kgsl_ibdesc, sizedwords),
        offsetof(struct kgsl_ibdesc, ctrl));
    return 0;
}
