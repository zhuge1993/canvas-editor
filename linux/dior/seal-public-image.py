#!/usr/bin/env python3
"""Seal a successfully built CI candidate for public artifact publication.

Only the OS login receipt is encrypted; the rootfs contains its password hash.
The recipient PRIVATE key is never present in GitHub, logs, or image artifacts.
This does not build an image or claim that a phone has booted successfully.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import subprocess
import tarfile


def sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def seal_candidate(state: Path, recipient: Path) -> Path:
    images = state / 'images'
    release = state / 'public-release'
    if release.exists():
        raise ValueError('Refusing to reuse a public release directory')
    password = (state / 'login-password').read_text(encoding='utf-8').strip()
    if not re.fullmatch(r'[0-9a-f]{32}', password):
        raise ValueError('Missing or invalid generated OS password')
    receipt = (images / 'FIRST-LOGIN.txt').read_text(encoding='utf-8')
    if f'password={password}' not in receipt.splitlines():
        raise ValueError('Candidate login receipt does not match this build')
    revisions = (state / 'UPSTREAM-REVISIONS.txt').read_text(encoding='utf-8')
    match = re.search(r'^repository_revision=([0-9a-f]{40})$', revisions, re.M)
    if not match:
        raise ValueError('Missing source revision')
    # Verify the adapter's completed candidate before modifying its receipt.
    subprocess.run(['sha256sum', '-c', 'SHA256SUMS'], cwd=images, check=True,
                   stdout=subprocess.DEVNULL)
    # No cleartext credential in command-line arguments, stdout, or public files.
    encrypted = subprocess.run([
        'openssl', 'pkeyutl', '-encrypt', '-pubin', '-inkey', str(recipient),
        '-pkeyopt', 'rsa_padding_mode:oaep', '-pkeyopt', 'rsa_oaep_md:sha256',
        '-pkeyopt', 'rsa_mgf1_md:sha256',
    ], input=f'user=dior\npassword={password}\n'.encode(),
       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout
    if not encrypted:
        raise ValueError('Empty encrypted login receipt')
    (images / 'FIRST-LOGIN.enc').write_bytes(encrypted)
    (images / 'FIRST-LOGIN.txt').write_text(
        'OS login: dior (separate from FlowBoard web accounts).\n'
        'The random OS password is encrypted in FIRST-LOGIN.enc.\n'
        'The private key is supplied separately to the repository owner.\n'
        'Decrypt on your trusted computer, never in a public CI log:\n'
        'openssl pkeyutl -decrypt -inkey dior-v1-login-private-key.pem '
        '-in FIRST-LOGIN.enc -pkeyopt rsa_padding_mode:oaep '
        '-pkeyopt rsa_oaep_md:sha256 -pkeyopt rsa_mgf1_md:sha256\n'
        'Change the OS password with passwd after first login.\n'
        'No QQ SMTP authorization code is included.\n', encoding='utf-8')
    (images / 'BUILD-STATUS.txt').write_text(
        'The complete build entry point and rootfs acceptance checks passed.\n'
        'Candidate only: CI has not flashed or boot-tested a physical phone.\n'
        'OS login receipt encrypted with RSA-OAEP-SHA256 for the owner.\n'
        'Do not run the same-workspace flasher from a different PC.\n'
        'Cloud-download flashing instructions still need artifact-specific verification.\n',
        encoding='utf-8')
    files = sorted(file for file in images.rglob('*')
                   if file.is_file() and file.name != 'SHA256SUMS')
    # Fail closed if the generated password also leaked into another export,
    # including the raw rootfs. Scan in bounded chunks, including boundaries.
    secret_bytes = password.encode()
    for file in files:
        tail = b''
        with file.open('rb') as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                data = tail + chunk
                if secret_bytes in data:
                    raise ValueError('Plaintext OS password found in exported candidate')
                tail = data[-(len(secret_bytes) - 1):]
    (images / 'SHA256SUMS').write_text(''.join(
        f'{sha256(file)}  ./{file.relative_to(images).as_posix()}\n' for file in files),
        encoding='utf-8')
    release.mkdir()
    archive = release / f'DiorLinux-FlowBoard-V1-{match[1][:12]}-candidate.tar.gz'
    with tarfile.open(archive, 'w:gz') as tar:
        tar.add(images, arcname='dior-v1')
    (release / 'SHA256SUMS').write_text(
        f'{sha256(archive)}  {archive.name}\n', encoding='utf-8')
    return archive


if __name__ == '__main__':
    state = Path(os.environ['RUNNER_TEMP']).resolve() / 'flowboard-dior-v1'
    recipient = Path(__file__).resolve().with_name('ci-login-recipient.pub.pem')
    seal_candidate(state, recipient)
    print('Public image candidate sealed; no plaintext login receipt uploaded.')
