<script lang="ts">
  import type { AgentImageTaskBlock } from '$lib/api/types/agent';
  import { t } from '$lib/i18n';
  import { imageUrl, thumbnailUrl } from '$lib/utils/format';

  let { block, onOpen, onEdit }: { block: AgentImageTaskBlock; onOpen: (imageId: string) => void; onEdit: (imageId: string, prompt: string) => Promise<boolean> } = $props();

  let thumbFailed = $state(false);
  let editPrompt = $state('');
  let editSending = $state(false);
  let editError = $state('');

  const label = $derived($t.agent.imageLabel(block.path_round_no ?? block.round_no, block.image_index));
  const deleted = $derived(block.status === 'succeeded' && (Boolean(block.deleted) || !block.image_id));
  const ready = $derived(block.status === 'succeeded' && !deleted && Boolean(block.image_id && block.filename));
  const stageLabel = $derived(($t.stages as Record<string, string>)[block.stage] ?? '');
  const statusLabel = $derived(
    block.status === 'succeeded'
      ? deleted
        ? $t.agent.imageDeleted
        : $t.agent.imageSucceeded
      : block.status === 'failed'
        ? $t.agent.imageFailed
        : block.status === 'cancelled'
          ? $t.agent.imageCancelled
          : stageLabel || $t.agent.imageWaiting
  );
  const source = $derived(
    block.filename ? (thumbFailed ? imageUrl(block.filename) : thumbnailUrl(block.filename)) : ''
  );

  async function submitEdit() {
    if (!block.image_id || !editPrompt.trim() || editSending) return;
    editSending = true;
    editError = '';
    try {
      const ok = await onEdit(block.image_id, editPrompt.trim());
      if (ok) editPrompt = '';
      else editError = '修改请求未发送成功，请检查提示词或稍后重试。';
    } catch {
      editError = '修改请求失败，请稍后重试。';
    } finally {
      editSending = false;
    }
  }
</script>

<figure class="w-36 sm:w-40" data-testid="agent-image-task" data-status={block.status}>
  {#if ready && block.image_id}
    <div class="group relative">
      <button
        type="button"
        class="control-focus app-well block w-full overflow-hidden rounded-lg border border-stone-200 dark:border-zinc-800"
        aria-label={$t.agent.openImage(label)}
        onclick={() => onOpen(block.image_id as string)}
      >
        <img
          src={source}
          alt={block.prompt.slice(0, 140)}
          loading="lazy"
          class="aspect-square w-full object-cover"
          onerror={() => (thumbFailed = true)}
        />
      </button>
      <button
        type="button"
        class="absolute right-1.5 top-1.5 rounded-md border border-white/20 bg-black/75 px-2.5 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-black focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        aria-label={`编辑图片：${label}`}
        title="打开图片查看器"
        onclick={() => onOpen(block.image_id as string)}
      >
        编辑
      </button>
    </div>
  {:else}
    <div
      class="app-well flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-stone-300 p-2 text-center text-xs text-stone-500 dark:border-zinc-700 dark:text-zinc-400"
    >
      {statusLabel}
    </div>
  {/if}
  <figcaption class="mt-1.5 space-y-0.5 text-xs">
    <span class="block font-medium text-stone-800 dark:text-zinc-200">{label}</span>
    {#if block.mode === 'edit' && block.source_refs.length}
      <span class="block truncate text-stone-500 dark:text-zinc-500" title={block.source_refs.join(', ')}>
        {$t.agent.editsFrom(block.source_refs.join(', '))}
      </span>
    {/if}
    {#if ready}
      <span class="sr-only">{statusLabel}</span>
    {:else if block.status === 'failed' && block.error}
      <span class="block text-red-700 dark:text-red-200" data-testid="agent-image-error">{block.error}</span>
    {/if}
  </figcaption>
  {#if ready && block.image_id}
    <form class="mt-2 space-y-1.5" onsubmit={(event) => { event.preventDefault(); void submitEdit(); }}>
      <label class="sr-only" for="edit-image-{block.id}">Describe how to edit this image</label>
      <textarea
        id="edit-image-{block.id}"
        class="ui-field w-full resize-y p-2 text-xs"
        rows="2"
        maxlength="4000"
        placeholder="输入修改词，继续编辑这张图…"
        bind:value={editPrompt}
        disabled={editSending}
      ></textarea>
      <div class="flex gap-1">
        <button type="button" class="ui-button-secondary min-w-0 flex-1 text-xs" onclick={() => onOpen(block.image_id as string)}>涂抹 / 查看</button>
        <button type="submit" class="ui-button-primary min-w-0 flex-1 text-xs" disabled={editSending || !editPrompt.trim()}>{editSending ? '发送中…' : '按提示修改'}</button>
      </div>
      {#if editError}<p class="text-xs text-red-700 dark:text-red-300" role="alert">{editError}</p>{/if}
    </form>
  {/if}
</figure>
