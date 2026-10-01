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
_Static_assert(DRM_KGSL_GEM_GET_ION_FD == 0x0f, "ION export command");
_Static_assert(DRM_IOCTL_KGSL_GEM_GET_BUFINFO == 0xc0246448U, "BUFINFO ioctl");
_Static_assert(IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID == 0x400c0907U, "context wait ioctl");
_Static_assert(IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID == 0xc00c0916U, "context read ioctl");
_Static_assert(IOCTL_KGSL_RINGBUFFER_ISSUEIBCMDS == 0xc0140910U, "legacy submission ioctl");

int main(void)
{
    printf("BUFINFO=%zu gpuaddr=%zu ION=%zu/%u wait=%lx read=%lx issue=%lx\n",
        sizeof(struct drm_kgsl_gem_bufinfo), offsetof(struct drm_kgsl_gem_bufinfo, gpuaddr),
        sizeof(struct drm_kgsl_gem_get_ion_fd), DRM_KGSL_GEM_GET_ION_FD,
        (unsigned long)IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID,
        (unsigned long)IOCTL_KGSL_CMDSTREAM_READTIMESTAMP_CTXTID,
        (unsigned long)IOCTL_KGSL_RINGBUFFER_ISSUEIBCMDS);
    return 0;
}
