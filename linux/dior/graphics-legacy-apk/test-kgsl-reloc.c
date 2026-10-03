/* SPDX-License-Identifier: MIT
 * Compile the actual relocation implementation in release mode. This separate
 * translation unit avoids changing generic identifiers or struct fields to
 * disambiguate its static table from the kgsl_bo.c mapping test's table.
 */
#define NDEBUG 1
#include "freedreno/kgsl/kgsl_priv.h"
#include "freedreno_ringbuffer.h"
void dior_test_abort(void);
void dior_test_add_submit(struct kgsl_pipe *, struct kgsl_bo *);
#define abort dior_test_abort
#define kgsl_pipe_add_submit dior_test_add_submit
#include "freedreno/kgsl/kgsl_ringbuffer.c"
#undef kgsl_pipe_add_submit
#undef abort

void dior_test_emit_reloc(struct fd_ringbuffer *ring, const struct fd_reloc *relocation)
{
    kgsl_ringbuffer_emit_reloc(ring, relocation);
}
