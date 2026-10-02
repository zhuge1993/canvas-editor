/* SPDX-License-Identifier: MIT
 * Compile the production KGSL ring implementation. Only syscalls, allocation
 * failure injection and external pipe/GEM dependencies are substituted.
 * Expected active command allocations are declared independently by each test.
 */
#include "freedreno/kgsl/kgsl_priv.h"
#include "freedreno_ringbuffer.h"
#include <setjmp.h>
#include <stdarg.h>
#include <limits.h>

static int test_ioctl(int, unsigned long, ...);
static int test_fcntl(int, int, ...);
static int test_close(int);
static void *test_mmap(void *, size_t, int, int, int, off_t);
static int test_munmap(void *, size_t);
static void *test_calloc(size_t, size_t);
static void *test_realloc(void *, size_t);
static void test_abort(void);
#define ioctl test_ioctl
#define fcntl test_fcntl
#define close test_close
#undef drm_mmap
#define drm_mmap test_mmap
#undef drm_munmap
#define drm_munmap test_munmap
#define calloc test_calloc
#define realloc test_realloc
#define abort test_abort
#include "freedreno/kgsl/kgsl_ringbuffer.c"
#include "freedreno/freedreno_ringbuffer.c"
#undef ioctl
#undef fcntl
#undef close
#undef calloc
#undef realloc
#undef abort

struct allocation {
	uint32_t address;
	void *memory;
	size_t size;
	int freed;
	int busy[2];
	uint32_t timestamp[2];
};
static struct allocation allocations[64];
static int allocation_count, next_fd, fd_owner[512], fd_open[512];
static int free_calls, map_calls, unmap_calls, close_calls, wait_calls, submit_calls;
static int allocation_calls, fail_calloc, fail_realloc, fail_fcntl, fail_gpu_alloc, fail_map;
static int wait_error, abort_expected;
static uint32_t expected[8], next_timestamp;
static unsigned expected_count;
static struct kgsl_pipe pipes[2];
static int context_destroyed[2];
static jmp_buf abort_jump;
static const struct fd_pipe_funcs test_pipe_funcs = { .ringbuffer_new = kgsl_ringbuffer_new };

static unsigned owner_index(int fd)
{
	assert(fd >= 0 && fd < 512 && fd_open[fd]);
	assert(fd_owner[fd] == 13 || fd_owner[fd] == 14);
	return (unsigned)(fd_owner[fd] - 13);
}

static struct allocation *allocation(uint32_t address)
{
	int index;
	for (index = 0; index < allocation_count; index++)
		if (allocations[index].address == address) return &allocations[index];
	assert(!"unknown command allocation");
	return NULL;
}

static void *test_calloc(size_t count, size_t size)
{
	allocation_calls++;
	if (fail_calloc && --fail_calloc == 0) { errno = ENOMEM; return NULL; }
	return calloc(count, size);
}

static void *test_realloc(void *pointer, size_t size)
{
	if (fail_realloc) { errno = ENOMEM; return NULL; }
	return realloc(pointer, size);
}

static int test_fcntl(int fd, int command, ...)
{
	unsigned owner = owner_index(fd);
	assert(command == F_DUPFD_CLOEXEC);
	if (fail_fcntl && --fail_fcntl == 0) { errno = EMFILE; return -1; }
	assert(next_fd < 512);
	fd_open[next_fd] = 1;
	fd_owner[next_fd] = 13 + (int)owner;
	return next_fd++;
}

static int test_close(int fd)
{
	(void)owner_index(fd);
	assert(fd >= 32);
	fd_open[fd] = 0;
	close_calls++;
	return 0;
}

static void *test_mmap(void *address, size_t size, int prot, int flags, int fd, off_t offset)
{
	struct allocation *item = allocation((uint32_t)offset);
	(void)owner_index(fd);
	assert(!address && size == item->size);
	assert(prot == (PROT_READ | PROT_WRITE) && flags == MAP_SHARED);
	map_calls++;
	if (fail_map) { errno = EIO; return MAP_FAILED; }
	return item->memory;
}

static int test_munmap(void *address, size_t size)
{
	int index;
	for (index = 0; index < allocation_count; index++)
		if (allocations[index].memory == address) {
			assert(size == allocations[index].size);
			assert(!allocations[index].busy[0] && !allocations[index].busy[1]);
			unmap_calls++;
			return 0;
		}
	assert(!"unknown command mmap");
	return -1;
}

