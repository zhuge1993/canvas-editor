import { useEffect, useRef, useState } from 'react'
import { AudioLines, Check, Copy, FolderOpen, Layers, LoaderCircle, Mic, MicOff, Send, Sparkles, Square, Volume2, VolumeX, X } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { voiceStatus, transcribeVoice, askVoice, speakVoice } from '@/services/voice'
import type { VoiceAnswer, VoiceContext, VoiceStatus } from '@/services/voice'
import { MicrophoneCapture, VOICE_MAX_SECONDS } from '@/utils/voiceCapture'
import { captureVoiceTarget, insertVoiceText } from '@/utils/voiceInsertion'
import type { VoiceTarget } from '@/utils/voiceInsertion'
import './voice.css'

type Phase = 'idle' | 'permission' | 'recording' | 'recognizing'
type ContextOption = { value: string; label: string; context: VoiceContext }
type Exchange = { question: string; response: VoiceAnswer }
const workspaceOption: ContextOption = { value: 'workspace', label: '我的工作台', context: { kind: 'workspace' } }
const errorText = (error: unknown) => error instanceof Error ? error.message : '语音处理失败，请重试。'
const isCanceled = (error: unknown) => error instanceof Error && error.name === 'AbortError'

export default function VoiceWorkspace() {
  const location = useLocation()
  const [signedIn, setSignedIn] = useState(false)
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [panel, setPanel] = useState(false)
  const [phase, setPhase] = useState<Phase>('idle')
  const [mode, setMode] = useState<'dictation' | 'question'>('dictation')
  const [meter, setMeter] = useState({ seconds: 0, rms: 0 })
  const [targetLabel, setTargetLabel] = useState('')
  const [result, setResult] = useState('')
  const [recordError, setRecordError] = useState('')
  const [inserted, setInserted] = useState(false)
  const [copied, setCopied] = useState(false)
  const [question, setQuestion] = useState('')
  const [exchanges, setExchanges] = useState<Exchange[]>([])
  const [qaState, setQaState] = useState<'idle' | 'thinking' | 'voicing' | 'playing'>('idle')
  const [qaError, setQaError] = useState('')
  const [autoSpeak, setAutoSpeak] = useState(true)
  const [contexts, setContexts] = useState<ContextOption[]>([workspaceOption])
  const [contextValue, setContextValue] = useState('workspace')
  const [contextError, setContextError] = useState('')
  const captureRef = useRef<MicrophoneCapture | null>(null)
  const targetRef = useRef<VoiceTarget | null>(null)
  const activeTargetRef = useRef<VoiceTarget | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const speechRef = useRef<AbortController | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef('')
  const generationRef = useRef(0)
  const historyEndRef = useRef<HTMLDivElement>(null)
  const finishRef = useRef<() => void>(() => {})
  const selectedContext = contexts.find(item => item.value === contextValue)?.context ?? workspaceOption.context

  function stopSpeech() {
    speechRef.current?.abort(); speechRef.current = null
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.removeAttribute('src'); audioRef.current.load() }
    audioRef.current = null
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = ''
  }
  function cancelAll() {
    generationRef.current++
    captureRef.current?.cancel(); captureRef.current = null
    requestRef.current?.abort(); requestRef.current = null
    stopSpeech(); setPhase('idle'); setQaState('idle')
  }

  useEffect(() => {
    cancelAll(); setPanel(false); setResult(''); setRecordError(''); setTargetLabel(''); setExchanges([]); setQuestion(''); setQaError(''); targetRef.current = null
    if (/^\/(auth|register|project-invite)(\/|$)/.test(location.pathname)) { setSignedIn(false); return }
    const controller = new AbortController()
    void fetch('/api/auth/me', { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' }).then(response => response.ok ? response.json() : null).then((data: { user?: { id: string } } | null) => {
      if (!controller.signal.aborted) setSignedIn(Boolean(data?.user))
    }).catch(() => { if (!controller.signal.aborted) setSignedIn(false) })
    return () => { controller.abort(); generationRef.current++; captureRef.current?.cancel(); captureRef.current = null; requestRef.current?.abort(); stopSpeech() }
  }, [location.pathname])

  useEffect(() => {
    if (!signedIn) { setExchanges([]); setQuestion(''); setStatus(null); return }
    const controller = new AbortController()
    setStatusError('')
    void voiceStatus(controller.signal).then(setStatus).catch(error => { if (!isCanceled(error)) setStatusError(errorText(error)) })
    const remember = () => {
      const target = captureVoiceTarget(document.activeElement)
      if (target) { targetRef.current = target; setTargetLabel(target.label) }
    }
    document.addEventListener('focusin', remember); document.addEventListener('selectionchange', remember)
    document.addEventListener('keyup', remember); document.addEventListener('pointerup', remember)
    return () => { controller.abort(); document.removeEventListener('focusin', remember); document.removeEventListener('selectionchange', remember); document.removeEventListener('keyup', remember); document.removeEventListener('pointerup', remember) }
  }, [signedIn])

  useEffect(() => {
    if (!panel) return
    const controller = new AbortController()
    const read = async (url: string) => { const response = await fetch(url, { credentials: 'same-origin', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) }); if (!response.ok) throw new Error('无法加载'); return response.json() as Promise<Array<{ id: string; name?: string; title?: string }>> }
    setContextError('')
    void Promise.allSettled([read('/api/management/projects'), read('/api/projects')]).then(values => {
      if (controller.signal.aborted) return
      const options: ContextOption[] = [workspaceOption]
      for (const [index, value] of values.entries()) if (value.status === 'fulfilled') {
        for (const item of value.value.slice(0, 80)) options.push({ value: `${index === 0 ? 'project' : 'canvas'}:${item.id}`, label: `${index === 0 ? '项目' : '画布'} · ${item.name || item.title || '未命名'}`, context: { kind: index === 0 ? 'project' : 'canvas', id: item.id } })
      }
      setContexts(options)
      const pathMatch = location.pathname.match(/^\/(projects|editor)\/([^/]+)$/)
      const current = pathMatch ? `${pathMatch[1] === 'projects' ? 'project' : 'canvas'}:${pathMatch[2]}` : ''
      setContextValue(previous => options.some(option => option.value === current) ? current : options.some(option => option.value === previous) ? previous : 'workspace')
      if (values.some(value => value.status === 'rejected')) setContextError('部分项目列表未加载，可稍后重新打开助手。')
    })
    return () => controller.abort()
  }, [panel, location.pathname])

  useEffect(() => { historyEndRef.current?.scrollIntoView({ block: 'nearest' }) }, [exchanges, qaState])
  useEffect(() => {
    if (phase === 'idle' && !panel) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelAll(); setPanel(false) } }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [phase, panel])

  async function playAnswer(text: string, generation = generationRef.current) {
    stopSpeech(); setQaError(''); setQaState('voicing')
    const controller = new AbortController(); speechRef.current = controller
    try {
      const clip = await speakVoice(Array.from(text).slice(0, 120).join(''), controller.signal)
      if (generation !== generationRef.current || controller.signal.aborted) return
      const url = URL.createObjectURL(clip), audio = new Audio(url)
      audioUrlRef.current = url; audioRef.current = audio
      audio.onended = () => { stopSpeech(); setQaState('idle') }
      audio.onerror = () => { stopSpeech(); setQaState('idle'); setQaError('播放失败，文字回复仍可阅读。') }
      await audio.play()
      if (generation === generationRef.current) setQaState('playing')
    } catch (error) {
      if (generation !== generationRef.current || isCanceled(error)) return
      stopSpeech(); setQaState('idle'); setQaError(error instanceof DOMException && error.name === 'NotAllowedError' ? '浏览器暂停了自动播放，请点击回复旁的“播报”。' : errorText(error))
    }
  }
  async function submitQuestion(raw: string) {
    const text = raw.trim()
    if (!text) return
    if (Array.from(text).length > 1000) { setQaError('问题请控制在 1000 字以内。'); return }
    cancelAll(); setQaError(''); setQaState('thinking'); setQuestion(text)
    const generation = generationRef.current, controller = new AbortController(); requestRef.current = controller
    try {
      const response = await askVoice(text, selectedContext, controller.signal)
      if (generation !== generationRef.current) return
      setExchanges(previous => [...previous.slice(-5), { question: text, response }]); setQuestion(''); setQaState('idle'); requestRef.current = null
      if (autoSpeak && status?.capabilities.speech) void playAnswer(response.spokenAnswer || response.answer, generation)
    } catch (error) {
      if (generation !== generationRef.current || isCanceled(error)) return
      setQaError(errorText(error)); setQaState('idle')
    }
  }
  async function startRecording(nextMode: 'dictation' | 'question') {
    if (status && !status.capabilities.transcribe) { setRecordError('手机语音识别服务暂未就绪，请稍后重试。'); return }
    const target = captureVoiceTarget(document.activeElement) ?? targetRef.current
    if (nextMode === 'dictation' && (!target || !target.element.isConnected)) { setMode('dictation'); setRecordError('先点击要输入文字的位置，再点麦克风。支持问题字段、备注和画布文本。'); return }
    cancelAll(); setMode(nextMode); setRecordError(''); setResult(''); setInserted(false); setCopied(false); setMeter({ seconds: 0, rms: 0 })
    activeTargetRef.current = target; if (target) setTargetLabel(target.label)
    const generation = generationRef.current
    const capture = new MicrophoneCapture((seconds, rms) => setMeter({ seconds, rms }), () => finishRef.current(), error => { if (generation === generationRef.current) { cancelAll(); setRecordError(error.message) } })
    captureRef.current = capture; setPhase('permission')
    try { await capture.start(); if (generation === generationRef.current && captureRef.current === capture) setPhase('recording') }
    catch (error) { if (generation === generationRef.current) { captureRef.current = null; setPhase('idle'); setRecordError(errorText(error)) } }
  }
  async function finishRecording() {
    const capture = captureRef.current
    if (!capture) return
    captureRef.current = null
    const pcm = capture.stop(), generation = generationRef.current
    if (pcm.byteLength < 8000) { setPhase('idle'); setRecordError('录音太短，请说完一句话后再结束。'); return }
    const controller = new AbortController(); requestRef.current = controller; setPhase('recognizing')
    try {
      const response = await transcribeVoice(pcm, controller.signal)
      if (generation !== generationRef.current) return
      const text = response.text.trim(); setPhase('idle'); requestRef.current = null
      if (!text) { setRecordError('没有识别到文字，请靠近麦克风再试一次。'); return }
      if (mode === 'question') { setQuestion(text); void submitQuestion(text); return }
      setResult(text)
      try { if (!activeTargetRef.current) throw new Error('原编辑位置已关闭，请复制识别文字。'); insertVoiceText(activeTargetRef.current, text); setInserted(true) }
      catch (error) { setRecordError(errorText(error)) }
    } catch (error) {
      if (generation !== generationRef.current || isCanceled(error)) return
      setPhase('idle'); setRecordError(errorText(error))
    }
  }
  finishRef.current = () => { void finishRecording() }
  const recording = phase !== 'idle'
  const busy = qaState === 'thinking' || qaState === 'voicing'
  function refreshStatus() {
    cancelAll(); setStatus(null); setStatusError('')
    const generation = generationRef.current, controller = new AbortController(); requestRef.current = controller
    void voiceStatus(controller.signal).then(value => { if (generation === generationRef.current) setStatus(value) }).catch(error => { if (generation === generationRef.current && !isCanceled(error)) setStatusError(errorText(error)) })
  }
  if (!signedIn) return null

  return <div className="fb-voice-root" data-voice-ui>
    {(recording || recordError || result) && <section className="fb-voice-recorder" aria-label="语音输入状态">
      <div className="fb-voice-recorder-head"><span className={`fb-voice-status-icon ${phase === 'recording' ? 'listening' : ''}`}>{phase === 'recognizing' || phase === 'permission' ? <LoaderCircle className="fb-voice-spin" size={18} /> : inserted ? <Check size={18} /> : <Mic size={18} />}</span><div><strong>{phase === 'recording' ? '正在聆听' : phase === 'permission' ? '等待麦克风授权' : phase === 'recognizing' ? '正在识别语音' : inserted ? '已插入文字' : '语音输入'}</strong><small>{mode === 'question' ? '问题将交给 AI 助手' : targetLabel ? `输入到：${targetLabel}` : '先选择一个文本输入位置'}</small></div><button type="button" className="fb-voice-icon" aria-label={recording ? '取消语音输入' : '关闭识别结果'} onPointerDown={event => event.preventDefault()} onClick={() => { cancelAll(); setRecordError(''); setResult('') }}><X size={17} /></button></div>
      {phase === 'recording' && <><div className="fb-voice-wave" aria-hidden="true">{Array.from({ length: 23 }, (_, index) => <i key={index} style={{ height: `${8 + Math.min(1, meter.rms * 12) * (16 + (index % 5) * 5)}px` }} />)}</div><div className="fb-voice-record-time"><span>{Math.min(VOICE_MAX_SECONDS, meter.seconds).toFixed(1)} 秒</span><span>最多 {VOICE_MAX_SECONDS} 秒 · 说完点击完成</span></div><div className="fb-voice-progress"><span style={{ width: `${Math.min(100, meter.seconds / VOICE_MAX_SECONDS * 100)}%` }} /></div></>}
      {recordError && <p className="fb-voice-error" role="alert">{recordError}</p>}
      {result && <div className="fb-voice-transcript"><p>{result}</p><button type="button" className="fb-voice-text-button" onPointerDown={event => event.preventDefault()} onClick={() => { void navigator.clipboard.writeText(result).then(() => setCopied(true)).catch(() => setRecordError('复制失败，请手动选中上方文字复制。')) }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? '已复制' : '复制文字'}</button></div>}
      {recording && <div className="fb-voice-record-actions"><button type="button" className="fb-voice-secondary" onPointerDown={event => event.preventDefault()} onClick={cancelAll}><MicOff size={15} />取消</button>{phase === 'recording' && <button type="button" className="fb-voice-primary" onPointerDown={event => event.preventDefault()} onClick={() => void finishRecording()}><Square size={13} fill="currentColor" />完成并识别</button>}</div>}
      <p className="fb-voice-footnote" role="status" aria-live="polite">{phase === 'recognizing' ? '麦克风已关闭，正在等待手机返回文字。' : phase === 'permission' ? '允许后开始，本次录音可随时取消。' : phase === 'recording' ? '仅本次点击后录音；结束或取消即关闭麦克风。' : inserted ? '文字已写入原光标位置，可继续编辑。' : ''}</p>
    </section>}

    {panel && <section className="fb-voice-panel" role="dialog" aria-label="AI 语音助手">
      <header className="fb-voice-panel-head"><span className="fb-voice-ai-mark"><Sparkles size={23} /></span><div><span className="fb-voice-eyebrow">FLOWBOARD ASSISTANT</span><h2>你的工作台，开口就能问</h2><p>查进度、找问题，读懂当前项目与画布。</p></div><button type="button" className="fb-voice-icon" aria-label="关闭 AI 助手" onClick={() => { cancelAll(); setPanel(false) }}><X size={20} /></button></header>
      <div className="fb-voice-context"><label htmlFor="fb-voice-context"><FolderOpen size={15} />查询范围</label><select id="fb-voice-context" value={contextValue} disabled={busy || recording} onChange={event => { setContextValue(event.target.value); setExchanges([]); stopSpeech(); setQaState('idle') }}>{contexts.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select><small>只查询你有权查看的数据</small></div>
      {(statusError || (status && !status.available)) && <p className="fb-voice-service-note" role="status">{statusError || '手机模型正在准备，暂时可浏览工作台，稍后再试。'} <button type="button" className="fb-voice-text-button" disabled={busy || recording} onClick={refreshStatus}>重新检查</button></p>}
      {!status && !statusError && <p className="fb-voice-service-note" role="status">正在检查手机语音服务…</p>}
      {contextError && <p className="fb-voice-service-note">{contextError}</p>}
      <div className="fb-voice-conversation">
        {!exchanges.length && <div className="fb-voice-welcome"><span className="fb-voice-welcome-icon"><AudioLines size={32} strokeWidth={1.5} /></span><h3>把工作中的问题交给我</h3><p>点击麦克风说一句，或在下方输入。<br />答案会显示在这里，也可以播报出来。</p><div className="fb-voice-suggestions">{['今天新增了多少问题？', '有哪些问题等待验收？', '总结这个范围的处理进度'].map(text => <button type="button" key={text} disabled={busy || recording} onClick={() => { setQuestion(text); void submitQuestion(text) }}>{text}<Send size={12} /></button>)}</div></div>}
        {exchanges.map((exchange, index) => <article className="fb-voice-exchange" key={index}><div className="fb-voice-question-bubble">{exchange.question}</div><div className="fb-voice-answer"><span className="fb-voice-answer-icon"><Sparkles size={15} /></span><div><div className="fb-voice-answer-label"><strong>{exchange.response.dataAnswer ? '根据工作台数据' : '本地 AI 回复'}</strong><button type="button" className="fb-voice-text-button" aria-label={`播报第 ${index + 1} 条回复`} disabled={busy || recording || !status?.capabilities.speech} onClick={() => void playAnswer(exchange.response.spokenAnswer || exchange.response.answer)}><Volume2 size={13} />播报</button></div><p>{exchange.response.answer}</p>{Boolean(exchange.response.sources?.length) && <div className="fb-voice-sources">{exchange.response.sources.slice(0, 8).map(source => <span key={`${source.kind}:${source.id}`}><Layers size={10} />{source.title}</span>)}</div>}{(exchange.response.contextTruncated || exchange.response.questionTruncated) && <small className="fb-voice-limit-note">手机模型使用了部分文字摘要；超出上下文长度的内容未全部送入模型。</small>}{Array.from(exchange.response.answer).length > 120 && <small className="fb-voice-limit-note">语音播报前 120 字，完整内容见上方。</small>}</div></div></article>)}
        {busy && <div className="fb-voice-thinking" role="status"><LoaderCircle className="fb-voice-spin" size={17} /><span>{qaState === 'thinking' ? '正在读取所选数据并整理回答…' : '正在生成语音回复…'}</span></div>}
        <div ref={historyEndRef} />
      </div>
      <footer className="fb-voice-compose"><div className="fb-voice-compose-options"><label><input type="checkbox" checked={autoSpeak} onChange={event => setAutoSpeak(event.target.checked)} />语音播报回复</label>{qaState !== 'idle' && <button type="button" className="fb-voice-text-button" onClick={cancelAll}><VolumeX size={14} />{qaState === 'playing' ? '停止播报' : '取消处理'}</button>}</div>{qaError && <p className="fb-voice-error" role="alert">{qaError}</p>}<div className="fb-voice-compose-box"><textarea aria-label="向 AI 助手提问" placeholder="问问项目进度，或说出你的问题…" rows={2} maxLength={1000} value={question} onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submitQuestion(question) } }} /><div><button type="button" className={`fb-voice-question-mic ${recording && mode === 'question' ? 'active' : ''}`} aria-label={recording && mode === 'question' ? '完成语音提问' : '用语音提问'} title="用语音提问" disabled={phase === 'permission' || phase === 'recognizing' || qaState === 'thinking'} onPointerDown={event => event.preventDefault()} onClick={() => recording ? void finishRecording() : void startRecording('question')}><Mic size={18} /></button><button type="button" className="fb-voice-send" aria-label="发送问题" disabled={!question.trim() || busy || recording} onClick={() => void submitQuestion(question)}><Send size={16} /></button></div></div><p className="fb-voice-footnote">手机本地模型 · 查询不会修改项目 · 最多保留本页最近 6 次问答</p></footer>
    </section>}
    <div className="fb-voice-dock"><button type="button" className={`fb-voice-dictate ${recording && mode === 'dictation' ? 'active' : ''}`} title={targetLabel ? `语音输入到：${targetLabel}` : '先点击文本输入位置，再开始语音输入'} aria-label={recording && mode === 'dictation' ? '完成语音输入' : '语音输入到光标位置'} disabled={phase === 'permission' || phase === 'recognizing' || qaState === 'thinking'} onPointerDown={event => event.preventDefault()} onClick={() => recording ? void finishRecording() : void startRecording('dictation')}><Mic size={17} /><span>{recording && mode === 'dictation' ? '完成录音' : '语音输入'}</span></button><i /><button type="button" className={`fb-voice-open ${panel ? 'active' : ''}`} aria-label={panel ? '收起 AI 助手' : '打开 AI 语音助手'} aria-expanded={panel} onPointerDown={event => event.preventDefault()} onClick={() => { if (panel) { cancelAll(); setPanel(false) } else setPanel(true) }}><Sparkles size={17} /><span>AI 助手</span></button></div>
  </div>
}
