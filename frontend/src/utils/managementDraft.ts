type DraftStorage = Pick<Storage, 'length' | 'key' | 'removeItem'>
/** A successful permanent project deletion also invalidates its local setup
 * and learning progress. Other projects and unsubmitted creation drafts stay. */
export function clearManagementProjectDrafts(storage: DraftStorage, projectId: string): void {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(projectId)) return
  const keys: string[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (key && (key.startsWith('flowboard.table-setup-draft.v1:') || key.startsWith('flowboard.project-guide.v1:')) &&
        key.endsWith(`:${projectId}`)) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}