static int test_ioctl(int fd, unsigned long command, ...)
{
	va_list arguments;
	void *data;
	unsigned owner = owner_index(fd), index;
	va_start(arguments, command);
	data = va_arg(arguments, void *);
	va_end(arguments);
	if (command == IOCTL_KGSL_GPUMEM_ALLOC) {
		struct kgsl_gpumem_alloc *value = data;
		struct allocation *item;
		if (fail_gpu_alloc) { errno = ENOMEM; return -1; }
		assert(allocation_count < 64 && value->flags == KGSL_MEMFLAGS_GPUREADONLY);
		item = &allocations[allocation_count++];
		item->address = 0x10000000 + (uint32_t)allocation_count * 0x20000;
		item->size = value->size;
		item->memory = malloc(item->size);
		assert(item->memory);
		value->gpuaddr = item->address;
		return 0;
	}
	if (command == IOCTL_KGSL_RINGBUFFER_ISSUEIBCMDS) {
		struct kgsl_ringbuffer_issueibcmds *value = data;
		assert(value->drawctxt_id == pipes[owner].drawctxt_id);
		assert(value->numibs == 1 && value->flags == KGSL_CONTEXT_SUBMIT_IB_LIST);
		submit_calls++;
		for (index = 0; index < expected_count; index++) {
			struct allocation *item = allocation(expected[index]);
			assert(!item->freed);
			item->busy[owner] = 1;
			item->timestamp[owner] = next_timestamp;
		}
		value->timestamp = next_timestamp;
		return 0;
	}
	if (command == IOCTL_KGSL_DEVICE_WAITTIMESTAMP_CTXTID) {
		struct kgsl_device_waittimestamp_ctxtid *value = data;
		assert(value->context_id == pipes[owner].drawctxt_id && value->timeout == 5000);
		assert(!context_destroyed[owner]);
		wait_calls++;
		if (wait_error) { errno = wait_error; return -1; }
		for (index = 0; index < (unsigned)allocation_count; index++)
			if (allocations[index].busy[owner] &&
			    (int32_t)(value->timestamp - allocations[index].timestamp[owner]) >= 0)
				allocations[index].busy[owner] = 0;
		return 0;
	}
	if (command == IOCTL_KGSL_SHAREDMEM_FREE) {
		struct kgsl_sharedmem_free *value = data;
		struct allocation *item = allocation(value->gpuaddr);
		assert(!item->freed && !item->busy[0] && !item->busy[1]);
		item->freed = 1;
		free(item->memory);
		item->memory = NULL;
		free_calls++;
		return 0;
	}
	assert(!"unexpected real GPU syscall path");
	return -1;
}

static void test_abort(void)
{
	assert(abort_expected);
	longjmp(abort_jump, 1);
}

/* External GEM/pipe dependencies are not the ring lifetime targets. */
void kgsl_pipe_pre_submit(struct kgsl_pipe *pipe) { (void)pipe; }
void kgsl_pipe_post_submit(struct kgsl_pipe *pipe, uint32_t timestamp) { (void)pipe; (void)timestamp; }
void kgsl_pipe_add_submit(struct kgsl_pipe *pipe, struct kgsl_bo *bo) { (void)pipe; (void)bo; assert(!"unexpected GEM relocation"); }
uint32_t kgsl_bo_gpuaddr(struct kgsl_bo *bo, uint32_t offset) { (void)bo; (void)offset; assert(!"unexpected GEM address path"); return 0; }
struct kgsl_pipe *kgsl_cmd_pipe_ref(struct kgsl_pipe *pipe) { atomic_inc(&pipe->cmd_refs); return pipe; }
void kgsl_cmd_pipe_put(struct kgsl_pipe *pipe) { assert(atomic_read(&pipe->cmd_refs) > 0); if(atomic_dec_and_test(&pipe->cmd_refs)) context_destroyed[pipe == &pipes[1]]++; }

static void reset_test(void)
{
	int index;
	assert(!abort_expected);
	for (index = 0; index < allocation_count; index++) assert(allocations[index].freed);
	for (index = 32; index < next_fd; index++) assert(!fd_open[index]);
	memset(allocations, 0, sizeof(allocations));
	memset(fd_open, 0, sizeof(fd_open));
	memset(fd_owner, 0, sizeof(fd_owner));
	memset(pipes, 0, sizeof(pipes));
	memset(context_destroyed, 0, sizeof(context_destroyed));
	for (index = 0; index < 2; index++) {
		pipes[index].fd = 13 + index;
		pipes[index].base.id = FD_PIPE_3D;
		pipes[index].base.funcs = &test_pipe_funcs;
		pipes[index].drawctxt_id = 41 + index;
		atomic_set(&pipes[index].cmd_refs, 1);
		fd_open[13 + index] = 1;
		fd_owner[13 + index] = 13 + index;
	}
	allocation_count = free_calls = wait_calls = submit_calls = 0;
	map_calls = unmap_calls = close_calls = allocation_calls = 0;
	fail_calloc = fail_realloc = fail_fcntl = fail_gpu_alloc = fail_map = wait_error = 0;
	next_fd = 32;
	next_timestamp = 1;
	expected_count = 0;
}

