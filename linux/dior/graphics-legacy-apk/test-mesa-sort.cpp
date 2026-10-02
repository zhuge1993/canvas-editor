/* SPDX-License-Identifier: MIT
 * Compile the two actual Mesa sorting helpers, extracted verbatim after patch.
 * exec_node/exec_list are the real Mesa header implementations. The stand-in
 * nir_variable contains only the fields the sorting helpers inspect; this is
 * a CPU list/sorting regression, not full NIR ABI or physical GPU validation.
 */
#include <limits.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include "compiler/glsl/list.h"

struct nir_variable {
   exec_node node;
   const void *type;
   const char *name;
   struct {
      int mode;
      unsigned qualifiers;
      int depth_layout;
      int location;
   } data;
};

/* Exact wrappers from nir.h, needed only to compile the unpatched helpers in
 * the negative comparison. The positive raw-node helpers don't use them. */
#define nir_foreach_variable(var, list) \
   foreach_list_typed(nir_variable, var, node, list)
#define nir_foreach_variable_safe(var, list) \
   foreach_list_typed_safe(nir_variable, var, node, list)
#ifndef DIOR_SORT_TARGET_INCLUDE
#define DIOR_SORT_TARGET_INCLUDE "mesa-sort-helpers.inc"
#endif
#include DIOR_SORT_TARGET_INCLUDE

struct shader_lists {
   exec_list uniforms;
   exec_list inputs;
   exec_list outputs;
};
#if defined(__SIZEOF_POINTER__) && __SIZEOF_POINTER__ == 4
static_assert(sizeof(exec_node) == 8 && sizeof(exec_list) == 16,
              "actual ARM32 Mesa node/list layout");
static_assert(offsetof(nir_variable, node) == 0 &&
              offsetof(nir_variable, data.location) == 28,
              "stand-in fields match inspected ARM32 sorting target");
static_assert(offsetof(shader_lists, inputs) == 16 &&
              offsetof(shader_lists, outputs) == 32,
              "neighbor list placement matches ARM32 shader headers");
#endif

static void fail(const char *message)
{
   fprintf(stderr, "FAIL Mesa NIR sentinel sort: %s\n", message);
   exit(1);
}
#define CHECK(condition, message) do { if (!(condition)) fail(message); } while (0)

static void init_var(nir_variable *var, int mode, int location, const char *name)
{
   var->data.mode = mode;
   var->data.location = location;
   var->name = name;
}

static void check_list(exec_list *list, nir_variable *const *expected,
                       unsigned count, const char *message)
{
   exec_node *node = list->head_sentinel.next;
   exec_node *prev = &list->head_sentinel;
   CHECK(list->head_sentinel.prev == NULL, "head sentinel prev must be NULL");
   CHECK(list->tail_sentinel.next == NULL, "tail sentinel next must be NULL");
   for (unsigned i = 0; i < count; i++) {
      /* Compare identity before dereferencing; a corrupted/foreign chain is
       * an ordinary fixture failure, never another simulated variable. */
      CHECK(node == &expected[i]->node, message);
      CHECK(node->prev == prev && prev->next == node, "real-node linkage");
      prev = node;
      node = node->next;
   }
   CHECK(node == &list->tail_sentinel, message);
   CHECK(list->tail_sentinel.prev == prev && prev->next == node,
         "final tail linkage");
}

#if defined(__GNUC__)
__attribute__((noinline))
#endif
static void prime_local_stack(exec_node *valid_neighbor)
{
   /* Reuse dirty stack normally, with writes confined to this local array.
    * The actual helper must initialize its own sentinel before any read. */
   exec_node *volatile scratch[128];
   for (unsigned i = 0; i < 128; i++) scratch[i] = valid_neighbor;
#if defined(__GNUC__)
   __asm__ __volatile__("" : : "r"(scratch) : "memory");
#endif
}

static void call_actual_sort(exec_list *list, exec_node *valid_neighbor)
{
   /* A volatile function pointer preserves a separately compiled target;
    * the optimizer cannot inline the fixture and pre-sort known values. */
   void (*volatile actual)(exec_list *) = sort_varyings;
   prime_local_stack(valid_neighbor);
   actual(list);
}

static void run_case(const int *locations, unsigned count)
{
   shader_lists lists;
   nir_variable first = {}, second = {}, output = {}, values[8] = {};
   nir_variable *uniforms[] = { &first, &second };
   nir_variable *outputs[] = { &output };
   nir_variable *expected[8];
   CHECK(count <= 8, "fixture capacity");
   init_var(&first, 16, INT_MIN, "firstInput");
   init_var(&second, 16, INT_MAX, "secondInput");
   init_var(&output, 2, 0, "gl_FragColor");
   exec_list_push_tail(&lists.uniforms, &first.node);
   exec_list_push_tail(&lists.uniforms, &second.node);
   exec_list_push_tail(&lists.outputs, &output.node);
   for (unsigned i = 0; i < count; i++) {
      init_var(&values[i], 1, locations[i], "gl_FragCoord");
      exec_list_push_tail(&lists.inputs, &values[i].node);
      expected[i] = &values[i];
   }
   /* Independent stable ordering oracle based on indices, not list helpers. */
   for (unsigned i = 1; i < count; i++) {
      nir_variable *value = expected[i];
      unsigned j = i;
      while (j && expected[j-1]->data.location > value->data.location) {
         expected[j] = expected[j-1];
         j--;
      }
      expected[j] = value;
   }
   call_actual_sort(&lists.inputs, &first.node);
   check_list(&lists.inputs, expected, count, "sorted inputs including stable ties");
   check_list(&lists.uniforms, uniforms, 2, "adjacent uniform chain changed");
   check_list(&lists.outputs, outputs, 1, "adjacent output chain changed");
   for (unsigned i = 0; i < count; i++)
      CHECK(values[i].data.mode == 1, "sort must preserve input mode");
   CHECK(first.data.mode == 16 && second.data.mode == 16,
         "sort must preserve uniform mode");
   /* An idempotent sort has the same node identities and graph. */
   call_actual_sort(&lists.inputs, &first.node);
   check_list(&lists.inputs, expected, count, "idempotent stable sort");
   check_list(&lists.uniforms, uniforms, 2, "idempotent sort changed uniforms");
}

static void direct_insertion(void)
{
   exec_list sorted;
   nir_variable a = {}, b = {}, c = {};
   nir_variable *expected[] = { &b, &a, &c };
   init_var(&a, 1, 3, "a");
   init_var(&b, 1, 1, "b");
   init_var(&c, 1, 3, "c");
   insert_sorted(&sorted, &a);
   insert_sorted(&sorted, &b);
   insert_sorted(&sorted, &c);
   check_list(&sorted, expected, 3, "direct insertion order and stable tie");
}

int main(void)
{
   const int one[] = { INT_MAX-1 };
   const int ascending[] = { -5, 0, 3, 7 };
   const int descending[] = { 7, 3, 0, -5 };
   const int ties[] = { 3, 1, 3, -2, 1, 3, 0 };
   const int edges[] = { INT_MAX, INT_MIN, INT_MAX-1, 0, INT_MIN };
   for (unsigned repeat = 0; repeat < 32; repeat++) {
      run_case(NULL, 0);
      run_case(one, 1);
      run_case(ascending, 4);
      run_case(descending, 4);
      run_case(ties, 7);
      run_case(edges, 5);
   }
   direct_insertion();
   puts("PASS Mesa NIR sentinel sort: raw-node boundaries; empty/multiple/stable ties; adjacent uniforms unchanged");
   return 0;
}
