#ifndef DIOR_LLM_API19_COMPAT_H
#define DIOR_LLM_API19_COMPAT_H
#include <pthread.h>
#include <sched.h>
#include <errno.h>
#include <sys/mman.h>
#include <fcntl.h>
#ifndef POSIX_MADV_WILLNEED
#define POSIX_MADV_WILLNEED MADV_WILLNEED
#define POSIX_MADV_RANDOM MADV_RANDOM
#endif
/* API19 has madvise/sched affinity but not later POSIX/pthread wrappers.
 * Memory advice is an optimization, not model computation. File readahead
 * keeps the kernel default. Optional foreign-thread affinity is unsupported.
 */
static inline int dior_posix_fadvise(int fd, off_t offset, off_t length, int advice) {
    (void)fd; (void)offset; (void)length; (void)advice; return 0;
}
static inline int dior_posix_madvise(void *addr, size_t length, int advice) {
    return madvise(addr,length,advice)==0 ? 0 : errno;
}
static inline int dior_pthread_getaffinity_np(pthread_t thread,size_t size,cpu_set_t *mask) {
    if (!pthread_equal(thread,pthread_self())) return ENOSYS;
    return sched_getaffinity(0,size,mask)==0 ? 0 : errno;
}
static inline int dior_pthread_setaffinity_np(pthread_t thread,size_t size,const cpu_set_t *mask) {
    if (!pthread_equal(thread,pthread_self())) return ENOSYS;
    return sched_setaffinity(0,size,mask)==0 ? 0 : errno;
}
#define posix_fadvise dior_posix_fadvise
#define posix_madvise dior_posix_madvise
#define pthread_getaffinity_np dior_pthread_getaffinity_np
#define pthread_setaffinity_np dior_pthread_setaffinity_np
#endif
