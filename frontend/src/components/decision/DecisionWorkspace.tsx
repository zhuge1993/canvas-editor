import { useEffect, useRef, useState } from 'react'
import { BarChart3, LoaderCircle, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { decisionStatus, evaluateDecision } from '@/services/decision'
import type { DecisionContext, DecisionQuestion, DecisionResult } from '@/services/decision'
import './decision.css'

type ContextOption = { label: string; value: string; context: DecisionContext }
const workspace: ContextOption = { label: '我的工作台', value: 'workspace', context: { kind: 'workspace' } }
const message = (error: unknown) => error instanceof Error ? error.message : '判断失败，请重试'
const defaultQuestions = { choice: '这段内容应该归到哪一类？', boolean: '这段内容是否描述了程序问题？', score: '这件事有多紧急？' }

export default function DecisionWorkspace() {
  const location = useLocation()
  const [signedIn, setSignedIn] = useState(false), [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null), [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [state, setState] = useState(''), [question, setQuestion] = useState('这段内容应该归到哪一类？')
  const [kind, setKind] = useState<DecisionQuestion['type']>('choice')
  const [choiceOptions, setChoiceOptions] = useState('需求建议\n程序问题\n进度查询\n其他')
  const [scoreOptions, setScoreOptions] = useState('低\n中\n高')
  const options = kind === 'score' ? scoreOptions : choiceOptions
  const setOptions = kind === 'score' ? setScoreOptions : setChoiceOptions
  const [contexts, setContexts] = useState<ContextOption[]>([workspace]), [scope, setScope] = useState('workspace')
  const [result, setResult] = useState<DecisionResult | null>(null), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), sequence = useRef(0)

  function cancel() { sequence.current++; request.current?.abort(); request.current = null; setBusy(false) }
  useEffect(() => {
    cancel(); setOpen(false); setResult(null); setState(''); setError(''); setSignedIn(false); setAvailable(null); setContexts([workspace]); setScope('workspace')
    if (/^\/(auth|register|project-invite)(\/|$)/.test(location.pathname)) return
    const controller = new AbortController()
    void fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null).then(data => { if (!controller.signal.aborted) setSignedIn(Boolean(data?.user)) }).catch(() => {})
    return () => { controller.abort(); cancel() }
  }, [location.pathname])

  useEffect(() => {
    if (!open || !signedIn) return
    const controller = new AbortController()
    setAvailable(null)
    void decisionStatus(controller.signal).then(status => { if (!controller.signal.aborted) { setAvailable(status.available); setCooling(status.cooling === true) } }).catch(() => { if (!controller.signal.aborted) setAvailable(false) })
    const read = async (url: string) => {
      const response = await fetch(url, { credentials: 'same-origin', signal: controller.signal })
      if (!response.ok) return []
      return response.json() as Promise<Array<{ id: string; name?: string; title?: string }>>
    }
    void Promise.allSettled([read('/api/management/projects'), read('/api/projects')]).then(rows => {
      if (controller.signal.aborted) return
      const values = [workspace]
      rows.forEach((row, index) => {
        if (row.status !== 'fulfilled' || !Array.isArray(row.value)) return
        row.value.slice(0, 80).forEach(item => values.push({ label: `${index ? '画布' : '项目'} · ${item.name || item.title || '未命名'}`, value: `${index ? 'canvas' : 'project'}:${item.id}`, context: { kind: index ? 'canvas' : 'project', id: item.id } }))
      })
      setContexts(values)
    })
    return () => controller.abort()
  }, [open, signedIn])

  async function submit() {
    if (busy) return
    setError(''); setResult(null)
    const candidates = options.split('\n').map(text => text.trim()).filter(Boolean)
    if (!state.trim() || !question.trim()) { setError('请输入待判断内容和问题'); return }
    if (kind !== 'boolean' && (candidates.length < 2 || candidates.length > (kind === 'score' ? 10 : 16) || new Set(candidates).size !== candidates.length)) { setError('请输入至少两个不同选项，每行一个'); return }
    const q: DecisionQuestion = { id: 'answer', type: kind, question,
      ...(kind === 'choice' ? { options: Object.fromEntries(candidates.map((text, i) => [`option_${i}`, text])) } : {}), ...(kind === 'score' ? { levels: candidates } : {}) }
    const controller = new AbortController(), ticket = ++sequence.current
    request.current = controller; setBusy(true)
    try {
      const reply = await evaluateDecision(state, [q], contexts.find(item => item.value === scope)?.context || workspace.context, controller.signal)
      if (ticket === sequence.current) setResult(reply)
    } catch (cause) { if (ticket === sequence.current && !controller.signal.aborted) setError(message(cause)) }
    finally { if (ticket === sequence.current) { setBusy(false); request.current = null } }
  }

  if (!signedIn) return null
  const answer = result?.answers[0]
  const labels = answer?.type === 'choice' ? options.split('\n').map(text => text.trim()).filter(Boolean) : answer?.type === 'score' ? answer.legend || [] : ['是', '否']
  return <div className="fb-decision-root">
    <button className="fb-decision-toggle" type="button" aria-expanded={open} onClick={() => { cancel(); setOpen(!open) }}><BarChart3 size={17} />概率判断</button>
    {open && <section className="fb-decision-panel" role="dialog" aria-label="概率判断">
      <header><div><h2>概率判断</h2><p>选择、真假或评分，直接查看各项概率。</p></div><button type="button" aria-label="关闭概率判断" onClick={() => { cancel(); setOpen(false) }}><X size={20} /></button></header>
      <div className="fb-decision-fields">
        {available !== true && <p role="status">{available === null ? '正在检查模型…' : cooling ? '手机温度偏高，模型正在冷却，请稍后重新打开。' : '模型服务尚未就绪，请稍后重新打开。'}</p>}
        <label>参考范围<select value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setResult(null) }}>{contexts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label>待判断内容<textarea aria-label="待判断内容" rows={3} value={state} disabled={busy} maxLength={3000} onChange={event => { setState(event.target.value); setResult(null) }} placeholder="例如：保存画布后，新增的图形消失了。" /></label>
        <label>判断方式<select value={kind} disabled={busy} onChange={event => { const next = event.target.value as DecisionQuestion['type']; if (Object.values(defaultQuestions).includes(question)) setQuestion(defaultQuestions[next]); setKind(next); setResult(null) }}><option value="choice">选择最合适的选项</option><option value="boolean">判断是或否</option><option value="score">按等级评分</option></select></label>
        <label>判断问题<input aria-label="判断问题" value={question} disabled={busy} maxLength={500} onChange={event => { setQuestion(event.target.value); setResult(null) }} /></label>
        {kind !== 'boolean' && <label>{kind === 'score' ? '评分等级（从低到高，每行一个）' : '候选选项（每行一个）'}<textarea aria-label="候选选项" rows={4} value={options} disabled={busy} onChange={event => { setOptions(event.target.value); setResult(null) }} /></label>}
        {error && <p className="fb-decision-error" role="alert">{error}</p>}
        <button className="fb-decision-submit" type="button" disabled={busy || !state.trim() || available !== true} onClick={() => void submit()}>{busy ? <><LoaderCircle size={16} className="fb-decision-spin" />正在判断…</> : '开始判断'}</button>
        {busy && <button type="button" onClick={cancel}>取消等待</button>}
        {answer && <div className="fb-decision-result" aria-live="polite"><strong>{answer.type === 'choice' ? answer.description : answer.type === 'boolean' ? answer.value ? '判断结果：是' : '判断结果：否' : `评分：${answer.score?.toFixed(2)}`}</strong>
          {Object.entries(answer.distribution).map(([key, probability], index) => <div className="fb-decision-probability" key={key}><span>{labels[index] || key}</span><progress max={1} value={probability} /><b>{(probability * 100).toFixed(1)}%</b></div>)}
          <small>概率表示模型对当前选项的判断。</small>
          {!!result?.sources.length && <p>参考：{result.sources.map(source => source.title).join('、')}</p>}
        </div>}
        <small>参考所选范围的文字摘要，仅作判断。</small>
      </div>
    </section>}
  </div>
}
