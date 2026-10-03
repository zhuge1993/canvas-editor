#!/usr/bin/env python3
"""Bounded housekeeping for the Dior appliance; never prune business records."""
import argparse
try:
    import fcntl
except ImportError:  # Importable by isolated Windows tests; CLI stays Linux-only.
    fcntl = None
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import time

MIB = 1024 * 1024
DAY = 86400
TEMP_NAME = re.compile(r'.+\.json\.([0-9]+)\.[a-f0-9]{12}\.tmp\Z')
BACKUP_NAME = re.compile(r'workspace-[0-9]{8}-[0-9]{6}-[a-f0-9]{12}\Z')
TEST_NAME = re.compile(r'flowboard-(?:workspace|delete-example|core|invites|collaboration|access|lifetime|workflow)-[A-Za-z0-9_-]+\Z')


def regular(file):
    try:
        return stat.S_ISREG(file.lstat().st_mode)
    except FileNotFoundError:
        return False


def safe_tree(folder, limit=20000, protect_deletions=False, reject_deletions=False):
    """No symlink components, mount crossings, special files or unbounded walk."""
    if not folder.exists():
        return []
    if folder.resolve() != folder or not stat.S_ISDIR(folder.lstat().st_mode):
        raise ValueError('Housekeeping root is not a plain absolute directory')
    device = folder.stat().st_dev
    files = []
    seen = 0
    for parent, directories, names in os.walk(folder, followlinks=False):
        for name in directories + names:
            if reject_deletions and name == '.deletions':
                raise ValueError('Deployment staging contains an unknown deletion journal')
            file = Path(parent) / name
            info = file.lstat()
            seen += 1
            if seen > limit or info.st_dev != device or stat.S_ISLNK(info.st_mode):
                raise ValueError('Housekeeping tree exceeds limits or contains a link/mount')
            if stat.S_ISREG(info.st_mode):
                files.append(file)
            elif not stat.S_ISDIR(info.st_mode):
                raise ValueError('Housekeeping tree contains a special file')
        if protect_deletions:
            directories[:] = [name for name in directories if name != '.deletions']
    return files