static struct fd_ringbuffer *new_ring(unsigned owner)
{
	struct fd_ringbuffer *ring = fd_ringbuffer_new(&pipes[owner].base, 4096);
	assert(ring);
	assert(ring->size == 4096 && ring->end == ring->start + 1024);
	assert(ring->cur == ring->start && ring->last_start == ring->start);
	*ring->cur++ = 0; /* A nonempty mocked command stream. */
	return ring;
}

static uint32_t address(struct fd_ringbuffer *ring)
{
	return to_kgsl_ringbuffer(ring)->bo->gpuaddr;
}

static void nested(struct fd_ringbuffer *parent, struct fd_ringbuffer *child)
{
	assert(fd_ringbuffer_emit_reloc_ring_full(parent, child, 0) > 0);
}

static void flush(struct fd_ringbuffer *ring, const uint32_t *addresses, unsigned count, uint32_t timestamp)
{
	assert(count <= 8);
	memcpy(expected, addresses, count * sizeof(*addresses));
	expected_count = count;
	next_timestamp = timestamp;
	assert(fd_ringbuffer_flush(ring) == 0);
}

static void basic_order(int child_first)
{
	struct fd_ringbuffer *parent, *child;
	uint32_t addresses[2];
	reset_test();
	parent = new_ring(0); child = new_ring(0);
	addresses[0] = address(parent); addresses[1] = address(child);
	nested(parent, child);
	flush(parent, addresses, 2, 1);
	if (child_first) {
		fd_ringbuffer_del(child);
		assert(!allocation(addresses[1])->freed);
		fd_ringbuffer_del(parent);
	} else {
		fd_ringbuffer_del(parent);
		assert(!allocation(addresses[1])->freed);
		fd_ringbuffer_del(child);
	}
	assert(allocation(addresses[0])->freed && allocation(addresses[1])->freed);
	assert(atomic_read(&pipes[0].cmd_refs) == 1);
}

static void transitive_and_early_wrapper_delete(void)
{
	struct fd_ringbuffer *parent, *middle, *leaf;
	uint32_t addresses[3];
	reset_test();
	parent=new_ring(0); middle=new_ring(0); leaf=new_ring(0);
	addresses[0]=address(parent); addresses[1]=address(middle); addresses[2]=address(leaf);
	nested(parent, middle);
	nested(middle, leaf); /* Dependency added after the parent reference. */
	fd_ringbuffer_del(middle); fd_ringbuffer_del(leaf);
	assert(!allocation(addresses[1])->freed && !allocation(addresses[2])->freed);
	flush(parent, addresses, 3, 7);
	fd_ringbuffer_del(parent);
	assert(allocation(addresses[0])->freed && allocation(addresses[1])->freed && allocation(addresses[2])->freed);
}

static void multiple_parents_and_repeat(void)
{
	struct fd_ringbuffer *first, *second, *child;
	uint32_t a[2], b[2];
	reset_test();
	first=new_ring(0); second=new_ring(1); child=new_ring(0);
	a[0]=address(first); a[1]=address(child); b[0]=address(second); b[1]=a[1];
	nested(first,child); nested(first,child); nested(second,child);
	assert(atomic_read(&to_kgsl_ringbuffer(child)->bo->references) == 3);
	flush(first,a,2,1); flush(second,b,2,7);
	kgsl_cmd_pipe_put(&pipes[0]); kgsl_cmd_pipe_put(&pipes[1]); /* Caller deletes both contexts. */
	assert(!context_destroyed[0] && !context_destroyed[1]);
	fd_ringbuffer_del(child); fd_ringbuffer_del(first);
	assert(!allocation(a[1])->freed && allocation(a[1])->busy[1]);
	fd_ringbuffer_del(second);
	assert(allocation(a[0])->freed && allocation(b[0])->freed && allocation(a[1])->freed);
	assert(atomic_read(&pipes[0].cmd_refs)==0 && atomic_read(&pipes[1].cmd_refs)==0);
	assert(context_destroyed[0]==1 && context_destroyed[1]==1);
}

