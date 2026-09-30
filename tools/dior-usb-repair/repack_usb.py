#!/usr/bin/env python3
"""Patch a verified V1 disk image offline. Never compile, flash, or change passwords."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import tarfile
import zipfile
import zlib

HERE = Path(__file__).resolve().parent
ORIGINAL_COMMIT = 'aceca7ee0275e30809a874cf986cc187ae5cde92'
ORIGINAL_RUN = 36665014260
ORIGINAL_TAR_SHA = 'ce44c0d16d80c0bb4c0e439beb504098ec868be8f65ff18cd8f6e11ae2263956'
ORIGINAL_IMAGE_SHA = 'a62237288cb87fb72975f5d6349c8f17df0cfcca01a32a3628b64b9f10836456'
ORIGINAL_IMAGE_BYTES = 1186988032
BOOT_SHA = '65373f60e3171e677d79fa792c31b7bd28c4d094a096056d7dc537b76b978601'
EARLY_LINE = '::sysinit:/usr/local/sbin/dior-usb-early\n'


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def run(args: list[str]) -> str:
    proc = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    # No command below prints authentication file contents.
    if proc.returncode:
        raise RuntimeError(f'Command failed ({proc.returncode}): {args[0]}\n{proc.stdout}')
    return proc.stdout


def debug(image: Path, command: str, *, write: bool = False) -> str:
    return run(['debugfs', *(['-w'] if write else []), '-R', command, str(image)])


def dump(image: Path, source: str, target: Path) -> bytes:
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        target.unlink()
    result = debug(image, f'dump {source} {target}')
    if not target.is_file():
        raise RuntimeError(f'Could not read required file {source}: {result}')
    return target.read_bytes()


def put(image: Path, source: Path, target: str, mode: int) -> None:
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', target) or '..' in target.split('/'):
        raise ValueError('Unsafe image pathname')
    parent = ''
    for component in target.split('/')[1:-1]:
        parent += '/' + component
        stat = debug(image, 'stat ' + parent)
        if 'File not found' in stat:
            debug(image, 'mkdir ' + parent, write=True)
        elif 'Type: directory' not in stat:
            raise ValueError('Refusing a non-directory image parent: ' + parent)
    stat = debug(image, 'stat ' + target)
    if 'Inode:' in stat:
        if 'Type: regular' not in stat:
            raise ValueError('Refusing to replace a link/non-file: ' + target)
        debug(image, 'rm ' + target, write=True)
    debug(image, f'write {source} {target}', write=True)
    for field, value in [('mode', f'0{mode:o}'), ('uid', '0'), ('gid', '0')]:
        debug(image, f'set_inode_field {target} {field} {value}', write=True)
    result = dump(image, target, source.parent / ('readback-' + source.name))
    if result != source.read_bytes():
        raise RuntimeError('Image write readback failed: ' + target)


def gpt_partitions(path: Path) -> list[tuple[int, int]]:
    size = path.stat().st_size
    with path.open('rb') as stream:
        if stream.read(512)[510:] != b'\x55\xaa':
            raise ValueError('Missing protective MBR')
        header = bytearray(stream.read(512))
        if header[:8] != b'EFI PART':
            raise ValueError('Expected the original GPT disk image')
        length, crc = struct.unpack_from('<II', header, 12)
        if not 92 <= length <= 512:
            raise ValueError('Bad GPT header length')
        struct.pack_into('<I', header, 16, 0)
        if zlib.crc32(header[:length]) != crc:
            raise ValueError('GPT header checksum mismatch')
        sector, count, entry_size, expected_crc = struct.unpack_from('<QIII', header, 72)
        if count > 128 or entry_size != 128:
            raise ValueError('Unexpected GPT layout')
        stream.seek(sector * 512)
        entries = stream.read(count * entry_size)
        if zlib.crc32(entries) != expected_crc:
            raise ValueError('GPT partition-table checksum mismatch')
        result = []
        for offset in range(0, len(entries), entry_size):
            entry = entries[offset:offset + entry_size]
            if not any(entry[:16]):
                continue
            start, end = struct.unpack_from('<QQ', entry, 32)
            if start > end or (end + 1) * 512 > size:
                raise ValueError('Partition outside the image')
            result.append((start * 512, (end - start + 1) * 512))
    if result != [(1048576, 510656512), (511705088, 674234368)]:
        raise ValueError('Layout differs from the verified original')
    return result


def copy_range(source: Path, target: Path, start: int, count: int) -> None:
    with source.open('rb') as src, target.open('wb') as dst:
        src.seek(start)
        while count:
            data = src.read(min(count, 4 * 1024 * 1024))
            if not data:
                raise ValueError('Truncated image')
            dst.write(data)
            count -= len(data)


def hash_range(source: Path, start: int, count: int) -> str:
    digest = hashlib.sha256()
    with source.open('rb') as stream:
        stream.seek(start)
        while count:
            data = stream.read(min(count, 4 * 1024 * 1024))
            if not data:
                raise ValueError('Truncated range')
            digest.update(data)
            count -= len(data)
    return digest.hexdigest()


def main(input_dir: Path, work: Path) -> None:
    for command in ['debugfs', 'e2fsck', 'dumpe2fs']:
        if not shutil.which(command):
            raise RuntimeError('Required host tool missing: ' + command)
    if work.exists():
        raise ValueError('Refusing to reuse a prior image work directory')
    work.mkdir(parents=True)
    archives = list(input_dir.glob('*.tar.gz'))
    if len(archives) != 1 or sha(archives[0]) != ORIGINAL_TAR_SHA:
        raise ValueError('Original artifact tar does not match the pinned build')
    extracted = work / 'original'
    extracted.mkdir()
    with tarfile.open(archives[0]) as archive:
        members = archive.getmembers()
        if sum(item.size for item in members) > 2 * 1024 ** 3:
            raise ValueError('Unexpected artifact expansion size')
        archive.extractall(extracted, filter='data')
    original = extracted / 'dior-v1/xiaomi-dior.img'
    if original.stat().st_size != ORIGINAL_IMAGE_BYTES or sha(original) != ORIGINAL_IMAGE_SHA:
        raise ValueError('Original rootfs identity mismatch')
    parts = gpt_partitions(original)
    start, count = parts[1]
    fs = work / 'rootfs-partition.img'
    copy_range(original, fs, start, count)
    (work / 'fsck-before.txt').write_text(run(['e2fsck', '-f', '-n', str(fs)]))
    super_before = run(['dumpe2fs', '-h', str(fs)])
    private = work / 'private-checks'
    private.mkdir(mode=0o700)
    protected_paths = ['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/fstab',
                       '/etc/ssh/sshd_config', '/opt/flowboard/flowboard.env',
                       '/opt/flowboard/server-bundle.cjs', '/opt/flowboard/start-server.sh']
    protected = {name: dump(fs, name, private / str(i)) for i, name in enumerate(protected_paths)}
    inittab = dump(fs, '/etc/inittab', work / 'inittab.original')
    anchor = b'::sysinit:/sbin/openrc sysinit\n'
    if inittab.count(anchor) != 1 or b'dior-usb-' in inittab:
        raise ValueError('Unexpected original inittab')
    payload = work / 'payload'
    payload.mkdir()
    (payload / 'inittab').write_bytes(inittab.replace(anchor, EARLY_LINE.encode() + anchor))
    (payload / '90-dior-usb.conf').write_text(
        '[keyfile]\nunmanaged-devices=interface-name:usb0;interface-name:ncm0;interface-name:rndis0\n')
    (payload / 'unudhcpd.usb0').write_text(
        '# Explicitly match the USB address configured by dior-usb-early.\n'
        'UNUDHCPD_SERVER=172.16.42.1\nUNUDHCPD_CLIENT=172.16.42.2\n')
    changed = {
        '/etc/inittab': (payload / 'inittab', 0o100644),
        '/etc/NetworkManager/conf.d/90-dior-usb.conf': (payload / '90-dior-usb.conf', 0o100644),
        '/etc/conf.d/unudhcpd.usb0': (payload / 'unudhcpd.usb0', 0o100644),
        '/usr/local/sbin/dior-usb-early': (HERE / 'dior-usb-early', 0o100755),
        '/usr/local/sbin/dior-usb-console': (HERE / 'dior-usb-console', 0o100755),
    }
    # No authentication, SSH, Wi-Fi, application or boot files are written.
    for target, (source, mode) in changed.items():
        put(fs, source, target, mode)
    for i, (name, before) in enumerate(protected.items()):
        if dump(fs, name, private / ('after-' + str(i))) != before:
            raise RuntimeError('Protected content changed: ' + name)
    for field in ['Filesystem UUID:', 'Filesystem features:', 'Block size:', 'Block count:']:
        old = [line for line in super_before.splitlines() if line.startswith(field)]
        new = [line for line in run(['dumpe2fs', '-h', str(fs)]).splitlines() if line.startswith(field)]
        if old != new:
            raise RuntimeError('Filesystem identity/geometry changed: ' + field)
    (work / 'fsck-after.txt').write_text(run(['e2fsck', '-f', '-n', str(fs)]))
    release = work / 'release'
    release.mkdir()
    output = work / 'xiaomi-dior-usb-ncm-acm.img'
    shutil.copyfile(original, output)
    with output.open('r+b') as out, fs.open('rb') as src:
        out.seek(start)
        shutil.copyfileobj(src, out, 4 * 1024 * 1024)
        out.flush()
        os.fsync(out.fileno())
    if output.stat().st_size != ORIGINAL_IMAGE_BYTES or gpt_partitions(output) != parts:
        raise RuntimeError('Output geometry changed')
    for offset, length in [(0, start), (start + count, ORIGINAL_IMAGE_BYTES - start - count)]:
        if hash_range(original, offset, length) != hash_range(output, offset, length):
            raise RuntimeError('Bytes outside the rootfs partition changed')
    verification = {
        'status': 'offline-rootfs-repack-verified; physical-USB-unverified',
        'original_commit': ORIGINAL_COMMIT, 'original_build_run': ORIGINAL_RUN,
        'repair_commit': os.environ.get('GITHUB_SHA', 'local'),
        'repair_run': os.environ.get('GITHUB_RUN_ID', 'local'),
        'original_rootfs_sha256': ORIGINAL_IMAGE_SHA,
        'rootfs_file': output.name, 'rootfs_bytes': output.stat().st_size,
        'rootfs_sha256': sha(output), 'flash_partition': 'userdata',
        'existing_boot_sha256': BOOT_SHA, 'existing_boot_bytes': 13113344,
        'boot_partition_max_bytes': 16777216, 'flash_boot': False,
        'kernel_recompiled': False, 'authentication_files_unchanged': True,
        'protected_files_unchanged': protected_paths,
        'all_bytes_outside_rootfs_partition_unchanged': True,
        'fsck_before_exit': 0, 'fsck_after_exit': 0,
        'changed_files': {name: {'sha256': sha(src), 'mode': oct(mode)}
                          for name, (src, mode) in changed.items()},
        'usb_design': 'android_usb ncm+acm; rndis+acm and acm-only bind-error fallbacks',
        'physical_device_usb_tested': False, 'windows_11_usb_tested': False,
        'original_password_retained': True, 'live_phone_data_preserved_by_reflash': False,
    }
    (release / 'VERIFICATION.json').write_text(json.dumps(verification, indent=2) + '\n')
    shutil.copyfile(HERE / 'README-USB.txt', release / 'README-USB.txt')
    for name in ['fsck-before.txt', 'fsck-after.txt']:
        shutil.copyfile(work / name, release / name)
    archive = release / 'DiorLinux-V1-USB-NCM-ACM.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
        z.write(output, 'DiorLinux-V1-USB-NCM-ACM/' + output.name)
        for name in ['README-USB.txt', 'VERIFICATION.json', 'fsck-before.txt', 'fsck-after.txt']:
            z.write(release / name, 'DiorLinux-V1-USB-NCM-ACM/' + name)
        for name in ['dior-usb-early', 'dior-usb-console', 'repack_usb.py']:
            z.write(HERE / name, 'DiorLinux-V1-USB-NCM-ACM/source/' + name)
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None:
            raise RuntimeError('ZIP integrity failed')
    (release / (archive.name + '.sha256')).write_text(f'{sha(archive)}  {archive.name}\n')
    # The downloaded original receipt remains encrypted. Never publish private-checks/.
    shutil.rmtree(private)
    print(json.dumps(verification, indent=2))
    print('Rootfs candidate prepared. This is not physical USB validation.')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: repack_usb.py INPUT_ARTIFACT_DIR NEW_WORK_DIR')
    main(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
