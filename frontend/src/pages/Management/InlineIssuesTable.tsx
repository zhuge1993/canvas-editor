import { useEffect, useRef, useState } from 'react'
import { Check, Info, Paperclip, Pencil, Plus, Send, Settings2, Trash2, X } from 'lucide-react'
import MemberPicker from '@/components/workspace/MemberPicker'
import { ErrorNotice, timeLabel } from '@/components/workspace/ui'
import { mutationId } from '@/services/management'
import type { EventDraft, ManagementEvent, ManagementFieldDefinition, ManagementMember, ManagementProject } from '@/types/management'
import InlineValue from './InlineValue'
import type { CellValue } from './InlineValue'
import { baseColumnChoices } from './TableSetupWizard'
import { priorities, priorityName, statuses, statusName } from './model'

export interface CellGuard { updatedAt?: number; baseValues: Record<string, unknown> }
type Patch = (eventId: string, value: Partial<EventDraft>, guard?: CellGuard) => Promise<void>
function NotifyButton({ event, disabled, onNotify }: { event: ManagementEvent; disabled: boolean; onNotify: (event: ManagementEvent, actionId: string) => Promise<{ count: number }> }) {
  const action = useRef(mutationId()), [busy, setBusy] = useState(false), [error, setError] = useState(''), [sent, setSent] = useState<number | null>(null)
  async function send() { setBusy(true); setError(''); try { const result = await onNotify(event, action.current); setSent(result.count); action.current = mutationId() } catch { setError('记录已保存，通知未确认。请重试，重复点击不会重复发送。') } finally { setBusy(false) } }
  return <div className="ws-notify-cell"><button className="ws-icon-button" aria-label={`推送问题 ${event.title}`} title={event.recipientIds?.length ? `推送给 ${event.recipientIds.length} 位已选成员` : '先选择接收人'} disabled={disabled || busy || !event.recipientIds?.length} onClick={() => void send()}><Send size={13} /></button>{busy ? <small>正在推送…</small> : sent !== null ? <small className="sent">已推送 {sent} 人</small> : null}{error && <small role="alert">{error}</small>}</div>
}
function FieldInput({ field, value, onChange }: { field: ManagementFieldDefinition; value: CellValue; onChange: (value: CellValue) => void }) {
  if (field.type === 'checkbox') return <input type="checkbox" className="ws-check" aria-label={`新问题 ${field.name}`} checked={value === true} onChange={event => onChange(event.target.checked)} />
  if (field.type === 'select') return <select aria-label={`新问题 ${field.name}`} value={String(value ?? '')} onChange={event => onChange(event.target.value || undefined)}><option value="">{field.required ? '必选' : '未填写'}</option>{field.options?.map(option => <option key={option} value={option}>{option}</option>)}</select>
  return <input aria-label={`新问题 ${field.name}`} type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'} step={field.type === 'number' ? 'any' : undefined} value={String(value ?? '')} placeholder={field.required ? '必填' : '填写…'} onChange={event => onChange(field.type === 'number' ? event.target.value === '' ? undefined : Number(event.target.value) : event.target.value || undefined)} />
}
export default function InlineIssuesTable({ project, events, members, roleId, loading, busy, createSignal, filterError, onPatch, onValue, onCreate, onNotify, onDetails, onDelete, onSetup, recorder, canEdit = true, canConfigure = true }: { project: ManagementProject; events: ManagementEvent[]; members: ManagementMember[]; roleId?: string; loading: boolean; busy: boolean; createSignal: number; filterError: string; onPatch: Patch; onValue: (eventId: string, fieldId: string, value: CellValue, base: CellValue, version?: number) => Promise<void>; onCreate: (draft: EventDraft, actionId: string, eventId: string) => Promise<ManagementEvent>; onNotify: (event: ManagementEvent, actionId: string) => Promise<{ count: number }>; onDetails: (event: ManagementEvent) => void; onDelete: (event: ManagementEvent) => void; onSetup: () => void; recorder: string; canEdit?: boolean; canConfigure?: boolean }) {
  const configured = project.tableConfig
  const visibleKeys = configured?.visibleBaseFields ?? baseColumnChoices.filter(column => column.initial).map(column => column.id)
  const columns = baseColumnChoices.filter(column => column.id === 'title' || visibleKeys.includes(column.id)).map(column => ({ key: column.id, label: configured?.baseLabels[column.id] || column.label }))
  const fields = (configured?.customFields ?? []).filter(field => !roleId || !field.roleId || field.roleId === roleId)
  const initialDraft = (): EventDraft => ({ title: '', description: '', roleId: roleId === '__unassigned__' ? '' : roleId || project.roles[0]?.id || '', categoryId: '', source: '', assignee: '', assigneeId: '', recipientIds: [], priority: 'medium', status: 'todo', attachments: [], values: {} })
  const [draft, setDraft] = useState(initialDraft), [adding, setAdding] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [notifyPending, setNotifyPending] = useState<ManagementEvent | null>(null)
  const titleInput = useRef<HTMLInputElement>(null), createId = useRef(mutationId()), newEventId = useRef(`event_${mutationId()}`), notifyId = useRef(mutationId()), lastSignal = useRef(createSignal)
  useEffect(() => { if (createSignal !== lastSignal.current) { setAdding(true); lastSignal.current = createSignal; window.setTimeout(() => titleInput.current?.focus(), 20) } }, [createSignal])
  useEffect(() => { if (!draft.title) setDraft(previous => ({ ...previous, roleId: roleId === '__unassigned__' ? '' : roleId || project.roles[0]?.id || '' })) }, [roleId])
  const merge = (value: Partial<EventDraft>) => setDraft(previous => ({ ...previous, ...value }))
  const setCustom = (fieldId: string, value: CellValue) => setDraft(previous => { const values = { ...previous.values }; if (value === undefined) delete values[fieldId]; else values[fieldId] = value; return { ...previous, values } })
  async function add(push = false) {
    if (!draft.title.trim()) { setError('请先填写这一行的问题标题。'); titleInput.current?.focus(); return }
    const applicable = (configured?.customFields ?? []).filter(field => !field.roleId || field.roleId === draft.roleId)
    const values = { ...draft.values }; for (const field of applicable) if (field.type === 'checkbox' && values[field.id] === undefined) values[field.id] = false
    const missing = applicable.find(field => field.required && (values[field.id] === undefined || values[field.id] === ''))
    if (missing) { setError(`请填写必填字段「${missing.name}」。`); return }
    if (push && !draft.recipientIds?.length) { setError('先选择推送给谁，再添加并推送。'); return }
    setSaving(true); setError(''); setNotice('')
    try {
      const created = await onCreate({ ...draft, title: draft.title.trim(), values }, createId.current, newEventId.current)
      createId.current = mutationId(); newEventId.current = `event_${mutationId()}`
      setDraft(previous => ({ ...previous, title: '', description: '', status: 'todo', values: {} }))
      setNotice('已添加，可以继续写下一条。')
      if (push) { notifyId.current = mutationId(); setNotifyPending(created); try { const result = await onNotify(created, notifyId.current); setNotifyPending(null); setNotice(`问题已添加，并推送给 ${result.count} 人。`) } catch { setError('记录已保存，通知未确认，请点击「重试推送」。') } }
      window.setTimeout(() => titleInput.current?.focus(), 20)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '这一行还没有保存，输入内容仍保留。') } finally { setSaving(false) }
  }
  async function retryNotify() { if (!notifyPending) return; setSaving(true); try { const result = await onNotify(notifyPending, notifyId.current); setNotifyPending(null); setError(''); setNotice(`已推送给 ${result.count} 人。`) } catch { setError('记录已保存，通知仍未确认，请重试。') } finally { setSaving(false) } }
  function newCell(key: string) {
    switch (key) {
      case 'title': return <input ref={titleInput} aria-label="新问题标题" value={draft.title} placeholder="直接在这里写问题，Enter 添加" onChange={event => merge({ title: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add() } }} />
      case 'roleId': return <select aria-label="新问题角色" value={draft.roleId} onChange={event => merge({ roleId: event.target.value })}><option value="">未指定</option>{project.roles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select>
      case 'categoryId': return <select aria-label="新问题分类" value={draft.categoryId} onChange={event => merge({ categoryId: event.target.value })}><option value="">未分类</option>{project.categories.map(tag => <option key={tag.id} value={tag.id}>{tag.name}</option>)}</select>
      case 'source': return <input aria-label="新问题来源" value={draft.source} placeholder="来源…" onChange={event => merge({ source: event.target.value })} />
      case 'assignee': return <select aria-label="新问题处理人" value={draft.assigneeId ?? ''} onChange={event => merge({ assigneeId: event.target.value, assignee: members.find(member => member.id === event.target.value)?.name ?? '' })}><option value="">待分配</option>{members.map(member => <option key={member.id} value={member.id}>{member.name}{member.isSelf ? '（我）' : ''}</option>)}</select>
      case 'priority': return <select aria-label="新问题优先级" value={draft.priority} onChange={event => merge({ priority: event.target.value as EventDraft['priority'] })}>{priorities.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      case 'status': return <select aria-label="新问题状态" value={draft.status} onChange={event => merge({ status: event.target.value as EventDraft['status'] })}>{statuses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      case 'recorder': return <span className="ws-inline-auto">{recorder}</span>
      case 'createdAt': return <span className="ws-inline-auto">自动记录</span>
      case 'attachments': return <span className="ws-inline-auto">添加后可上传</span>
      case 'recipients': return <MemberPicker members={members} selected={draft.recipientIds ?? []} onChange={ids => merge({ recipientIds: ids })} disabled={saving} label="推送给谁" />
      default: return null
    }
  }
  function cell(event: ManagementEvent, key: string, label: string) {
    const base = (value: CellValue, type: 'text' | 'select' = 'text', options: Array<string | { value: string; label: string }> = [], children?: React.ReactNode) => <InlineValue value={value} type={type} options={options} allowEmpty={key !== 'status' && key !== 'priority'} label={`${label}：${event.title}`} version={event.updatedAt} disabled={busy || !canEdit} onSave={(value, base, version) => onPatch(event.id, { [key]: value ?? '' } as Partial<EventDraft>, { updatedAt: version, baseValues: { [key]: base ?? null } })}>{children}</InlineValue>
    switch (key) {
      case 'title': return <div>{base(event.title)}<p className="ws-event-summary">{event.description || '点击详情补充描述与附件'}</p></div>
      case 'roleId': return base(event.roleId, 'select', project.roles.map(role => ({ value: role.id, label: role.name })), <span className="ws-tag">{project.roles.find(role => role.id === event.roleId)?.name ?? '未指定'}</span>)
      case 'categoryId': return base(event.categoryId, 'select', project.categories.map(tag => ({ value: tag.id, label: tag.name })), <span className="ws-tag">{project.categories.find(tag => tag.id === event.categoryId)?.name ?? '未分类'}</span>)
      case 'priority': return base(event.priority, 'select', priorities.map(item => ({ value: item.id, label: item.name })), <span className={`ws-tag ws-priority-${event.priority}`}>{priorityName(event.priority)}</span>)
      case 'status': return base(event.status, 'select', statuses.map(item => ({ value: item.id, label: item.name })), <span className={`ws-tag ws-status-${event.status}`}>{statusName(event.status)}</span>)
      case 'source': return base(event.source)
      case 'assignee': return <InlineValue value={event.assigneeId} type="select" options={members.map(member => ({ value: member.id, label: member.name }))} label={`处理人：${event.title}`} version={event.updatedAt} disabled={busy || !canEdit} onSave={(value, base, version) => onPatch(event.id, { assigneeId: String(value ?? ''), assignee: members.find(member => member.id === value)?.name ?? '' }, { updatedAt: version, baseValues: { assigneeId: base ?? null, assignee: event.assignee } })}>{event.assignee || <span className="ws-inline-placeholder">选择处理人</span>}</InlineValue>
      case 'recorder': return <span>{event.recorder}</span>
      case 'createdAt': return <span className="ws-table-date">{timeLabel(event.createdAt)}</span>
      case 'attachments': return <button className="ws-link-button" onClick={() => onDetails(event)}><Paperclip size={11} />{event.attachments.length ? `${event.attachments.length} 个附件` : '添加附件'}</button>
      case 'recipients': return <MemberPicker members={members} selected={event.recipientIds ?? []} disabled={busy || !canEdit} label="选择接收人" onChange={ids => void onPatch(event.id, { recipientIds: ids }, { updatedAt: event.updatedAt, baseValues: { recipientIds: event.recipientIds ?? null } }).catch(cause => setError(cause instanceof Error ? cause.message : '接收人还未保存'))} />
      default: return null
    }
  }
  return <section className="ws-panel ws-issue-panel"><div className="ws-inline-table-head"><div><strong>问题表格</strong><span>{loading ? '正在更新…' : `${events.length} 条记录`}</span></div><div>{canConfigure && <button className="ws-button ws-button-small" onClick={onSetup}><Settings2 size={12} />角色与字段设置</button>}<button className="ws-button ws-button-small ws-button-primary" disabled={!canEdit} onClick={() => { setAdding(true); window.setTimeout(() => titleInput.current?.focus(), 20) }}><Plus size={12} />新增一行</button></div></div><ErrorNotice error={filterError || error} />{notifyPending && <div className="ws-inline-notice"><span>问题「{notifyPending.title}」已保存，通知还未确认。</span><button className="ws-button ws-button-small" disabled={saving} onClick={() => void retryNotify()}><Send size={12} />重试推送</button></div>}{notice && <p className="ws-inline-success" role="status"><Check size={12} />{notice}</p>}<div className="ws-table-scroll"><table className="ws-table ws-editable-table" style={{ minWidth: Math.max(880, (columns.length + fields.length) * 114 + 150) }} aria-busy={loading}><thead><tr><th>完成</th>{columns.map(column => <th key={column.key}>{column.label}</th>)}{fields.map(field => <th key={field.id}>{field.roleId && !roleId ? `${project.roles.find(role => role.id === field.roleId)?.name ?? ''} · ` : ''}{field.name}{field.required && <span className="ws-required">*</span>}</th>)}<th>操作</th></tr></thead><tbody>
    {adding && <tr className="ws-new-issue-row"><td><Plus size={13} /></td>{columns.map(column => <td key={column.key}><fieldset disabled={!canEdit || saving} style={{ border: 0, minWidth: 0 }}>{newCell(column.key)}</fieldset></td>)}{fields.map(field => <td key={field.id}><fieldset disabled={!canEdit || saving} style={{ border: 0, minWidth: 0 }}>{!field.roleId || field.roleId === draft.roleId ? <FieldInput field={field} value={draft.values?.[field.id]} onChange={value => setCustom(field.id, value)} /> : '—'}</fieldset></td>)}<td><div className="ws-new-row-actions"><button className="ws-button ws-button-small ws-button-primary" disabled={!canEdit || saving || busy || !draft.title.trim()} onClick={() => void add()}><Check size={11} />{saving ? '保存中…' : '添加问题'}</button>{Boolean(draft.recipientIds?.length) && <button className="ws-button ws-button-small" disabled={!canEdit || saving || busy} onClick={() => void add(true)}><Send size={11} />添加并推送</button>}<button className="ws-icon-button" aria-label="收起新问题行，保留输入" disabled={saving} onClick={() => setAdding(false)}><X size={12} /></button></div></td></tr>}
    {events.map(event => <tr key={event.id} className={event.status === 'done' ? 'done' : ''}><td><input type="checkbox" className="ws-check" aria-label={`${event.status === 'done' ? '取消完成' : '标记完成'} ${event.title}`} checked={event.status === 'done'} disabled={busy || !canEdit} onChange={value => void onPatch(event.id, { status: value.target.checked ? 'done' : 'todo' }, { updatedAt: event.updatedAt, baseValues: { status: event.status } }).catch(cause => setError(cause instanceof Error ? cause.message : '完成状态未保存'))} /></td>{columns.map(column => <td key={column.key}>{cell(event, column.key, column.label)}</td>)}{fields.map(field => <td key={field.id}>{field.roleId && field.roleId !== event.roleId ? <span className="ws-inline-auto">—</span> : <InlineValue label={`${field.name}：${event.title}`} value={event.values?.[field.id]} type={field.type} options={field.options ?? []} allowEmpty={!field.required} version={event.updatedAt} disabled={busy || !canEdit} onSave={(value, base, version) => onValue(event.id, field.id, (field.type === 'date' || field.type === 'select') && value === '' ? undefined : value, base, version)} />}</td>)}<td><div className="ws-row-actions"><button className="ws-icon-button" aria-label={`编辑事件 ${event.title}`} title="完整详情与操作记录" onClick={() => onDetails(event)}><Pencil size={13} /></button><NotifyButton event={event} disabled={busy || loading || !canEdit} onNotify={onNotify} /><button className="ws-icon-button" aria-label={`删除事件 ${event.title}`} disabled={busy || !canEdit} onClick={() => onDelete(event)}><Trash2 size={13} /></button></div></td></tr>)}
    {loading && !events.length && !adding && <tr><td colSpan={columns.length + fields.length + 2}><div className="ws-table-empty" role="status"><strong>正在读取问题表格…</strong><p>请稍候，正在加载当前角色与筛选范围内的记录。</p></div></td></tr>}
    {!loading && !events.length && !adding && <tr><td colSpan={columns.length + fields.length + 2}><div className="ws-table-empty"><Info size={20} /><strong>{filterError ? '列表暂时无法加载' : '角色和字段已就绪，直接开始写问题'}</strong><p>{filterError ? '请检查连接后重新加载。' : '点击新增一行；之后可直接点击单元格修改，不需要反复打开表单。'}</p>{!filterError && <button className="ws-button ws-button-primary" disabled={!canEdit} onClick={() => { setAdding(true); window.setTimeout(() => titleInput.current?.focus(), 20) }}><Plus size={13} />写第一条问题</button>}</div></td></tr>}
    </tbody></table></div><div className="ws-table-footer"><span>单元格修改自动保存 · 完成时间与历史自动记录</span><span>推送需显式点击，仅站内通知</span></div></section>
}
