import { useRef, useState } from 'react'
import { Check, Paperclip, Send, Trash2 } from 'lucide-react'
import { ManagementRequestError, mutationId, uploadAttachment } from '@/services/management'
import type { ManagementEvent, ManagementProject, RequirementDraft } from '@/types/management'
import { ErrorNotice, ModalCancelButton, WorkspaceModal } from '@/components/workspace/ui'
import { bytesLabel } from './model'

export default function RequirementIntakeModal({ project, onSave, onRefresh, onClose }: {
  project: ManagementProject; onSave: (draft: RequirementDraft, actionId: string) => Promise<ManagementEvent>
  onRefresh: () => Promise<boolean>; onClose: () => void
}) {
  const [draft, setDraft] = useState<RequirementDraft>({ title: '', description: '', source: '需求提交', attachments: [], values: {} })
  const [saving, setSaving] = useState(false), [uploading, setUploading] = useState(false), [error, setError] = useState('')
  const [result, setResult] = useState<ManagementEvent | null>(null), [uncertain, setUncertain] = useState(false)
  const action = useRef(mutationId()), attempt = useRef<RequirementDraft | null>(null), inFlight = useRef(false), fileInput = useRef<HTMLInputElement>(null)
  const dirty = !result && Boolean(draft.title || draft.description || draft.attachments.length || Object.keys(draft.values ?? {}).length)
  async function submit() {
    if (inFlight.current || uploading || !draft.title.trim()) return
    inFlight.current = true; setSaving(true); setError('')
    attempt.current ??= { ...draft, title: draft.title.trim() }
    try { const event = await onSave(attempt.current, action.current); setResult(event); setUncertain(false) }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : '提交未确认，请重试。')
      const unknown = !(cause instanceof ManagementRequestError) || cause.status === 0 || cause.status >= 500
      setUncertain(unknown)
      if (!unknown) { attempt.current = null; action.current = mutationId(); if (cause.status === 409) await onRefresh() }
    } finally { inFlight.current = false; setSaving(false) }
  }
  async function upload(files: FileList | null) {
    if (!files || uploading) return
    setUploading(true); setError('')
    try { for (const file of Array.from(files)) { const attachment = await uploadAttachment(project.id, file); setDraft(previous => ({ ...previous, attachments: [...previous.attachments, attachment] })) } }
    catch (cause) { setError(cause instanceof Error ? cause.message : '上传失败，已上传的附件仍保留。') }
    finally { setUploading(false); if (fileInput.current) fileInput.current.value = '' }
  }
  const setValue = (key: string, value: string | number | boolean | undefined) => setDraft(previous => {
    const values = { ...previous.values }; if (value === undefined) delete values[key]; else values[key] = value
    return { ...previous, values }
  })
  const role = project.roles.find(item => item.id === result?.roleId)
  return <WorkspaceModal title={result ? '需求已保存' : '提交需求'} description={result ? result.title : '说清需要处理的事情，系统会根据岗位职责自动选择处理人。'} onClose={onClose} dirty={dirty} busy={saving || uploading} wide>
    <div className="ws-form"><ErrorNotice error={error} />
      {result ? <div role="status" className="ws-intake-result">
        <Check size={28} /><h3>{result.dispatch?.status === 'assigned' ? '已自动分派' : '已保存，待分派'}</h3>
        {result.dispatch?.status === 'assigned' && <p><strong>{role?.name ?? '已配置岗位'}</strong> · {result.assignee}</p>}
        <p className="ws-setting-note">{result.dispatch?.reason}</p>
        <div className="ws-modal-actions"><button className="ws-button ws-button-primary" onClick={onClose}>查看需求表格</button></div>
      </div> : <>
        <fieldset disabled={saving || uploading || uncertain} style={{ border: 0, padding: 0, minWidth: 0 }}>
          <div className="ws-field"><label htmlFor="requirement-title">需求标题</label><input id="requirement-title" maxLength={200} value={draft.title} placeholder="例如：登录后页面报错，无法进入项目" onChange={event => setDraft(previous => ({ ...previous, title: event.target.value }))} /></div>
          <div className="ws-field"><label htmlFor="requirement-description">详细描述</label><textarea id="requirement-description" rows={6} maxLength={12000} value={draft.description} placeholder="补充背景、问题表现和期望结果。把最主要的需求写在开头。" onChange={event => setDraft(previous => ({ ...previous, description: event.target.value }))} /></div>
          <div className="ws-form-grid">{project.tableConfig?.customFields.filter(field => !field.roleId).map(field => <div className="ws-field" key={field.id}>
            <label htmlFor={`intake-${field.id}`}>{field.name}{field.required ? '（可稍后补齐）' : ''}</label>
            {field.type === 'checkbox' ? <input id={`intake-${field.id}`} className="ws-check" type="checkbox" checked={draft.values?.[field.id] === true} onChange={event => setValue(field.id, event.target.checked)} />
              : field.type === 'select' ? <select id={`intake-${field.id}`} value={String(draft.values?.[field.id] ?? '')} onChange={event => setValue(field.id, event.target.value || undefined)}><option value="">暂不填写</option>{field.options?.map(option => <option key={option}>{option}</option>)}</select>
                : <input id={`intake-${field.id}`} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} step={field.type === 'number' ? 'any' : undefined} value={String(draft.values?.[field.id] ?? '')} onChange={event => setValue(field.id, !event.target.value ? undefined : field.type === 'number' ? Number(event.target.value) : event.target.value)} />}
          </div>)}</div>
          <div className="ws-field"><span>截图与附件（可选）</span><div><button className="ws-button ws-button-small" onClick={() => fileInput.current?.click()}><Paperclip size={13} />添加附件</button><input ref={fileInput} style={{ display: 'none' }} type="file" multiple aria-label="上传需求附件" onChange={event => void upload(event.target.files)} /><small style={{ marginLeft: 10 }}>单文件最大 8 MB</small></div>
            <div className="ws-attachment-list">{draft.attachments.map(item => <div className="ws-attachment" key={item.id}>{item.mime.startsWith('image/') && <img src={item.url} alt={item.name} />}<a href={item.url} target="_blank" rel="noreferrer">{item.name}<small style={{ display: 'block' }}>{bytesLabel(item.bytes)}</small></a><button className="ws-icon-button" aria-label={`移除附件 ${item.name}`} onClick={() => setDraft(previous => ({ ...previous, attachments: previous.attachments.filter(value => value.id !== item.id) }))}><Trash2 size={12} /></button></div>)}</div>
          </div>
        </fieldset>
        {uncertain && <p className="ws-setting-note">上次提交尚未确认。请重试确认同一条需求，重复点击不会新增另一条。</p>}
        {uploading && <p role="status" className="ws-setting-note">正在上传附件…</p>}
        <div className="ws-modal-actions"><span>岗位与处理人由系统自动选择</span><ModalCancelButton /><button className="ws-button ws-button-primary" disabled={saving || uploading || !draft.title.trim()} onClick={() => void submit()}><Send size={14} />{saving ? '正在自动分派…' : uncertain ? '重试并确认提交' : '提交并自动分派'}</button></div>
      </>}
    </div>
  </WorkspaceModal>
}
