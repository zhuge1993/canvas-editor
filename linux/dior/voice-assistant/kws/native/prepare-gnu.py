#!/usr/bin/env python3
"""Download a small, official GNU ARMhf development package; no system install."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import socket
import tarfile
import urllib.request

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output",type=Path,required=True)
args=parser.parse_args()
HERE=args.output.resolve()
source_dir=Path(__file__).resolve().parent
if HERE==source_dir or HERE in source_dir.parents:raise ValueError("Output must be separate from source")
HERE.mkdir(parents=True,exist_ok=True)
_original = socket.getaddrinfo
socket.getaddrinfo = lambda host, port, family=0, type=0, proto=0, flags=0: _original(host, port, socket.AF_INET, type, proto, flags)

def download(url, filename, limit, expected_sha256):
    target = HERE / filename
    if not target.is_file():
        with urllib.request.urlopen(url, timeout=30) as src:
            data = src.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError('download exceeds size limit')
        target.write_bytes(data)
    data = target.read_bytes()
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected_sha256:
        raise RuntimeError('download/cache SHA256 mismatch: '+filename)
    return {'url': url, 'file': filename, 'bytes': len(data), 'sha256': actual}

def payload(data):
    if data[:8] != b'!<arch>\n':
        raise RuntimeError('not a Debian archive')
    pos = 8
    while pos + 60 <= len(data):
        header = data[pos:pos+60]
        size = int(header[48:58])
        if header[58:60] != b'`\n' or pos + 60 + size > len(data):
            raise RuntimeError('invalid Debian archive')
        if header[:16].decode('ascii').strip().startswith('data.tar'):
            return io.BytesIO(data[pos+60:pos+60+size])
        pos += 60 + size + (size & 1)
    raise RuntimeError('missing package data')

manifest = [download('https://ports.ubuntu.com/ubuntu-ports/pool/main/g/glibc/libc6-dev_2.31-0ubuntu9.18_armhf.deb', 'libc6-dev_2.31-0ubuntu9.18_armhf.deb', 4*1024*1024, 'fedd4b12c29a45094dacedf727101b6674c3f89ed07656eb5baffc072e0f411c')]
base = HERE / 'gnu-dev'
base.mkdir(exist_ok=True)
aliases = []
with tarfile.open(fileobj=payload((HERE/manifest[0]['file']).read_bytes()), mode='r:*') as archive:
    total = 0
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts:
            raise RuntimeError('unsafe package member')
        target = base.joinpath(*name.parts)
        if not target.resolve().is_relative_to(base.resolve()):
            raise RuntimeError('package escaped extraction root')
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif member.isfile():
            total += member.size
            if total > 20*1024*1024:
                raise RuntimeError('inflated package size cap')
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as src, target.open('wb') as dst:
                shutil.copyfileobj(src, dst)
        elif member.issym():
            aliases.append((target, member.linkname))
        else:
            raise RuntimeError('unsupported package member')
for target, link in aliases:
    candidate = target.parent.joinpath(link).resolve()
    if candidate.is_relative_to(base.resolve()) and candidate.is_file():
        shutil.copyfile(candidate, target)
manifest.append(download('https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v1.10.29/sherpa-onnx/c-api/c-api.h', 'c-api.h', 256*1024, 'c27e6af884e3e9c386a790612dd8c182a077f42b2293c58c6487641d457fcb73'))
(HERE/'GNU-SOURCES.json').write_text(json.dumps({'schema':1,'sources':manifest,'system_install':False},indent=2)+'\n',encoding='utf-8',newline='\n')
print(json.dumps(manifest, indent=2))
