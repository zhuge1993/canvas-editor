import { useEffect, useRef, useState } from 'react'
import { BarChart3, LoaderCircle, X } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { decisionStatus, evaluateDecision } from '@/services/decision'
import type { DecisionContext, DecisionQuestion, DecisionResult } from '@/services/decision'
import './decision.css'

type ContextOption = { label: string; value: string; context: DecisionContext }
const workspace: ContextOption = { label: '我的工作台', value: 'workspace', context: { kind: 'workspace' } }
const message = (error: unknown) => error instanceof Error ? error.message : '判断失败，请重试'
const defaultQuestions = { choice: '内容分类', boolean: '功能状态', score: '紧急程度' }

export default function DecisionWorkspace() {
  const location = useLocation()
  const [signedIn, setSignedIn] = useState(false), [open, setOpen] = useState(false)
  const [rootAdmin, setRootAdmin] = useState(false)
  const [available, setAvailable] = useState<boolean | null>(null), [busy, setBusy] = useState(false)
  const [cooling, setCooling] = useState(false)
  const [yes, setYes] = useState('程序故障，功能异常，页面无法打开'), [no, setNo] = useState('程序正常，功能可用，页面能够打开')
  const [state, setState] = useState(''), [question, setQuestion] = useState('内容分类')
  const [kind, setKind] = useState<DecisionQuestion['type']>('choice')
  const [choiceOptions, setChoiceOptions] = useState('需求建议，希望增加新功能\n程序故障，功能异常或无法使用\n进度查询，询问工作完成情况\n其他，日常问候或闲聊')
  const [scoreOptions, setScoreOptions] = useState('不紧急，可以以后再做\n一般紧急，按计划处理\n非常紧急，核心功能受影响，需要立即修复')
  const options = kind === 'score' ? scoreOptions : choiceOptions
  const setOptions = kind === 'score' ? setScoreOptions : setChoiceOptions
  const [contexts, setContexts] = useState<ContextOption[]>([workspace]), [scope, setScope] = useState('workspace')
  const [result, setResult] = useState<DecisionResult | null>(null), [error, setError] = useState('')
  const request = useRef<AbortController | null>(null), sequence = useRef(0)

  function cancel() { sequence.current++; request.current?.abort(); request.current = null; setBusy(false) }
  useEffect(() => {
    cancel(); setOpen(false); setResult(null); setState(''); setError(''); setSignedIn(false); setRootAdmin(false); setAvailable(null); setContexts([workspace]); setScope('workspace')
    if (/^\/(auth|register|project-invite)(\/|$)/.test(location.pathname)) return
    const controller = new AbortController()
    void fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null).then(data => { if (!controller.signal.aborted) { setSignedIn(Boolean(data?.user)); setRootAdmin(data?.user?.isRootAdmin === true) } }).catch(() => {})
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
    if (kind === 'boolean' && (!yes.trim() || !no.trim() || yes.trim() === no.trim())) { setError('请填写两种不同的描述'); return }
    if (kind !== 'boolean' && (candidates.length < 2 || candidates.length > (kind === 'score' ? 10 : 16) || new Set(candidates).size !== candidates.length)) { setError('请输入至少两个不同选项，每行一个'); return }
    const q: DecisionQuestion = { id: 'answer', type: kind, question, ...(kind === 'boolean' ? { criteria: { true: yes.trim(), false: no.trim() } } : {}),
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
    <button className="fb-decision-toggle" type="button" aria-expanded={open} onClick={() => { cancel(); setOpen(!open) }}><BarChart3 size={17} />快速判断</button>
    {open && <section className="fb-decision-panel" role="dialog" aria-label="快速判断">
      <header><div><h2>快速判断</h2><p>小模型快速匹配，查看各选项的相对权重。</p></div><button type="button" aria-label="关闭快速判断" onClick={() => { cancel(); setOpen(false) }}><X size={20} /></button></header>
      <div className="fb-decision-fields">
        {rootAdmin && <Link to="/admin?tab=api" className="text-sm text-brand-600 underline">API 接入配置与密钥 ↗</Link>}
        {available !== true && <p role="status">{available === null ? '正在检查模型…' : cooling ? '手机温度偏高，模型正在冷却，请稍后重新打开。' : '模型服务尚未就绪，请稍后重新打开。'}</p>}
        <label>参考范围<select value={scope} disabled={busy} onChange={event => { setScope(event.target.value); setResult(null) }}>{contexts.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label>待判断内容<textarea aria-label="待判断内容" rows={3} value={state} disabled={busy} maxLength={3000} onChange={event => { setState(event.target.value); setResult(null) }} placeholder="例如：保存画布后，新增的图形消失了。" /></label>
        <label>判断方式<select value={kind} disabled={busy} onChange={event => { const next = event.target.value as DecisionQuestion['type']; if (Object.values(defaultQuestions).includes(question)) setQuestion(defaultQuestions[next]); setKind(next); setResult(null) }}><option value="choice">选择最合适的选项</option><option value="boolean">匹配是或否的描述</option><option value="score">匹配等级描述</option></select></label>
        <label>任务名称<input aria-label="任务名称" value={question} disabled={busy} maxLength={500} onChange={event => { setQuestion(event.target.value); setResult(null) }} /></label>
        {kind === 'boolean' && <><label>“是”的描述<textarea aria-label="是的描述" rows={2} value={yes} disabled={busy} maxLength={160} onChange={event => { setYes(event.target.value); setResult(null) }} /></label><label>“否”的描述<textarea aria-label="否的描述" rows={2} value={no} disabled={busy} maxLength={160} onChange={event => { setNo(event.target.value); setResult(null) }} /></label></>}
        {kind !== 'boolean' && <label>{kind === 'score' ? '评分等级（从低到高，每行一个）' : '候选选项（每行一个）'}<textarea aria-label="候选选项" rows={4} value={options} disabled={busy} onChange={event => { setOptions(event.target.value); setResult(null) }} /></label>}
        {error && <p className="fb-decision-error" role="alert">{error}</p>}
        <button className="fb-decision-submit" type="button" disabled={busy || !state.trim() || available !== true} onClick={() => void submit()}>{busy ? <><LoaderCircle size={16} className="fb-decision-spin" />正在判断…</> : '开始判断'}</button>
        {busy && <button type="button" onClick={cancel}>取消等待</button>}
        {answer && <div className="fb-decision-result" aria-live="polite"><strong>{answer.type === 'choice' ? answer.description : answer.type === 'boolean' ? answer.value ? '判断结果：是' : '判断结果：否' : `评分：${answer.score?.toFixed(2)}`}</strong>
          {Object.entries(answer.distribution).map(([key, probability], index) => <div className="fb-decision-probability" key={key}><span>{labels[index] || key}</span><progress max={1} value={probability} /><b>{(probability * 100).toFixed(1)}%</b></div>)}
          <small>百分比是语义匹配权重，不代表判断正确率。</small>
          {!!result?.sources.length && <p>参考：{result.sources.map(source => source.title).join('、')}</p>}
        </div>}
        <small>适合短文本分类与描述匹配，建议每段100字以内。请用完整描述填写选项。</small>
      </div>
    </section>}
  </div>
}
