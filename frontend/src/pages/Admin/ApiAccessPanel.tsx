import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, Eye, EyeOff, PlugZap, RefreshCw } from 'lucide-react'

interface APIConfig { apiType: string; base_url: string; model: string; configured: boolean; keyMasked: string; temporaryAddress: boolean }
interface RevealedConfig extends APIConfig { api_key?: string }

async function loadConfig(reveal: boolean, signal: AbortSignal): Promise<RevealedConfig> {
  const response = await fetch(`/api/settings/decision-api${reveal ? '/reveal' : ''}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
    ...(reveal ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '读取接入配置失败')
  return result
}

export default function ApiAccessPanel() {
  const [config, setConfig] = useState<APIConfig | null>(null)
  const [secret, setSecret] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const requests = useRef(new Set<AbortController>()), mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    const pending = requests.current
    const controller = new AbortController(); pending.add(controller)
    void loadConfig(false, controller.signal).then(data => { if (!controller.signal.aborted) setConfig(data) })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取失败') })
      .finally(() => { pending.delete(controller); if (!controller.signal.aborted) setLoading(false) })
    const clear = () => setSecret('')
    const hidden = () => { if (document.visibilityState === 'hidden') clear() }
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', clear)
    return () => {
      mounted.current = false; pending.forEach(item => item.abort()); pending.clear()
      document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', clear)
    }
  }, [])

  async function operate(action: 'refresh' | 'show' | 'copy-key' | 'copy-config' | 'download') {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    const controller = new AbortController(); requests.current.add(controller)
    try {
      // Copy/export always read a fresh credential and revalidate root access.
      const data = await loadConfig(action !== 'refresh', controller.signal)
      if (!mounted.current || controller.signal.aborted) return
      const { api_key: apiKey, ...metadata } = data
      setConfig(metadata)
      if (action === 'refresh') { setSecret(''); setNotice('已刷新当前接入地址'); return }
      if (!apiKey) throw new Error('没有可用的 API 密钥')
      if (action === 'show') { if (document.visibilityState === 'visible') setSecret(apiKey); return }
      const payload = { base_url: data.base_url, api_key: apiKey, model: data.model }
      if (action === 'download') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2) + '\n'], { type: 'application/json' }))
        try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'OpenAI-API接入配置.json'; document.body.append(anchor); anchor.click(); anchor.remove() }
        finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
        setNotice('已下载接入配置')
      } else {
        await navigator.clipboard.writeText(action === 'copy-key' ? apiKey : JSON.stringify(payload, null, 2))
        if (mounted.current) setNotice(action === 'copy-key' ? '已复制 API Key' : '已复制完整接入配置')
      }
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) { setSecret(''); setError(cause instanceof Error ? cause.message : '操作失败，请重试') }
    } finally {
      requests.current.delete(controller)
      if (mounted.current) setBusy(false)
    }
  }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setNotice(`已复制${label}`); setError('') }
    catch { setError('当前浏览器无法复制，请选中输入框中的文字手动复制') }
  }
  const field = (label: string, value: string) => <div className="space-y-2"><label className="block text-sm font-medium text-ink">{label}</label><div className="flex gap-2"><input aria-label={label} readOnly value={value} className="min-w-0 flex-1 rounded-lg border border-surface-border bg-surface-muted px-3 py-2.5 text-sm text-ink" onFocus={event => event.currentTarget.select()} /><button type="button" className="btn-ghost shrink-0 border border-surface-border" aria-label={`复制${label}`} onClick={() => void copy(value, label)}><Copy size={15} />复制</button></div></div>

  return <section className="panel p-4 sm:p-6" aria-label="API 接入配置">
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div className="flex gap-3"><span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><PlugZap size={23} /></span><div><h2 className="text-lg font-semibold text-ink">把手机模型接到其他工具</h2><p className="mt-1 text-sm text-ink-muted">选择 OpenAI 兼容接口，填入下面三项即可。</p></div></div><button type="button" className="btn-ghost border border-surface-border" disabled={busy || loading} onClick={() => void operate('refresh')}><RefreshCw size={14} />刷新地址</button></div>
    {loading && <p role="status" className="text-sm text-ink-muted">正在读取接入配置…</p>}
    {error && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>}
    {notice && <p role="status" className="mb-4 flex items-center gap-2 rounded-lg bg-green-50 p-3 text-sm text-green-700"><Check size={15} />{notice}</p>}
    {config && <>
      <div className="mb-5 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-brand-50 px-3 py-1.5 text-brand-700">{config.apiType}</span><span className="rounded-full bg-surface-muted px-3 py-1.5 text-ink-muted">{config.configured ? '密钥已配置' : '尚未配置密钥'}</span></div>
      <div className="space-y-5">
        {field('接口地址（Base URL）', config.base_url)}
        {field('模型名称（Model）', config.model)}
        <div className="space-y-2"><label className="block text-sm font-medium text-ink">密钥（API Key）</label><div className="flex flex-wrap gap-2"><input aria-label="密钥（API Key）" readOnly value={secret || config.keyMasked} placeholder="尚未配置" className="min-w-0 basis-48 flex-1 rounded-lg border border-surface-border bg-surface-muted px-3 py-2.5 font-mono text-sm text-ink" autoComplete="off" spellCheck={false} onFocus={event => { if (secret) event.currentTarget.select() }} /><button type="button" className="btn-ghost border border-surface-border" disabled={!config.configured || busy} onClick={() => secret ? setSecret('') : void operate('show')}>{secret ? <EyeOff size={15} /> : <Eye size={15} />}{secret ? '隐藏密钥' : '查看密钥'}</button><button type="button" className="btn-ghost border border-surface-border" disabled={!config.configured || busy} onClick={() => void operate('copy-key')}><Copy size={15} />复制密钥</button></div><p className="text-xs text-ink-muted">密钥默认隐藏，仅根管理员可查看和导出。</p></div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3"><button type="button" className="btn-primary" disabled={!config.configured || busy} onClick={() => void operate('copy-config')}><Copy size={15} />复制完整配置</button><button type="button" className="btn-ghost border border-surface-border" disabled={!config.configured || busy} onClick={() => void operate('download')}><Download size={15} />下载配置 JSON</button></div>
      {config.temporaryAddress && <p className="mt-4 text-xs text-ink-muted">当前为临时公网地址。隧道重连后，点击“刷新地址”获取最新地址。</p>}
      {!config.configured && <p className="mt-4 text-sm text-ink-muted">API 密钥尚未配置，暂时无法接入外部工具。</p>}
      <div className="mt-6 rounded-xl border border-surface-border bg-surface-muted p-4"><h3 className="mb-2 text-sm font-semibold text-ink">怎样使用</h3><ol className="list-inside list-decimal space-y-2 text-sm text-ink-muted"><li>在外部工具里选择“OpenAI 兼容”或“自定义接口”。</li><li>粘贴接口地址、密钥和模型名称。</li><li>调用 Chat Completions，可开启流式返回。</li></ol><p className="mt-3 text-xs text-ink-muted">适合短文本分类与候选描述匹配，返回 JSON 结果；不生成通用聊天回答。</p></div>
    </>}
  </section>
}
