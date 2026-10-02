import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'flowboard-workflow-backup-'))
const fixtureIndex = process.argv.indexOf('--fixture')
const fixture = fixtureIndex < 0 ? path.join(runtime, 'fixture.cjs') : path.resolve(process.argv[fixtureIndex + 1]), users = {}
if (fixtureIndex < 0) {
  const { build } = await import('esbuild')
  await build({ entryPoints: [path.join(frontend, 'tests/server-lifetime-fixture.ts')], bundle: true, platform: 'node', target: 'node20', format: 'cjs', outfile: fixture })
}
let server, port
async function start() {
  server = spawn(process.execPath, [fixture], { env: { ...process.env, FLOWBOARD_RUNTIME_DIR: runtime, FLOWBOARD_DEFAULT_ADMIN_EMAIL: 'workflow-root@example.com', FLOWBOARD_EMAIL_MODE: 'console', FLOWBOARD_GUEST_MODE: '0' }, stdio: ['ignore','ignore','pipe','ipc'] })
  let errors = ''; server.stderr.on('data', value => { errors = (errors + value.toString()).slice(-8000) })
  port = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(errors)), 10000); server.once('message', message => { clearTimeout(timer); resolve(message.port) }); server.once('exit', code => reject(new Error(`exit ${code}: ${errors}`))) })
}
async function stop() { if (server && server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGKILL'); await done } }
async function request(route, method = 'GET', body, actor = 'owner', status = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type':'application/json', ...(users[actor]?.cookie ? { Cookie: users[actor].cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) })
  const bytes = Buffer.from(await response.arrayBuffer()); let data
  try { data = JSON.parse(bytes.toString()) } catch { data = bytes }
  assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`)
  if (response.headers.get('set-cookie') && users[actor]) users[actor].cookie = response.headers.get('set-cookie').split(';')[0]
  return data
}
async function register(actor, email, inviteCode) {
  users[actor] = { email, password: 'Workflow-isolated-password-42', cookie: '' }
  const sent = await request('/api/auth/send-code', 'POST', { email, inviteCode }, actor)
  await request('/api/auth/register', 'POST', { email, inviteCode, password: users[actor].password, code: sent.developmentCode }, actor, 201)
  users[actor].id = (await request('/api/auth/me', 'GET', undefined, actor)).user.id
}
async function failSync() {
  const id = `sync_${Date.now()}`; const done = new Promise(resolve => { const listener = message => { if (message.id === id) { server.off('message', listener); resolve() } }; server.on('message', listener) }); server.send({ id, command:'fail-next-sync' }); await done
}
try {
  await start(); await register('owner','workflow-root@example.com')
  const invitation = await request('/api/admin/invites','POST',{maxUses:1},'owner',201)
  await register('recipient','workflow-member@example.com',invitation.code)
  const members = await request('/api/management/members')
  assert.equal(members.length,2); assert.ok(members.every(member => !member.emailMasked.includes('workflow-')))
  let project = await request('/api/management/projects','POST',{name:'Workflow backup',mutationId:'workflow_project'},'owner',201)
  const route = `/api/management/projects/${project.id}`
  const beforeSetup = structuredClone(project)
  await request(`${route}/table-setup`,'POST',{roles:[{name:'Writer'}], tableConfig:{configured:true,visibleBaseFields:['unknown'],customFields:[]}},'owner',400)
  assert.deepEqual(await request(route),beforeSetup)
  project = await request(`${route}/table-setup`,'POST',{roles:[{name:'Writer',memberIds:[users.recipient.id]}],tableConfig:{configured:true,visibleBaseFields:['title','status','recipients'],baseLabels:{title:'Issue'},customFields:[{id:'score',name:'Score',type:'number',required:true},{id:'note',name:'Note',type:'text'}]},mutationId:'setup_once'})
  const roleId = project.roles[0].id
  const jsonBytes = Buffer.from('{"private":"unchanged"}')
  const asset = await request(`${route}/assets`,'POST',{name:'private.json',dataUrl:`data:application/json;base64,${jsonBytes.toString('base64')}`},'owner',201)
  assert.deepEqual(await request(asset.url), {private:'unchanged'})
  await request(`${route}/events`,'POST',{id:'event_stable_fixture',title:'Missing required',roleId},'owner',400)
  project = await request(`${route}/events`,'POST',{id:'event_stable_fixture',title:'Visible snapshot',roleId,values:{score:4,note:'initial'},attachments:[asset.id],recipientIds:[users.recipient.id],mutationId:'create_stable'},'owner',201)
  const event = project.events[0]
  assert.equal(event.id,'event_stable_fixture'); assert.equal((await request('/api/management/notifications','GET',undefined,'recipient')).length,0)
  await request(route,'GET',undefined,'recipient',403)
  const notify = {recipientIds:[users.recipient.id],mutationId:'notice_once',revision:project.revision}
  await failSync(); await request(`${route}/events/${event.id}/notify`,'POST',notify,'owner',500)
  assert.equal((await request('/api/management/notifications','GET',undefined,'recipient')).length,0)
  const result = await request(`${route}/events/${event.id}/notify`,'POST',notify)
  assert.equal(result.count,1); assert.deepEqual(await request(`${route}/events/${event.id}/notify`,'POST',notify),result)
  const inbox = await request('/api/management/notifications','GET',undefined,'recipient')
  assert.equal(inbox.length,1); assert.equal(inbox[0].snapshot.values.score,4); assert.equal(inbox[0].snapshotLabels.fields.score,'Score'); assert.equal(inbox[0].snapshot.recipientIds,undefined)
  assert.deepEqual(await request(inbox[0].snapshot.attachments[0].url,'GET',undefined,'recipient'),{private:'unchanged'})
  await request(inbox[0].snapshot.attachments[0].url,'GET',undefined,'owner',404)
  await request(`/api/management/notifications/${inbox[0].id}/read`,'PATCH',{},'recipient')
  assert.equal((await request('/api/management/notifications?unread=1','GET',undefined,'recipient')).length,0)
  project = await request(route,'PATCH',{members:[{userId:users.recipient.id,permission:'view'}],revision:project.revision})
  assert.equal((await request(route,'GET',undefined,'recipient')).access,'view')
  await request(`${route}/events/${event.id}`,'PATCH',{status:'done'},'recipient',403)
  project = await request(route,'PATCH',{members:[{userId:users.recipient.id,permission:'edit'}],revision:project.revision})
  await request(route,'PATCH',{name:'not permitted'},'recipient',403)
  await request('/api/ai-shares','POST',{kind:'management',resourceId:project.id},'recipient',403)
  const baseEvent = structuredClone(project.events[0]), staleRevision = project.revision
  await request(`${route}/events/${event.id}`,'PATCH',{title:'Parallel title',baseValues:{title:baseEvent.title},expectedEventUpdatedAt:baseEvent.updatedAt,revision:staleRevision},'recipient')
  project = await request(`${route}/events/${event.id}`,'PATCH',{status:'doing',baseValues:{status:baseEvent.status},expectedEventUpdatedAt:baseEvent.updatedAt,revision:staleRevision})
  assert.equal(project.events[0].title,'Parallel title'); assert.equal(project.events[0].status,'doing')
  await request(`${route}/events/${event.id}`,'PATCH',{title:'lost title',baseValues:{title:baseEvent.title},revision:staleRevision},'owner',409)
  const fieldBase = structuredClone(project.events[0])
  await request(`${route}/events/${event.id}`,'PATCH',{values:{score:8},baseValues:{values:{score:fieldBase.values.score}},revision:staleRevision},'recipient')
  project = await request(`${route}/events/${event.id}`,'PATCH',{values:{note:null},baseValues:{values:{note:fieldBase.values.note}},revision:staleRevision})
  assert.equal(project.events[0].values.score,8); assert.equal(project.events[0].values.note,undefined)
  await request(`${route}/events/${event.id}`,'PATCH',{values:{score:9},baseValues:{values:{score:fieldBase.values.score}}},'owner',409)
  const stages = ['review','rejected','doing','review','ready','released','done','blocked','on_hold','cancelled','todo','doing','review','ready','released','done']
  for (const status of stages) {
    const before = structuredClone(project.events[0])
    project = await request(`${route}/events/${event.id}`,'PATCH',{status,baseValues:{status:before.status},expectedEventUpdatedAt:before.updatedAt,transitionNote:status==='rejected' ? '验收发现边界问题，需要返工' : undefined})
    const current = project.events[0]
    assert.equal(current.status,status); assert.ok(current.stageChangedAt >= before.stageChangedAt)
    assert.ok(current.stageTimes[before.status] >= (before.stageTimes[before.status] ?? 0))
    assert.equal(current.completedAt !== undefined,status==='done')
    if (status==='rejected') assert.equal(current.transitionNote,'验收发现边界问题，需要返工')
    else assert.equal(current.transitionNote,undefined)
  }
  const unchanged = structuredClone(project)
  await request(`${route}/events/${event.id}`,'PATCH',{transitionNote:'must not be silently ignored'},'owner',400)
  await request(`${route}/events/${event.id}`,'PATCH',{status:'invented_status'},'owner',400)
  await request(`${route}/events/${event.id}`,'PATCH',{stageTimes:{doing:1234}},'owner',400)
  assert.deepEqual(await request(route),unchanged)
  project = await request(`${route}/events`,'POST',{id:'cancelled_unassigned_fixture',title:'Cancelled work',status:'cancelled',values:{score:0}},'owner',201)
  const completeStats = await request(`${route}/stats`)
  assert.equal(completeStats.total,2); assert.equal(completeStats.activeTotal,1); assert.equal(completeStats.done,1); assert.equal(completeStats.cancelled,1); assert.equal(completeStats.completionPercent,100)
  assert.equal(completeStats.byStatus.length,10); assert.equal(completeStats.byRole.find(role=>role.id===roleId).statusCounts.done,1)
  const unassigned = await request(`${route}/stats?roleId=__unassigned__`)
  assert.equal(unassigned.total,1); assert.equal(unassigned.cancelled,1)
  assert.equal((await request(`${route}/events?roleId=__unassigned__`)).length,1)
  const records = await request(`${route}/work-records?roleId=${roleId}&date=${completeStats.today}&limit=200`)
  assert.ok(records.records.some(record=>record.statusAfter==='rejected' && record.note==='验收发现边界问题，需要返工'))
  assert.ok(records.records.every(record=>record.actorId && record.at && record.roleId===roleId))
  assert.equal(records.pagination.total,records.records.length)
  assert.equal((await request(`${route}/work-records?roleId=__unassigned__`)).pagination.total,1)
  await request(`${route}/work-records?date=2026-02-30`,'GET',undefined,'owner',400)
  const share = await request('/api/ai-shares','POST',{kind:'management',resourceId:project.id,scope:{eventIds:[event.id],canvasIds:[]}},'owner',201)
  const archive = await request('/api/admin/backup'), backup = JSON.parse(gunzipSync(archive))
  assert.equal(backup.meta.formatVersion,4); assert.equal(backup.management.schemaVersion,1)
  assert.deepEqual(backup.management.projects[`${project.id}.json`].members,project.members)
  assert.equal(Object.keys(backup.management.assets).length,1); assert.equal(backup.management.notifications.notifications.length,1)
  const oldSnapshot = await request(route)
  const badBackup = structuredClone(backup); badBackup.data['valid_canvas.json']={id:'valid_canvas',title:'must never write',createdAt:1,updatedAt:1}; badBackup.management.projects['../escape.json']=badBackup.management.projects[`${project.id}.json`]
  await request('/api/admin/restore','POST',badBackup,'owner',400)
  assert.deepEqual(await request(route),oldSnapshot)
  await assert.rejects(fs.access(path.join(runtime,'project-data','valid_canvas.json')))
  for (const corrupt of [payload => { const key = Object.keys(payload.management.assets)[0]; payload.management.assets[key].sha256 = '0'.repeat(64) },
    payload => { payload.management.projects[`${project.id}.json`].tableConfig.customFields[0].type = 'executable' },
    payload => { delete payload.management.projects[`${project.id}.json`].events[0].values },
    payload => { delete payload.management.projects[`${project.id}.json`].events[0].status },
    payload => { payload.management.notifications.notifications[0].snapshot.values.score = { unsafe:'object' } },
    payload => { payload.management.projects[`${project.id}.json`].events[0].stageTimes.invented = 1 }]) {
    const invalid = structuredClone(backup); invalid.data['valid_canvas.json'] = badBackup.data['valid_canvas.json']; corrupt(invalid)
    await request('/api/admin/restore','POST',invalid,'owner',400)
    assert.deepEqual(await request(route),oldSnapshot)
    await assert.rejects(fs.access(path.join(runtime,'project-data','valid_canvas.json')))
  }
  project = await request(`${route}/events/${event.id}`,'PATCH',{title:'Changed after backup'})
  await request(route,'DELETE',{})
  await request(`/api/ai-shares/${share.id}`,'DELETE',{})
  const restored = await request('/api/admin/restore','POST',backup)
  assert.equal(restored.ok,true); assert.deepEqual(await request(route),oldSnapshot)
  assert.deepEqual(await request(asset.url),{private:'unchanged'})
  const aiPath = new URL(share.jsonUrl).pathname
  const exported = await request(aiPath,'GET',undefined,'anonymous')
  assert.equal(exported.events[0].values.score,8)
  await request('/api/auth/login','POST',{email:users.recipient.email,password:users.recipient.password},'recipient')
  assert.deepEqual((await request('/api/management/notifications','GET',undefined,'recipient'))[0],(backup.management.notifications.notifications)[0])
  const legacy={meta:{formatVersion:3},data:{legacy_canvas:{}}}; legacy.data={'legacy_canvas.json':{id:'legacy_canvas',title:'Legacy v3',createdAt:1,updatedAt:2,ownerId:users.owner.id,content:'{}'}}
  await request('/api/admin/restore','POST',legacy)
  assert.equal((await request('/api/projects/legacy_canvas')).title,'Legacy v3')
  assert.deepEqual(await request(route),oldSnapshot)
  await request(`${route}/events/${event.id}`,'DELETE',{})
  await request(aiPath,'GET',undefined,'anonymous',404)
  const inactive = JSON.parse(gunzipSync(await request('/api/admin/backup')))
  await request('/api/admin/restore','POST',inactive)
  await request(aiPath,'GET',undefined,'anonymous',404)
  const afterInactive = await request(route)
  await stop(); await start(); assert.deepEqual(await request(route),afterInactive)
  console.log('PASS management workflow/backup: 10-stage transitions/timers/notes/cancellation stats/role records, atomic setup, typed fields, JSON private asset, explicit durable retry-safe inbox, snapshot proxy isolation, viewer/editor boundaries, disjoint base/custom edits and conflict rejection, v4 projects/history/assets/caps/inbox restore, pre-write traversal/hash/field/snapshot rejection, inactive-capability preservation, v3 compatibility, abrupt restart')
} finally { await stop(); assert.ok(path.dirname(runtime) === path.resolve(os.tmpdir()) && path.basename(runtime).startsWith('flowboard-workflow-backup-')); await fs.rm(runtime,{recursive:true,force:true}) }
