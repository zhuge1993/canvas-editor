import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Commit data before acknowledging a save, including the Linux directory entry. */
export async function replaceFileDurably(file: string, value: string | Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const staged = await fsp.open(temporary, 'wx', 0o600)
    try {
      await staged.writeFile(value)
      await staged.sync()
    } finally {
      await staged.close()
    }
    await fsp.rename(temporary, file)
    // Windows cannot open directories as file handles. Linux/ext4 needs this fsync
    // so an acknowledged replacement also survives a later power loss.
    if (process.platform !== 'win32') {
      const directory = await fsp.open(path.dirname(file), 'r')
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined)
  }
}
