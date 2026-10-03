// Host-only pure helper regression; esbuild loads the TypeScript module.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = await build({ entryPoints: [path.join(frontend, 'managementInvites.ts')], bundle: true, platform: 'node', format: 'esm', write: false })
const { createProjectInvite, validateProjectInvite, normalizeStoredProjectInvite } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'))
const now = 1000, day = 24 * 60 * 60 * 1000
const project = { id: 'project', ownerId: 'owner', roles: [{ id: 'developer', name: '开发', color: '#123456' }, { id: 'reviewer', name: '验收', color: '#abcdef' }] }
const context = { project, ownerId: 'owner', registeredUsers: [{ id: 'owner' }, { id: 'alice' }, { id: 'bob' }], now }
const invite = createProjectInvite({ permission: 'edit', roleIds: ['developer', 'developer', 'reviewer'], recipientId: 'alice', maxUses: 1 }, context)
assert.equal(invite.projectId, 'project'); assert.equal(invite.ownerId, 'owner'); assert.equal(invite.permission, 'edit')
assert.deepEqual(invite.roleIds, ['developer', 'reviewer']); assert.equal(invite.recipientId, 'alice')
assert.equal(invite.expiresAt, now + 7 * day); assert.equal(invite.createdAt, now)
assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/); assert.equal(Buffer.from(invite.token, 'base64url').length, 32)
assert.equal(createProjectInvite({}, context).permission, 'view')
assert.equal(createProjectInvite({}, context).maxUses, 20)
assert.notEqual(createProjectInvite({}, context).token, createProjectInvite({}, context).token)
assert.notEqual(createProjectInvite({}, context).id, createProjectInvite({}, context).id)
assert.deepEqual(project.roles.map(role => role.id), ['developer', 'reviewer'])
assert.throws(() => createProjectInvite({}, { ...context, ownerId: 'alice' }), error => error.status === 403)
assert.throws(() => createProjectInvite({}, { ...context, registeredUsers: [] }), error => error.status === 403)
for (const body of [
  null, [], { permission: 'owner' }, { permission: 'admin' }, { permission: null }, { roleIds: ['foreign-role'] }, { roleIds: null },
  { recipientId: 'not-registered' }, { recipientId: null }, { maxUses: 0 }, { maxUses: 101 }, { maxUses: 1.5 }, { maxUses: null },
  { expiresAt: now }, { expiresAt: now - 1 }, { expiresAt: now + 30 * day + 1 }, { expiresAt: Infinity }, { expiresAt: null },
  { ownerId: 'alice' }, { token: 'attacker-selected-token' }, { projectId: 'foreign' },
]) assert.throws(() => createProjectInvite(body, context), error => error.status === 400)
assert.equal(createProjectInvite({ expiresAt: now + 30 * day }, context).expiresAt, now + 30 * day)

const acceptance = { project, actorId: 'alice', now: now + 1, acceptedUserIds: [] }
validateProjectInvite(invite, acceptance)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, actorId: 'bob' }), error => error.status === 403)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, actorId: '' }), error => error.status === 403)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, project: { ...project, id: 'foreign' } }), error => error.status === 403)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, project: { ...project, ownerId: 'new-owner' } }), error => error.status === 403)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, project: { ...project, roles: [] } }), error => error.status === 410)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, now: invite.expiresAt }), error => error.status === 410)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, now: invite.expiresAt + 1 }), error => error.status === 410)
validateProjectInvite(invite, { ...acceptance, acceptedUserIds: ['alice'] })
assert.throws(() => validateProjectInvite(invite, { ...acceptance, acceptedUserIds: ['bob'] }), error => error.status === 410)
const open = createProjectInvite({ maxUses: 2, roleIds: [] }, context)
validateProjectInvite(open, { ...acceptance, actorId: 'bob', acceptedUserIds: ['alice', 'alice'] })
validateProjectInvite(open, { ...acceptance, acceptedUserIds: ['alice', 'bob'] })
assert.throws(() => validateProjectInvite(open, { ...acceptance, actorId: 'carol', acceptedUserIds: ['alice', 'bob'] }), error => error.status === 410)
for (const patch of [{ permission: 'owner' }, { token: 'short' }, { roleIds: 'developer' }, { maxUses: 101 },
  { expiresAt: invite.createdAt + 30 * day + 1 }, { createdAt: -1 }])
  assert.throws(() => validateProjectInvite({ ...invite, ...patch }, acceptance), error => error.status === 400)
assert.throws(() => validateProjectInvite(invite, { ...acceptance, acceptedUserIds: ['bad/id'] }), error => error.status === 400)
const frozen = JSON.stringify(invite)
validateProjectInvite(invite, acceptance)
assert.equal(JSON.stringify(invite), frozen)
assert.deepEqual(normalizeStoredProjectInvite(invite), invite)
assert.notEqual(normalizeStoredProjectInvite(invite).roleIds, invite.roleIds)
assert.deepEqual(normalizeStoredProjectInvite({ ...invite, createdAt: 0, expiresAt: day }), { ...invite, createdAt: 0, expiresAt: day }, 'expired data remains structurally restorable')
for (const patch of [{ revokedAt: now }, { permission: 'admin' }, { roleIds: ['developer', 'developer'] }, { recipientId: '' },
  { maxUses: null }, { expiresAt: null }, { token: '-'.repeat(43) }])
  assert.throws(() => normalizeStoredProjectInvite({ ...invite, ...patch }), error => error.status === 400)
assert.equal(normalizeStoredProjectInvite({ ...invite, roleIds: ['no-longer-existing'] }).roleIds[0], 'no-longer-existing', 'store schema is independent of current resource existence')
const many = Array.from({ length: 100 }, (_, index) => `registered_${index}`)
const full = createProjectInvite({ maxUses: 100 }, context)
validateProjectInvite(full, { ...acceptance, actorId: many[0], acceptedUserIds: [...many, ...many] })
console.log('PASS: high-entropy project-only invite; owner/registered-target/roles/time/use guards; fresh resource and role checks; repeated actor consumes no extra use; no owner/admin grant, I/O, mail or token logging')