class Maintenance:
    def __init__(self, base=Path('/'), now=None, apply=False, proc=Path('/proc')):
        self.base = Path(base).resolve()
        self.now = time.time() if now is None else now
        self.apply = apply
        self.proc = proc
        self.deadline = time.monotonic() + 25
        self.result = {'schemaVersion': 1, 'apply': apply, 'removedFiles': 0,
                       'removedBytes': 0, 'rotatedLogs': 0, 'removedBackups': 0,
                       'skippedUnsafe': 0, 'errors': 0, 'pressure': []}
        self.open_inodes = set()
        self.active_paths = []
        self.apk_busy = self.deploy_busy = False
        for process in proc.glob('[0-9]*'):
            try:
                command = (process / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
                self.active_paths.append(command)
                self.apk_busy |= bool(re.search(r'(?:^|/)apk(?: |$)', command))
                self.deploy_busy |= 'verify-flowboard-workspace.py' in command or 'deploy-flowboard-workspace.sh' in command
                for descriptor in (process / 'fd').iterdir():
                    try:
                        info = descriptor.stat()
                        self.open_inodes.add((info.st_dev, info.st_ino))
                    except OSError:
                        pass
            except OSError:
                pass

    def path(self, name):
        return self.base / name.lstrip('/')

    def removable(self, file):
        if time.monotonic() > self.deadline or not regular(file):
            return False
        info = file.stat()
        return (info.st_dev, info.st_ino) not in self.open_inodes

    def remove(self, file):
        if not self.removable(file):
            return False
        size = file.stat().st_size
        if self.apply:
            file.unlink()
        self.result['removedFiles'] += 1
        self.result['removedBytes'] += size
        return True

    def transient_writes(self):
        for name in ('/opt/flowboard/project-data', '/opt/flowboard/auth-data'):
            for file in safe_tree(self.path(name), protect_deletions=True):
                match = TEMP_NAME.fullmatch(file.name)
                if match and self.now - file.stat().st_mtime > DAY and not (self.proc / match[1]).exists():
                    self.remove(file)

    def scratch(self):
        # Only agent/test-owned scratch, never arbitrary /tmp or a mounted rootfs.
        roots = [self.path('/tmp/' + name) for name in ('dior-kernel-test', 'dior-app-tests',
                 'dior-gpu-user-tests', 'dior-legacy-tests', 'dior-native-r9')]
        tmp = self.path('/tmp')
        if tmp.exists() and tmp.resolve() == tmp:
            roots += [item for item in tmp.iterdir() if TEST_NAME.fullmatch(item.name)]
        files = []
        for root in roots:
            if any(str(root) in command for command in self.active_paths):
                continue
            try:
                files += safe_tree(root)
            except (ValueError, OSError):
                self.result['skippedUnsafe'] += 1
        total = sum(file.stat().st_size for file in files)
        for file in sorted(files, key=lambda item: item.stat().st_mtime):
            age = self.now - file.stat().st_mtime
            if age > 7 * DAY or (total > 128 * MIB and age > DAY):
                size = file.stat().st_size
                if self.remove(file):
                    total -= size
        if total > 128 * MIB:
            self.result['pressure'].append('scratch-protected-or-fresh')
        self.result['scratchBytesRemaining'] = total

    def apk_cache(self):
        if self.apk_busy:
            return
        files = [file for file in safe_tree(self.path('/var/cache/apk'))
                 if re.fullmatch(r'[A-Za-z0-9+_.:-]+\.(?:apk|tar\.gz)', file.name)]
        total = sum(file.stat().st_size for file in files)
        for file in sorted(files, key=lambda item: item.stat().st_mtime):
            if total <= 64 * MIB:
                break
            size = file.stat().st_size
            if self.remove(file):
                total -= size
        self.result['apkCacheBytesRemaining'] = total
        if total > 64 * MIB:
            self.result['pressure'].append('apk-cache-in-use')

    def backups(self):
        if self.deploy_busy:
            return
        parent = self.path('/root/flowboard-private-backups')
        if not parent.exists():
            return
        if parent.resolve() != parent:
            raise ValueError('Backup parent is not a plain directory')
        verified = []
        for folder in parent.iterdir():
            if not BACKUP_NAME.fullmatch(folder.name):
                continue
            try:
                if folder.resolve() != folder or not stat.S_ISDIR(folder.lstat().st_mode):
                    raise ValueError('Backup directory is not plain')
                entries = list(folder.iterdir())
                if {entry.name for entry in entries} != {'snapshot.tar.gz', 'verification.json'} or any(not regular(entry) for entry in entries):
                    raise ValueError('Backup contains unknown entries')
                files = safe_tree(folder)
                if {file.name for file in files} != {'snapshot.tar.gz', 'verification.json'} or any(file.parent != folder for file in files):
                    raise ValueError('Unrecognized backup contents')
                report_file = folder / 'verification.json'
                snapshot = folder / 'snapshot.tar.gz'
                if report_file.stat().st_size > 64 * 1024 or snapshot.stat().st_size > 20 * MIB:
                    raise ValueError('Backup exceeds deployment bound')
                report = json.loads(report_file.read_text(encoding='utf-8'))
                if report.get('schemaVersion') != 1 or report.get('backupDirectory') != str(folder) or report.get('result') not in ('PASS', 'FAILED_ROLLED_BACK'):
                    raise ValueError('Incomplete or unrecognized backup')
                digest = hashlib.sha256()
                with snapshot.open('rb') as source:
                    for chunk in iter(lambda: source.read(256 * 1024), b''):
                        digest.update(chunk)
                if digest.hexdigest() != report.get('backupSha256'):
                    raise ValueError('Backup digest differs')
                stage = self.path('/opt/flowboard') / ('.workspace-stage-' + folder.name[len('workspace-'):])
                if stage.exists() and (report.get('result') == 'PASS' or report.get('oldProgramHealthy') is True):
                    stage_files = safe_tree(stage, 10000, reject_deletions=True)
                    allowed = {'candidate.tar.gz', 'program', 'old-bundle.cjs', 'old-dist'}
                    if any(item.name not in allowed for item in stage.iterdir()) or any(not self.removable(file) for file in stage_files):
                        self.result['skippedUnsafe'] += 1
                    elif stage.parent == self.path('/opt/flowboard') and stage.resolve() == stage:
                        size = sum(file.stat().st_size for file in stage_files)
                        if self.apply:
                            shutil.rmtree(stage)
                        self.result['removedBytes'] += size
                        self.result['removedStages'] = self.result.get('removedStages', 0) + 1
                verified.append((folder, report.get('result'), sum(file.stat().st_size for file in files)))
            except (ValueError, OSError, TypeError):
                self.result['skippedUnsafe'] += 1
        verified.sort(key=lambda item: item[0].name, reverse=True)
        keep = {item[0] for item in verified[:3]}
        last_good = next((item[0] for item in verified if item[1] == 'PASS'), None)
        if last_good is not None and last_good not in keep:
            keep.discard(verified[2][0]); keep.add(last_good)
        for folder, _, size in verified:
            if folder in keep or time.monotonic() > self.deadline:
                continue
            if any(not self.removable(file) for file in safe_tree(folder)):
                continue
            # The absolute path was validated below this exact fixed parent.
            if folder.parent != parent or folder.resolve() != folder:
                raise ValueError('Backup cleanup escaped its fixed parent')
            if self.apply:
                shutil.rmtree(folder)
            self.result['removedBackups'] += 1
            self.result['removedBytes'] += size
        self.result['verifiedBackupsKept'] = len(keep)

    def logs(self):
        # Application logs have their own writer-level byte limits. These are OS diagnostics.
        log_root = self.path('/var/log')
        if log_root.exists() and log_root.resolve() != log_root:
            raise ValueError('Log parent is not a plain directory')
        for name in ('apk.log', 'dior-hardware-firstboot.log', 'dmesg'):
            file = self.path('/var/log/' + name)
            if not regular(file) or file.stat().st_size <= MIB:
                continue
            archive = file.with_name(file.name + '.1')
            if archive.exists() and not regular(archive):
                self.result['skippedUnsafe'] += 1; continue
            if self.apply:
                descriptor = os.open(file, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
                try:
                    info = os.fstat(descriptor)
                    os.lseek(descriptor, max(0, info.st_size - MIB), os.SEEK_SET)
                    tail = os.read(descriptor, MIB)
                    if info.st_size > MIB and b'\n' in tail:
                        tail = tail.split(b'\n', 1)[1]
                    out = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0), stat.S_IMODE(info.st_mode))
                    try:
                        os.write(out, tail); os.fsync(out)
                    finally:
                        os.close(out)
                    os.ftruncate(descriptor, 0); os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            self.result['rotatedLogs'] += 1

    def run(self):
        for method in (self.transient_writes, self.scratch, self.apk_cache, self.backups, self.logs):
            try:
                method()
            except (OSError, ValueError):
                self.result['errors'] += 1
        self.result['checkedAt'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(self.now))
        return self.result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--quiet', action='store_true')
    options = parser.parse_args()
    if fcntl is None or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        parser.error('Run fixed-target appliance housekeeping as Linux root')
    os.umask(0o077)
    with Path('/run/dior-maintenance.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        result = Maintenance(apply=options.apply).run()
        state = Path('/var/lib/dior-maintenance')
        state.mkdir(mode=0o700, exist_ok=True)
        if state.resolve() != state:
            raise ValueError('Maintenance state directory is not plain')
        temporary = state / 'status.tmp'
        if temporary.exists() and not regular(temporary):
            raise ValueError('Maintenance state temporary path is not regular')
        with temporary.open('w', encoding='utf-8') as output:
            json.dump(result, output); output.write('\n'); output.flush(); os.fsync(output.fileno())
        os.replace(temporary, state / 'status.json')
        if not options.quiet:
            print(json.dumps(result))
        return 1 if result['errors'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