static void shared_reset_preserves_old_commands(void)
{
	struct fd_ringbuffer *parent,*middle,*leaf;
	uint32_t addresses[3], before;
	reset_test();parent=new_ring(0);middle=new_ring(0);leaf=new_ring(0);
	addresses[0]=address(parent);addresses[1]=address(middle);addresses[2]=address(leaf);
	nested(parent,middle);nested(middle,leaf);
	before=((uint32_t*)allocation(addresses[1])->memory)[1];
	fd_ringbuffer_reset(middle);
	assert(address(middle)!=addresses[1]);
	*middle->cur++=0xdeadbeef;
	assert(((uint32_t*)allocation(addresses[1])->memory)[1]==before);
	fd_ringbuffer_del(middle);fd_ringbuffer_del(leaf);
	assert(!allocation(addresses[1])->freed && !allocation(addresses[2])->freed);
	flush(parent,addresses,3,3);fd_ringbuffer_del(parent);
	assert(allocation(addresses[0])->freed && allocation(addresses[1])->freed && allocation(addresses[2])->freed);
}

static void timestamp_wrap_and_reset(void)
{
	struct fd_ringbuffer *parent,*child;
	uint32_t addresses[2];
	reset_test(); parent=new_ring(0); child=new_ring(0);
	addresses[0]=address(parent); addresses[1]=address(child); nested(parent,child);
	flush(parent,addresses,2,UINT32_MAX-1);
	nested(parent,child); flush(parent,addresses,2,0); /* Zero is a valid wrapped fence. */
	assert(to_kgsl_ringbuffer(child)->bo->fences->timestamp == 0);
	fd_ringbuffer_del(child);
	fd_ringbuffer_reset(parent);
	assert(allocation(addresses[1])->freed && !to_kgsl_ringbuffer(parent)->bo->dependencies);
	fd_ringbuffer_del(parent);
	assert(allocation(addresses[0])->freed && allocation(addresses[1])->freed);
}

static void allocation_rollback(void)
{
	struct fd_ringbuffer *ring,*child;
	int number;
	for(number=1;number<=2;number++) {
		reset_test(); fail_calloc=number;
		assert(fd_ringbuffer_new(&pipes[0].base,4096)==NULL);
		assert(free_calls==0);
	}
	reset_test(); fail_fcntl=1;
	assert(fd_ringbuffer_new(&pipes[0].base,4096)==NULL && free_calls==0);
	reset_test(); fail_gpu_alloc=1;
	assert(fd_ringbuffer_new(&pipes[0].base,4096)==NULL && free_calls==0 && close_calls==1);
	reset_test(); fail_map=1;
	assert(fd_ringbuffer_new(&pipes[0].base,4096)==NULL && free_calls==1 && close_calls==1);
	reset_test(); ring=new_ring(0); child=new_ring(0); nested(ring,child);
	fail_realloc=1;
	assert(fd_ringbuffer_flush(ring)==-ENOMEM && submit_calls==0);
	fail_realloc=0; fail_fcntl=2;
	assert(fd_ringbuffer_flush(ring)==-ENOMEM && submit_calls==0);
	assert(atomic_read(&pipes[0].cmd_refs)==1);
	fail_fcntl=0;
	fd_ringbuffer_del(child); fd_ringbuffer_del(ring);
	assert(wait_calls==0);
}

static void wait_failure_does_not_free(void)
{
	struct fd_ringbuffer *parent,*child;
	struct kgsl_rb_bo *saved;
	uint32_t addresses[2];
	int freed,unmapped,closed;
	reset_test(); parent=new_ring(0); child=new_ring(0);
	addresses[0]=address(parent);addresses[1]=address(child);nested(parent,child);
	flush(parent,addresses,2,1);fd_ringbuffer_del(child);
	saved=to_kgsl_ringbuffer(parent)->bo;
	freed=free_calls;unmapped=unmap_calls;closed=close_calls;
	wait_error=ETIMEDOUT;abort_expected=1;
	if(setjmp(abort_jump)==0) {
		fd_ringbuffer_del(parent);
		assert(!"unretired command BO destruction must fail closed");
	}
	assert(free_calls==freed && unmap_calls==unmapped && close_calls==closed);
	assert(allocation(addresses[0])->busy[0] && allocation(addresses[1])->busy[0]);
	/* Test-only repair after the substituted abort: production terminates. */
	abort_expected=0;wait_error=0;atomic_set(&saved->references,1);
	fd_ringbuffer_del(parent);
	assert(allocation(addresses[0])->freed && allocation(addresses[1])->freed);
}

int main(void)
{
	basic_order(1);basic_order(0);
	transitive_and_early_wrapper_delete();multiple_parents_and_repeat();
	shared_reset_preserves_old_commands();
	timestamp_wrap_and_reset();allocation_rollback();wait_failure_does_not_free();
	reset_test();
	puts("PASS KGSL command BO lifetime: child-first/parent-first, transitive nested, duplicate/multiple-parent fences, wrap-zero, rollback, wait-failure no FREE");
	return 0;
}
