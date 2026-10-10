export type DecisionContext = { kind: 'workspace' | 'project' | 'canvas'; id?: string }
export type DecisionAnswer = { id: string; type: 'choice' | 'boolean' | 'score'; value: string | boolean; distribution: Record<string, number>; description?: string; probability?: number; score?: number; legend?: string[] }
export type DecisionResult = { model: string; answers: DecisionAnswer[]; readOnly: boolean; sources: Array<{ kind: string; id: string; title: string }> }
export type DecisionQuestion = { id: string; type: 'choice' | 'boolean' | 'score'; question: string; options?: Record<string, string>; levels?: string[] }

async function request<T>(path: string, signal: AbortSignal, value?: unknown): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal,
    ...(value ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}) })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '判断失败，请重试')
  return data as T
}
export const decisionStatus = (signal: AbortSignal) => request<{ available: boolean; cooling?: boolean; model: string }>('/api/decision/status', signal)
export const evaluateDecision = (state: string, questions: DecisionQuestion[], context: DecisionContext, signal: AbortSignal) => request<DecisionResult>('/api/decision/evaluate', signal, { state, questions, context })
