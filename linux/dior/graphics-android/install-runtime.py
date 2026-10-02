#!/usr/bin/env python3
"""Provision this phone's original GPU libraries; never flash a partition."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess

HERE = Path(__file__).resolve().parent
PREFIX = Path('/opt/dior-android')
SOURCE = Path('/tmp/dior-kernel-test/android-system-ro')


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE/file)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verify_binary(path, expected):
    if digest(path) != expected:
        raise RuntimeError('Native tool SHA256 mismatch: '+path.name)
    with path.open('rb') as stream:
        raw = stream.read(52)
        if raw[:6] != b'\x7fELF\x01\x01':
            raise RuntimeError('Native tool must be little-endian ARM32 ELF')
        header = struct.unpack('<16sHHIIIIIHHHHHH', raw)
        if header[1] != 3 or header[2] != 40 or header[7] != 0x05000200:
            raise RuntimeError('Native tool must be ARM32 soft-float PIE')
        stream.seek(header[5])
        segments = [struct.unpack('<IIIIIIII', stream.read(32)) for _ in range(header[10])]
        interpreters = []
        for segment in segments:
            if segment[0] == 3:
                stream.seek(segment[1])
                interpreters.append(stream.read(segment[4]).rstrip(b'\0').decode('ascii'))
        if interpreters != ['/opt/dior-android/system/bin/linker']:
            raise RuntimeError('Native tool interpreter does not use the private SDK')


def install(args):
    if os.geteuid() != 0:
        raise RuntimeError('SDK provisioning requires root; native execution does not')
    if PREFIX.is_symlink():
        raise RuntimeError('Private SDK prefix cannot be a symlink')
    if PREFIX.exists() and not args.update:
        raise RuntimeError('SDK exists; use explicit --update to retain a backup')
    if PREFIX.exists():
        current = PREFIX.stat()
        if current.st_uid != 0 or current.st_mode & 0o022 or not (PREFIX/'SOURCE-MANIFEST.json').is_file():
            raise RuntimeError('Existing SDK ownership/manifest is unexpected')
    mount = next((line.split() for line in Path('/proc/mounts').read_text().splitlines()
                  if line.split()[1] == str(SOURCE)), None)
    if (not mount or mount[2] != 'ext4' or 'ro' not in mount[3].split(',') or
            not {'noload', 'norecovery'}.intersection(mount[3].split(','))):
        raise RuntimeError('Mount original Android system at the source path read-only with noload')
    build = Path(args.build).resolve()
    proof = json.loads((build/'NATIVE-GPU-BUILD.json').read_text())
    if proof.get('android_api') != 19 or proof.get('compiler_dumpversion') != '4.9.x':
        raise RuntimeError('Expected the checked GCC4.9 / API19 public build')
    artifacts = {record['name']: record for record in proof['artifacts']}
    for name in ('dior-opencl-probe', 'dior-gles-probe'):
        verify_binary(build/name, artifacts[name]['sha256'])
    reader = module('runtime_source', 'runtime-source.py')
    properties = module('property_area', 'property-area.py')
    libraries = reader.original_libraries(SOURCE)
    sources = [(SOURCE/record['path'], Path('system')/record['path'], 0o644)
               for record in libraries.values()]
    reader.elf_metadata(SOURCE/'bin/linker')
    sources.append((SOURCE/'bin/linker', Path('system/bin/linker'), 0o755))
    sources.extend((build/name, Path('bin')/name, 0o755)
                   for name in ('dior-opencl-probe', 'dior-gles-probe'))
    sources.extend((HERE/name, Path(name), 0o755)
                   for name in ('run-native.py', 'verify-native.py'))
    stage = PREFIX.with_name(PREFIX.name+'.stage-'+str(os.getpid()))
    stage.mkdir(mode=0o755)
    stage.chmod(0o755)
    manifest = {'origin': 'this phone original Android 4.4.4 API19 system',
                'system_partition_written': False, 'vendor_binaries_uploaded': False,
                'global_libraries_replaced': False, 'files': []}
    for original, relative, mode in sources:
        target = stage/relative
        target.parent.mkdir(parents=True, exist_ok=True)
        parent = target.parent
        while parent != stage:
            parent.chmod(0o755)
            parent = parent.parent
        shutil.copyfile(original, target)
        target.chmod(mode)
        expected = digest(original)
        if digest(target) != expected:
            raise RuntimeError('SDK copy verification failed')
        with target.open('rb') as stream:
            os.fsync(stream.fileno())
        manifest['files'].append({'path': str(relative), 'bytes': target.stat().st_size,
                                  'sha256': expected})
    area = stage/'properties-area'
    with area.open('wb') as stream:
        stream.write(properties.encode(properties.PROPERTIES))
        stream.flush()
        os.fsync(stream.fileno())
    area.chmod(0o444)
    aliases = stage/'aliases'
    aliases.mkdir(mode=0o755)
    aliases.chmod(0o755)
    (aliases/'system').symlink_to('../system')
    (aliases/'vendor').symlink_to('../system/vendor')
    manifest['build_sha256'] = digest(build/'NATIVE-GPU-BUILD.json')
    with (stage/'SOURCE-MANIFEST.json').open('w', encoding='utf-8') as stream:
        stream.write(json.dumps(manifest, indent=2)+'\n')
        stream.flush()
        os.fsync(stream.fileno())
    (stage/'SOURCE-MANIFEST.json').chmod(0o644)
    for directory in sorted((path for path in stage.rglob('*') if path.is_dir() and not path.is_symlink()),
                            key=lambda path: len(path.parts), reverse=True):
        sync_directory(directory)
    sync_directory(stage)
    backup = None
    if PREFIX.exists():
        backup = PREFIX.with_name(PREFIX.name+'.backup-'+str(os.getpid()))
        os.rename(PREFIX, backup)
    try:
        os.rename(stage, PREFIX)
    except BaseException:
        if backup is not None:
            os.rename(backup, PREFIX)
        raise
    sync_directory(PREFIX.parent)
    rule = Path('/etc/udev/rules.d/70-dior-gpu-access.rules')
    rule.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(HERE/'70-dior-gpu-access.rules', rule)
    rule.chmod(0o644)
    import grp
    for file in ('/dev/kgsl-3d0', '/dev/ion'):
        node = Path(file)
        if not stat.S_ISCHR(node.stat().st_mode):
            raise RuntimeError('Expected actual GPU/ION character device')
        os.chown(node, 0, grp.getgrnam('video').gr_gid)
        node.chmod(0o660)
    subprocess.run(['udevadm', 'control', '--reload'], check=True)
    print(json.dumps({'prefix': str(PREFIX), 'backup': str(backup) if backup else None,
                      'original_libraries': len(libraries), 'ordinary_user_group': 'video',
                      'system_partition_written': False, 'vendor_binaries_uploaded': False,
                      'global_libraries_replaced': False}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', required=True, help='Directory containing checked binaries and build manifest')
    parser.add_argument('--update', action='store_true', help='Retain a backup when replacing this private SDK')
    install(parser.parse_args())
