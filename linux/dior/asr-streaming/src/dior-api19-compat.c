#include "dior-api19-compat.h"
/* Park-Miller reentrant generator: deterministic local seed, no global state.
 * Feature dither is disabled by sherpa's default ASR extractor; this resolves
 * the dependency's optional Gaussian-dither path without a new libc symbol.
 */
int rand_r(unsigned int *seed) {
    long long x=*seed;
    if(!x) x=123459876;
    x=16807*(x%127773)-2836*(x/127773);
    if(x<0) x+=2147483647;
    *seed=(unsigned int)x;
    return (int)(x&2147483647);
}
