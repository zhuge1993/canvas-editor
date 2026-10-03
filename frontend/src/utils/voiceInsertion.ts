export type VoiceTarget = { element: HTMLInputElement | HTMLTextAreaElement; value: string; start: number; end: number; label: string } | { element: HTMLElement; value: string; range: Range; label: string }

export function captureVoiceTarget(element: Element | null): VoiceTarget | null {
  if (!(element instanceof HTMLElement) || element.closest('[data-voice-ui],[data-voice-disabled]')) return null
  const label = element.getAttribute('aria-label') || element.getAttribute('placeholder') || '当前文本'
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly || (element instanceof HTMLInputElement && !['text', 'search'].includes(element.type)) || /password|one-time-code/.test(element.autocomplete)) return null
    return { element, value: element.value, start: element.selectionStart ?? element.value.length, end: element.selectionEnd ?? element.value.length, label }
  }
  if (element.isContentEditable) {
    const selection = window.getSelection()
    if (!selection?.rangeCount) return null
    const range = selection.getRangeAt(0)
    if (!element.contains(range.commonAncestorContainer)) return null
    return { element, value: element.textContent ?? '', range: range.cloneRange(), label }
  }
  return null
}

/** Never overwrite another edit made during recognition or target a newly focused field. */
export function insertVoiceText(target: VoiceTarget, text: string): void {
  const element = target.element
  if (!element.isConnected) throw new Error('原输入框已关闭，识别文字保留在下方，可复制后使用。')
  if ('start' in target) {
    const field = target.element as HTMLInputElement | HTMLTextAreaElement
    if (field.disabled || field.readOnly || field.value !== target.value) throw new Error('原输入框内容已有变化，请复制识别文字，避免覆盖新编辑。')
    const value = target.value.slice(0, target.start) + text + target.value.slice(target.end)
    if (field.maxLength >= 0 && value.length > field.maxLength) throw new Error('识别文字超过此字段的长度限制，请复制后缩短。')
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    field.focus({ preventScroll: true })
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    field.setSelectionRange(target.start + text.length, target.start + text.length)
  } else {
    if (!element.isContentEditable || (element.textContent ?? '') !== target.value || !element.contains(target.range.commonAncestorContainer)) throw new Error('原编辑位置已变化，请复制识别文字后使用。')
    element.focus({ preventScroll: true })
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(target.range)
    if (!document.execCommand('insertText', false, text)) {
      const node = document.createTextNode(text)
      target.range.deleteContents(); target.range.insertNode(node); target.range.setStartAfter(node); target.range.collapse(true)
      selection?.removeAllRanges(); selection?.addRange(target.range)
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    }
  }
}
