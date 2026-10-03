#!/bin/sh
# Only installs the fixed Dior ASR runtime. Never touches SDK, audio, website or kernel.
set -eu
exec /usr/bin/python3 - "$@" <<'DIOR_ASR_INSTALL_PY'
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = Path('/opt/dior-asr')
BACKUP = Path('/opt/dior-asr.previous')
CONFIG = Path('/etc/dior-asr.json')
SERVICE = Path('/etc/init.d/dior-asr')
WORKER_SHA = '0d2206ee5fe10e63979a5f959883b5e414136f346e42e2b5eb0c4aeeee3b5dbd'
SOURCE_COMMIT = 'c794e1439fce79932e989220aa1c2848ecbdcdcf'
MODEL_NAMES = set(('tokens.txt',) + tuple(f'{c}_jit_trace-pnnx.ncnn.{s}'
                  for c in ('encoder', 'decoder', 'joiner') for s in ('param', 'bin')))
PROGRAM_TOP = {'asr-broker.py', 'asr-client.py', 'stream-worker', 'launch-stream-worker.py', 'README-install.md'}
MAX_BYTES = 80 * 1024 * 1024


def digest_file(path):
    value = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def ensure_plain(path, directory=False, root_owned=False):
    info = path.lstat()
    wanted = stat.S_ISDIR if directory else stat.S_ISREG
    if not wanted(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise ValueError(f'Refusing non-plain path: {path}')
    if root_owned and (info.st_uid != 0 or info.st_mode & 0o022):
        raise ValueError(f'Refusing mutable/non-root path: {path}')
    return info


def safe_name(name):
    parts = PurePosixPath(name).parts
    if not parts or name != '/'.join(parts) or any(part in ('', '.', '..') for part in parts):
        raise ValueError('Unsafe package member name')
    if any(not all(c.isascii() and (c.isalnum() or c in '._-') for c in part) for part in parts):
        raise ValueError('Unsupported package member name')
    allowed = (name == 'PACKAGE-MANIFEST.json'
               or len(parts) == 2 and parts[0] == 'program' and parts[1] in PROGRAM_TOP
               or 3 <= len(parts) <= 4 and parts[:2] == ('program', 'source')
               or len(parts) == 3 and parts[:2] == ('models', 'bilingual32') and parts[2] in MODEL_NAMES
               or name in ('etc/dior-asr.json', 'service/dior-asr.openrc'))
    if not allowed:
        raise ValueError(f'Unapproved package member: {name}')


def read_package(archive, expected_sha):
    info = ensure_plain(archive)
    if not 0 < info.st_size <= 70 * 1024 * 1024 or digest_file(archive) != expected_sha:
        raise ValueError('Archive size or SHA256 mismatch')
    members = {}
    total = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for member in tar:
            if len(members) >= 80:
                raise ValueError('Too many package members')
            safe_name(member.name)
            if not member.isfile() or member.name in members or not 0 <= member.size <= 45 * 1024 * 1024:
                raise ValueError('Expected unique bounded regular package files')
            total += member.size
            if total > MAX_BYTES:
                raise ValueError('Package exceeds uncompressed byte budget')
            members[member.name] = member
        manifest_member = members.get('PACKAGE-MANIFEST.json')
        if manifest_member is None or manifest_member.size > 128 * 1024:
            raise ValueError('Missing bounded manifest')
        manifest_data = tar.extractfile(manifest_member).read()
        manifest = json.loads(manifest_data)
        if (manifest.get('format') != 'dior-asr-runtime-v1'
                or manifest.get('source_commit') != SOURCE_COMMIT
                or manifest.get('worker_sha256') != WORKER_SHA
                or manifest.get('model_name') != 'bilingual32'):
            raise ValueError('Unexpected package provenance')
        descriptors = {}
        for item in manifest.get('files', []):
            name = item.get('path')
            safe_name(name)
            if name in descriptors or name == 'PACKAGE-MANIFEST.json':
                raise ValueError('Invalid manifest member')
            descriptors[name] = item
        if set(descriptors) != set(members) - {'PACKAGE-MANIFEST.json'}:
            raise ValueError('Manifest and package members differ')
        small = {}
        for name, item in descriptors.items():
            member = members[name]
            if (type(item.get('bytes')) is not int or item['bytes'] != member.size
                    or item.get('mode') not in (0o444, 0o640, 0o644, 0o755)
                    or member.mode != item['mode']):
                raise ValueError('Manifest size or mode mismatch')
            sha = hashlib.sha256()
            pieces = []
            with tar.extractfile(member) as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    sha.update(chunk)
                    if not name.startswith('models/'):
                        pieces.append(chunk)
            if sha.hexdigest() != item.get('sha256'):
                raise ValueError(f'Package member SHA mismatch: {name}')
            if not name.startswith('models/'):
                small[name] = b''.join(pieces)
        required = {'program/' + name for name in PROGRAM_TOP} | {'etc/dior-asr.json', 'service/dior-asr.openrc'}
        expected_models = {'models/bilingual32/' + name for name in MODEL_NAMES}
        if not required <= set(descriptors) or {name for name in descriptors if name.startswith('models/')} != expected_models:
            raise ValueError('Missing fixed runtime files or seven model files')
        config = json.loads(small['etc/dior-asr.json'])
        model_config = sorted(config.get('model_files', []), key=lambda item: item['path'])
        wanted = sorted([{'path': name, 'bytes': descriptors['models/bilingual32/' + name]['bytes'],
                          'sha256': descriptors['models/bilingual32/' + name]['sha256']} for name in MODEL_NAMES],
                        key=lambda item: item['path'])
        if (config.get('version') != 1 or config.get('worker') != str(ROOT / 'stream-worker')
                or config.get('worker_sha256') != WORKER_SHA or config.get('source_commit') != SOURCE_COMMIT
                or config.get('model_name') != 'bilingual32'
                or config.get('model_dir') != str(ROOT / 'models/bilingual32')
                or config.get('socket') != '/run/dior-asr/recognize.sock'
                or config.get('socket_group') != 'dior-asr' or model_config != wanted
                or config.get('threads') not in (1, 2, 3, 4)
                or config.get('decoder') not in ('greedy_search', 'modified_beam_search')
                or config.get('endpoint') != 1):
            raise ValueError('Config does not match the qualified fixed runtime')
        if hashlib.sha256(small['program/stream-worker']).hexdigest() != WORKER_SHA:
            raise ValueError('Worker binary mismatch')
        program_size = sum(len(value) for name, value in small.items() if name.startswith('program/'))
        if program_size > 16 * 1024 * 1024:
            raise ValueError('Program/source backup budget exceeded')
        for name in ('program/asr-broker.py', 'program/asr-client.py', 'program/launch-stream-worker.py'):
            compile(small[name], name, 'exec')
    return manifest, manifest_data, descriptors, small


def sync_dir(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path, data, mode, group=0):
    missing = []
    parent = path.parent
    while not parent.exists() and not parent.is_symlink():
        missing.append(parent)
        parent = parent.parent
    ensure_plain(parent, directory=True, root_owned=True)
    for directory in reversed(missing):
        directory.mkdir(mode=0o755)
        sync_dir(directory.parent)
    ensure_plain(path.parent, directory=True, root_owned=True)
    if path.exists() or path.is_symlink():
        ensure_plain(path, root_owned=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.dior-asr-write-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, 0, group)
        with os.fdopen(descriptor, 'wb') as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        sync_dir(path.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def bounded_tree(path, max_bytes=16 * 1024 * 1024):
    ensure_plain(path, directory=True, root_owned=True)
    total = count = 0
    for parent, dirs, files in os.walk(path, followlinks=False):
        for name in dirs:
            ensure_plain(Path(parent) / name, directory=True, root_owned=True)
        for name in files:
            info = ensure_plain(Path(parent) / name, root_owned=True)
            count += 1
            total += info.st_size
            if count > 120 or total > max_bytes:
                raise ValueError('Managed tree exceeds its fixed cleanup budget')


def remove_backup():
    if BACKUP.exists() or BACKUP.is_symlink():
        bounded_tree(BACKUP)
        marker = json.loads((BACKUP / 'install-backup.json').read_bytes())
        if marker.get('kind') != 'dior-asr-program-backup-v1' or marker.get('phase') != 'committed':
            raise ValueError('Refusing to prune an uncommitted or unrelated backup')
        shutil.rmtree(BACKUP)
        sync_dir(BACKUP.parent)


def command(*args, check=True):
    return subprocess.run(args, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def service_started():
    return command('rc-service', '--nodeps', 'dior-asr', 'status', check=False).returncode == 0


def create_account():
    try:
        group = grp.getgrnam('dior-asr')
    except KeyError:
        command('addgroup', '-S', 'dior-asr')
        group = grp.getgrnam('dior-asr')
    try:
        user = pwd.getpwnam('dior-asr')
    except KeyError:
        command('adduser', '-S', '-D', '-H', '-h', '/nonexistent', '-s', '/sbin/nologin', '-G', 'dior-asr', 'dior-asr')
        user = pwd.getpwnam('dior-asr')
    memberships = os.getgrouplist('dior-asr', user.pw_gid)
    if (user.pw_uid == 0 or user.pw_gid != group.gr_gid or user.pw_shell != '/sbin/nologin'
            or set(memberships) != {group.gr_gid}):
        raise ValueError('Existing ASR account must be dedicated, nologin and have no supplemental groups')
    for name in ('dior', 'flowboard'):
        try:
            client = pwd.getpwnam(name)
        except KeyError:
            continue
        if group.gr_gid not in os.getgrouplist(name, client.pw_gid):
            command('addgroup', name, 'dior-asr')
    return group.gr_gid


def old_program():
    if not ROOT.exists() and not ROOT.is_symlink():
        return None
    ensure_plain(ROOT, directory=True, root_owned=True)
    record = ROOT / 'INSTALL-MANIFEST.json'
    ensure_plain(record, root_owned=True)
    manifest = json.loads(record.read_bytes())
    if manifest.get('format') != 'dior-asr-runtime-v1':
        raise ValueError('Existing program lacks its managed install manifest')
    paths = {}
    for item in manifest['files']:
        safe_name(item['path'])
        if item['path'].startswith('program/'):
            target = ROOT / item['path'][8:]
            ensure_plain(target, root_owned=True)
            if target.stat().st_size != item['bytes'] or digest_file(target) != item['sha256']:
                raise ValueError('Existing program checksum mismatch; refusing to replace')
            paths[item['path']] = item
    if sum(item['bytes'] for item in paths.values()) > 16 * 1024 * 1024:
        raise ValueError('Existing program exceeds backup budget')
    expected_files = {name[8:] for name in paths} | {'INSTALL-MANIFEST.json'}
    actual_files = set()
    for parent, dirs, files in os.walk(ROOT, followlinks=False):
        for name in list(dirs):
            target = Path(parent) / name
            ensure_plain(target, directory=True, root_owned=True)
            if target == ROOT / 'models':
                dirs.remove(name)
        for name in files:
            target = Path(parent) / name
            ensure_plain(target, root_owned=True)
            actual_files.add(target.relative_to(ROOT).as_posix())
    if actual_files != expected_files:
        raise ValueError('Unmanaged files found under the existing program')
    return manifest


def check_existing_models(descriptors):
    model_root = ROOT / 'models'
    model_dir = model_root / 'bilingual32'
    ensure_plain(model_root, directory=True, root_owned=True)
    ensure_plain(model_dir, directory=True, root_owned=True)
    if {item.name for item in model_root.iterdir()} != {'bilingual32'} or {item.name for item in model_dir.iterdir()} != MODEL_NAMES:
        raise ValueError('Existing model layout differs; refusing model replacement')
    for name in MODEL_NAMES:
        target = model_dir / name
        info = ensure_plain(target, root_owned=True)
        expected = descriptors['models/bilingual32/' + name]
        if info.st_size != expected['bytes'] or digest_file(target) != expected['sha256']:
            raise ValueError('Existing model checksum mismatch; refusing model replacement')


def marker_write(record):
    atomic_write(BACKUP / 'install-backup.json', (json.dumps(record, sort_keys=True) + '\n').encode(), 0o600)


def clean_write_temps(path):
    if not path.exists():
        return
    ensure_plain(path, directory=True, root_owned=True)
    count = 0
    for parent, dirs, files in os.walk(path, followlinks=False):
        for name in dirs:
            ensure_plain(Path(parent) / name, directory=True, root_owned=True)
        for name in files:
            count += 1
            if count > 160:
                raise ValueError('Managed temporary cleanup exceeds file-count bound')
            if name.startswith('.dior-asr-write-'):
                suffix = name[len('.dior-asr-write-'):]
                if len(suffix) != 8 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_' for c in suffix):
                    raise ValueError('Unexpected managed temporary file name')
                target = Path(parent) / name
                info = ensure_plain(target, root_owned=True)
                if info.st_size > 45 * 1024 * 1024:
                    raise ValueError('Managed temporary file exceeds byte bound')
                target.unlink()
                sync_dir(target.parent)


def restore_backup(record):
    # Only files from this install's recorded bounded program may be removed.
    for name in record['candidate_program']:
        safe_name(name)
        target = ROOT / name[8:]
        if target.exists():
            ensure_plain(target, root_owned=True)
            target.unlink()
            sync_dir(target.parent)
    if record['previous_program']:
        for name in record['previous_program']:
            source = BACKUP / name
            ensure_plain(source, root_owned=True)
            mode = source.stat().st_mode & 0o777
            atomic_write(ROOT / name[8:], source.read_bytes(), mode)
        atomic_write(ROOT / 'INSTALL-MANIFEST.json', (BACKUP / 'INSTALL-MANIFEST.json').read_bytes(), 0o644)
        clean_write_temps(ROOT)
    for destination, saved in ((CONFIG, 'restore/dior-asr.json'), (SERVICE, 'restore/dior-asr.openrc')):
        source = BACKUP / saved
        if source.exists():
            info = ensure_plain(source, root_owned=True)
            atomic_write(destination, source.read_bytes(), info.st_mode & 0o777,
                         record.get('config_group', 0) if destination == CONFIG else 0)
        elif destination.exists():
            ensure_plain(destination, root_owned=True)
            destination.unlink()
            sync_dir(destination.parent)
    if not record['previous_program'] and ROOT.exists():
        # First-install cleanup is limited to the verified package-owned tree.
        bounded_tree(ROOT, MAX_BYTES)
        allowed = {name[8:] for name in record['candidate_program']} | {'INSTALL-MANIFEST.json'}
        allowed |= {'models/bilingual32/' + name for name in MODEL_NAMES}
        for parent, _dirs, files in os.walk(ROOT, followlinks=False):
            for name in files:
                relative = (Path(parent) / name).relative_to(ROOT).as_posix()
                if relative not in allowed and not name.startswith('.dior-asr-write-'):
                    raise ValueError('Unmanaged file found in first-install rollback tree')
        shutil.rmtree(ROOT)
        sync_dir(ROOT.parent)
    command('rc-update', 'del', 'dior-asr', 'default', check=False)
    if record['was_enabled']:
        command('rc-update', 'add', 'dior-asr', 'default')
    if record['was_started']:
        command('rc-service', '--nodeps', 'dior-asr', 'start')
    record['phase'] = 'committed'
    record['rolled_back'] = True
    marker_write(record)


def recover_incomplete():
    if not BACKUP.exists() and not BACKUP.is_symlink():
        return
    clean_write_temps(BACKUP)
    bounded_tree(BACKUP)
    if not any(BACKUP.iterdir()):
        # Power loss before the first atomic marker: no install mutation occurred.
        BACKUP.rmdir()
        sync_dir(BACKUP.parent)
        return
    record = json.loads((BACKUP / 'install-backup.json').read_bytes())
    if record.get('kind') != 'dior-asr-program-backup-v1':
        raise ValueError('Unrelated backup at managed path')
    if record.get('phase') == 'preparing':
        # Backup was not completed, and install paths have not been changed.
        shutil.rmtree(BACKUP)
        sync_dir(BACKUP.parent)
        return
    if record.get('phase') != 'committed':
        command('rc-service', '--nodeps', 'dior-asr', 'stop', check=False)
        restore_backup(record)


def install(archive, manifest, manifest_data, descriptors, small):
    for path in (Path('/opt'), Path('/etc'), Path('/etc/init.d'), Path('/run')):
        ensure_plain(path, directory=True, root_owned=True)
    for path in (Path('/opt/dior-android/run-native.py'), Path('/opt/dior-android/system/bin/linker')):
        ensure_plain(path, root_owned=True)
    for name in ('libc.so', 'libm.so', 'libdl.so', 'liblog.so'):
        ensure_plain(Path('/opt/dior-android/system/lib') / name, root_owned=True)
    for executable in ('rc-service', 'rc-update', 'addgroup', 'adduser', 'supervise-daemon'):
        if shutil.which(executable) is None:
            raise ValueError(f'Missing Alpine/OpenRC prerequisite: {executable}')
    lock_path = Path('/run/dior-asr-install.lock')
    if lock_path.exists() or lock_path.is_symlink():
        ensure_plain(lock_path, root_owned=True)
    lock_descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_descriptor, 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        recover_incomplete()
        previous = old_program()
        if previous is not None:
            check_existing_models(descriptors)
        for target in (CONFIG, SERVICE):
            if target.exists() or target.is_symlink():
                ensure_plain(target, root_owned=True)
        if previous is None and any(path.exists() for path in (CONFIG, SERVICE)):
            raise ValueError('Unmanaged ASR configuration/service exists')
        group = create_account()
        was_started = previous is not None and service_started()
        was_enabled = Path('/etc/runlevels/default/dior-asr').exists()
        remove_backup()
        BACKUP.mkdir(mode=0o700)
        sync_dir(BACKUP.parent)
        previous_paths = [item['path'] for item in previous['files'] if item['path'].startswith('program/')] if previous else []
        candidate_paths = [name for name in small if name.startswith('program/')]
        record = {'kind': 'dior-asr-program-backup-v1', 'phase': 'preparing',
                  'previous_program': previous_paths, 'candidate_program': candidate_paths,
                  'was_started': was_started, 'was_enabled': was_enabled, 'config_group': group}
        marker_write(record)
        for name in previous_paths:
            old = ROOT / name[8:]
            atomic_write(BACKUP / name, old.read_bytes(), old.stat().st_mode & 0o777)
        if previous:
            atomic_write(BACKUP / 'INSTALL-MANIFEST.json', (ROOT / 'INSTALL-MANIFEST.json').read_bytes(), 0o644)
        for path, saved in ((CONFIG, 'restore/dior-asr.json'), (SERVICE, 'restore/dior-asr.openrc')):
            if path.exists():
                atomic_write(BACKUP / saved, path.read_bytes(), path.stat().st_mode & 0o777)
        record['phase'] = 'prepared'
        marker_write(record)
        try:
            if was_started:
                command('rc-service', '--nodeps', 'dior-asr', 'stop')
            ROOT.mkdir(mode=0o755, exist_ok=True)
            sync_dir(ROOT.parent)
            ensure_plain(ROOT, directory=True, root_owned=True)
            if previous is None:
                with tarfile.open(archive, 'r:gz') as tar:
                    for member in tar:
                        if member.name.startswith('models/'):
                            target = ROOT / member.name
                            # ROOT/models/bilingual32 only; extraction never trusts tar paths.
                            with tar.extractfile(member) as handle:
                                data = handle.read()
                            if hashlib.sha256(data).hexdigest() != descriptors[member.name]['sha256']:
                                raise ValueError('Archive changed while extracting models')
                            atomic_write(target, data, 0o444)
            for name in candidate_paths:
                atomic_write(ROOT / name[8:], small[name], descriptors[name]['mode'])
            for name in set(previous_paths) - set(candidate_paths):
                old = ROOT / name[8:]
                ensure_plain(old, root_owned=True)
                old.unlink()
                sync_dir(old.parent)
            atomic_write(ROOT / 'INSTALL-MANIFEST.json', manifest_data, 0o644)
            atomic_write(CONFIG, small['etc/dior-asr.json'], 0o640, group)
            atomic_write(SERVICE, small['service/dior-asr.openrc'], 0o755)
            check_existing_models(descriptors)
            command('rc-service', '--nodeps', 'dior-asr', 'start')
            ready = False
            for _ in range(45):
                probe = subprocess.run(['/usr/bin/python3', str(ROOT / 'asr-client.py'), '--ready'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=4)
                if probe.returncode == 0:
                    ready = True
                    break
                time.sleep(1)
            if not ready:
                raise RuntimeError('ASR readiness timed out')
            command('rc-update', 'add', 'dior-asr', 'default')
            record['phase'] = 'committed'
            marker_write(record)
            print(json.dumps({'status': 'PASS', 'service': 'dior-asr', 'model': 'bilingual32',
                              'worker_sha256': WORKER_SHA, 'program_backup': str(BACKUP),
                              'model_backup_created': False, 'default_enabled': True}))
        except BaseException:
            command('rc-service', '--nodeps', 'dior-asr', 'stop', check=False)
            restore_backup(record)
            raise


parser = argparse.ArgumentParser(description='Install only the fixed, hash-verified Dior CPU ASR runtime')
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--validate-only', action='store_true')
args = parser.parse_args()
if len(args.sha256) != 64 or any(c not in '0123456789abcdef' for c in args.sha256):
    parser.error('sha256 must be 64 lowercase hexadecimal characters')
if not args.validate_only and os.geteuid() != 0:
    parser.error('Root is required to install; --validate-only makes no changes')
archive = args.archive.absolute()
if not args.validate_only:
    ensure_plain(archive, root_owned=True)
manifest, manifest_data, descriptors, small = read_package(archive, args.sha256)
if args.validate_only:
    print(json.dumps({'status': 'PASS', 'mode': 'validate-only', 'file_count': len(descriptors),
                      'model_files': 7, 'worker_sha256': WORKER_SHA}))
else:
    install(archive, manifest, manifest_data, descriptors, small)
DIOR_ASR_INSTALL_PY
