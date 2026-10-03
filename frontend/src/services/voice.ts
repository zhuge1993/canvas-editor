export interface VoiceContext { kind: 'workspace' | 'project' | 'canvas'; id?: string }
export interface VoiceStatus { available: boolean; capabilities: { transcribe: boolean; chat: boolean; speech: boolean }; limits?: { recordingSeconds?: number } }
export interface VoiceAnswer { answer: string; spokenAnswer?: string; sources: Array<{ kind: string; id: string; title: string }>; dataAnswer: boolean; readOnly?: boolean; summaryOnly?: boolean; contextTruncated?: boolean; questionTruncated?: boolean }

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000)
    const response = await fetch(url, { ...init, signal, credentials: 'same-origin', cache: 'no-store' })
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string }
      const message = data.error && /preempt/i.test(data.error) ? '手机上的语音对话优先，本次请求已让出模型，请稍后重试。' : data.error && /busy|rate.limit/i.test(data.error) ? '手机正在处理其他语音，请稍后重试。' : data.error
      throw new Error(message || (response.status === 429 ? '手机正在处理其他语音，请稍后重试。' : response.status === 401 ? '请先登录后使用语音助手。' : response.status === 503 ? '手机语音服务暂未就绪，请稍后重试。' : `语音请求失败（${response.status}）`))
    }
    return response
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException('已取消', 'AbortError')
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new Error('手机处理超时，请稍后重试；原输入文字仍保留。')
    throw error instanceof TypeError ? new Error('连接中断，请检查网络后重试。') : error
  }
}

export async function voiceStatus(signal: AbortSignal): Promise<VoiceStatus> {
  return (await request('/api/voice/status', { signal })).json() as Promise<VoiceStatus>
}
export async function transcribeVoice(pcm: ArrayBuffer, signal: AbortSignal): Promise<{ text: string; durationMs?: number }> {
  if (!pcm.byteLength || pcm.byteLength > 640000 || pcm.byteLength % 2) throw new Error('请录制 20 秒以内的语音。')
  return (await request('/api/voice/transcribe', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm, signal })).json() as Promise<{ text: string; durationMs?: number }>
}
export async function askVoice(text: string, context: VoiceContext, signal: AbortSignal): Promise<VoiceAnswer> {
  return (await request('/api/voice/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, context }), signal })).json() as Promise<VoiceAnswer>
}
export async function speakVoice(text: string, signal: AbortSignal): Promise<Blob> {
  const response = await request('/api/voice/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal })
  const blob = await response.blob()
  if (!blob.size || blob.size > 2 * 1024 * 1024 || !blob.type.startsWith('audio/')) throw new Error('语音回复格式异常，请阅读文字回复。')
  return blob
}
