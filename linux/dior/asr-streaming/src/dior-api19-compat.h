#ifndef DIOR_ASR_API19_COMPAT_H
#define DIOR_ASR_API19_COMPAT_H
#ifdef __cplusplus
extern "C" {
#endif
/* API19 has rand(), but NDK declares rand_r() only for API21 and later. */
int rand_r(unsigned int *seed);
#ifdef __cplusplus
}
#endif
#endif
