import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
const frontend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),runtime=await fs.mkdtemp(path.join(os.tmpdir(),'flowboard-project-invites-'))
const index=process.argv.indexOf('--fixture'),fixture=index<0 ? path.join(runtime,'fixture.cjs') : path.resolve(process.argv[index+1])
if(index<0){const {build}=await import('esbuild');await build({entryPoints:[path.join(frontend,'tests/server-lifetime-fixture.ts')],bundle:true,platform:'node',target:'node20',format:'cjs',outfile:fixture})}
let server,port;const accounts={};const password='Isolated-invite-password-42'
async function start(){server=spawn(process.execPath,[fixture],{env:{...process.env,FLOWBOARD_RUNTIME_DIR:runtime,FLOWBOARD_DEFAULT_ADMIN_EMAIL:'invite-root@example.com',FLOWBOARD_EMAIL_MODE:'console',FLOWBOARD_MAX_USERS:'5',FLOWBOARD_GUEST_MODE:'0'},stdio:['ignore','ignore','pipe','ipc']});let errors='';server.stderr.on('data',b=>{errors=(errors+b.toString()).slice(-8000)});port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(errors)),10000);server.once('message',m=>{clearTimeout(timer);resolve(m.port)});server.once('exit',code=>reject(new Error(`${code}:${errors}`)))})}
async function stop(){if(server&&server.exitCode===null){const done=once(server,'exit');server.kill('SIGKILL');await done}}
async function request(route,actor='alice',method='GET',body){const response=await fetch(`http://127.0.0.1:${port}${route}`,{method,headers:{'Content-Type':'application/json',...(accounts[actor]?.cookie?{Cookie:accounts[actor].cookie}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes.toString())}catch{data=bytes}if(response.headers.get('set-cookie')&&accounts[actor])accounts[actor].cookie=response.headers.get('set-cookie').split(';')[0];return{status:response.status,data}}
async function expect(route,actor='alice',method='GET',body,status=200){const r=await request(route,actor,method,body);assert.equal(r.status,status,`${method} ${route}:${JSON.stringify(r.data)}`);return r.data}
async function register(actor,email,inviteCode,projectInviteToken){accounts[actor]={email,cookie:''};const sent=await expect('/api/auth/send-code',actor,'POST',{email,inviteCode,projectInviteToken});const registered=await expect('/api/auth/register',actor,'POST',{email,password,code:sent.developmentCode,inviteCode,projectInviteToken},201);accounts[actor].id=registered.user.id;return registered.user}
async function login(actor){await expect('/api/auth/login',actor,'POST',{email:accounts[actor].email,password})}
async function failSync(){const id=`sync_${Date.now()}`;const done=new Promise(resolve=>{const fn=m=>{if(m.id===id){server.off('message',fn);resolve()}};server.on('message',fn)});server.send({id,command:'fail-next-sync'});await done}
const publicPath=invite=>`/api/management/invites/${invite.token}`
try{
 await start();await register('admin','invite-root@example.com')
 const siteInvite=await expect('/api/admin/invites','admin','POST',{maxUses:2},201)
 await register('alice','invite-alice@example.com',siteInvite.code);await register('bob','invite-bob@example.com',siteInvite.code)
 let project=await expect('/api/management/projects','alice','POST',{name:'Creator-owned project'},201),route=`/api/management/projects/${project.id}`
 project=await expect(`${route}/roles`,'alice','POST',{name:'Writer'},201);project=await expect(`${route}/roles`,'alice','POST',{name:'Reviewer'},201)
 const [writer,reviewer]=project.roles.map(role=>role.id)
 await expect(route,'bob','GET',undefined,403);await expect(`${route}/invites`,'bob','GET',undefined,403)
 const create={permission:'edit',roleIds:[writer],maxUses:1,mutationId:'create_member_invite'}
 const invite=await expect(`${route}/invites`,'alice','POST',create,201)
 assert.equal((await expect(`${route}/invites`,'alice','POST',create,201)).token,invite.token)
 assert.equal((await expect(`${route}/invites`)).length,1);assert.ok(new URL(invite.url).pathname.startsWith('/project-invite/'))
 await expect(publicPath(invite),'anonymous','GET',undefined,401)
 const preview=await expect(publicPath(invite),'bob');assert.equal(preview.projectName,project.name);assert.equal(preview.roles[0].id,writer);assert.equal(preview.events,undefined);assert.equal(preview.members,undefined)
 await failSync();await expect(`${publicPath(invite)}/accept`,'bob','POST',{},500)
 await expect(route,'bob','GET',undefined,403);assert.equal((await expect(`${route}/invites`))[0].uses,0)
 let joined=await expect(`${publicPath(invite)}/accept`,'bob','POST',{});assert.equal(joined.access,'edit');assert.equal(joined.ownerId,accounts.alice.id);assert.ok(joined.roles[0].memberIds.includes(accounts.bob.id));assert.equal(joined.inviteAcceptances,undefined)
 const joinedRevision=joined.revision;joined=await expect(`${publicPath(invite)}/accept`,'bob','POST',{});assert.equal(joined.revision,joinedRevision);assert.equal((await expect(`${route}/invites`))[0].uses,1)
 await expect(`${route}/roles/${writer}`,'bob','PATCH',{memberIds:[]},403)
 project=await expect(route,'alice','PATCH',{members:[{userId:accounts.bob.id,permission:'view',roleIds:[reviewer]}]})
 assert.deepEqual(project.members,[{userId:accounts.bob.id,permission:'view'}]);assert.deepEqual(project.roles.find(role=>role.id===writer).memberIds,[]);assert.ok(project.roles.find(role=>role.id===reviewer).memberIds.includes(accounts.bob.id))
 assert.equal((await expect(`${publicPath(invite)}/accept`,'bob','POST',{})).access,'view')
 project=await expect(route,'alice','PATCH',{members:[]});assert.equal(project.roles.some(role=>role.memberIds?.includes(accounts.bob.id)),false)
 await expect(`${publicPath(invite)}/accept`,'bob','POST',{},403)
 await expect(`${route}/invites/${invite.id}`,'alice','DELETE');await expect(publicPath(invite),'bob','GET',undefined,404)
 const onboarding=await expect(`${route}/invites`,'alice','POST',{permission:'edit',roleIds:[reviewer],maxUses:2},201)
 await expect('/api/auth/send-code','anonymous','POST',{email:'invite-root@example.com',projectInviteToken:onboarding.token},403)
 await expect('/api/auth/register','anonymous','POST',{email:'invite-root@example.com',password,code:'123456',projectInviteToken:onboarding.token},403)
 const newUser=await register('onboard','invite-onboard@example.com',undefined,onboarding.token);assert.equal(newUser.isAdmin,false)
 await expect('/api/admin/users','onboard','GET',undefined,403);await expect(route,'onboard','GET',undefined,403)
 joined=await expect(`${publicPath(onboarding)}/accept`,'onboard','POST',{});assert.equal(joined.access,'edit');assert.ok(joined.roles.find(role=>role.id===reviewer).memberIds.includes(newUser.id))
 assert.equal((await expect(`${route}/invites`)).find(item=>item.id===onboarding.id).uses,1)
 const raceInvite=await expect(`${route}/invites`,'alice','POST',{permission:'view',maxUses:1},201)
 accounts.racer={email:'invite-racer@example.com',cookie:''}
 const code=await expect('/api/auth/send-code','racer','POST',{email:accounts.racer.email,projectInviteToken:raceInvite.token})
 const raced=await Promise.all([request('/api/auth/register','racer','POST',{email:accounts.racer.email,password,code:code.developmentCode,projectInviteToken:raceInvite.token}),request(`${publicPath(raceInvite)}/accept`,'bob','POST',{})])
 assert.equal(raced.filter(r=>r.status===200||r.status===201).length,1,JSON.stringify(raced))
 assert.equal(raced.filter(r=>r.status===410).length,1,JSON.stringify(raced))
 const privateProject=JSON.parse(await fs.readFile(path.join(runtime,'project-data','management','projects',`${project.id}.json`),'utf8'))
 const privateUsers=JSON.parse(await fs.readFile(path.join(runtime,'auth-data','users.json'),'utf8'))
 const used=new Set([...(privateProject.inviteAcceptances??[]).filter(item=>item.inviteId===raceInvite.id).map(item=>item.userId),...privateUsers.filter(user=>user.projectInviteId===raceInvite.id).map(user=>user.id)])
 assert.equal(used.size,1)
 if(privateUsers.length<5)await register('last','invite-last@example.com',undefined,onboarding.token)
 accounts.over={email:'invite-over-cap@example.com',cookie:''}
 const capInvite=await expect(`${route}/invites`,'alice','POST',{maxUses:100},201)
 await expect('/api/auth/send-code','over','POST',{email:accounts.over.email,projectInviteToken:capInvite.token},403)
 const expectedOnboardingUses=(await expect(`${route}/invites`)).find(item=>item.id===onboarding.id).uses
 const archive=await expect('/api/admin/backup','admin'),backup=JSON.parse(gunzipSync(archive));assert.equal(backup.management.invites.schemaVersion,1);assert.ok(backup.auth['users.json'].some(user=>user.projectInviteId===onboarding.id));assert.ok(backup.management.projects[`${project.id}.json`].inviteAcceptances.length)
 const bad=structuredClone(backup);bad.data['must_not_write.json']={id:'must_not_write',title:'Invalid invite rollback proof',createdAt:1,updatedAt:1};bad.management.invites.invites[0].maxUses=0
 await expect('/api/admin/restore','admin','POST',bad,400);await assert.rejects(fs.access(path.join(runtime,'project-data','must_not_write.json')))
 await expect(`${route}/invites/${onboarding.id}`,'alice','DELETE');await expect(publicPath(onboarding),'onboard','GET',undefined,404)
 await expect('/api/admin/restore','admin','POST',backup);await login('alice');await login('onboard')
 assert.equal((await expect(`${route}/invites`)).find(item=>item.id===onboarding.id).uses,expectedOnboardingUses)
 assert.equal((await expect(`${publicPath(onboarding)}/accept`,'onboard','POST',{})).access,'edit')
 await stop();await start();assert.equal((await expect(route,'onboard')).ownerId,accounts.alice.id)
 console.log('PASS project invites: ordinary creator control; high-entropy idempotent links; auth-only minimal preview; atomic permission+role+use ledger; failed fsync no grant; replay cannot upgrade/regrant revoked membership; narrow verified nonadmin registration; shared-lock last-slot registration/accept race; global account cap; v4 private invite/source/ledger restore and malformed pre-write rejection; abrupt restart')
}finally{await stop();assert.ok(path.dirname(runtime)===path.resolve(os.tmpdir())&&path.basename(runtime).startsWith('flowboard-project-invites-'));await fs.rm(runtime,{recursive:true,force:true})}
