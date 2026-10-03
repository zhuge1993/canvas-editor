#!/usr/bin/env python3
"""Materialize official ARM packages under private test dirs, never /usr/lib."""
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile

import argparse
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir',type=Path,required=True,help='private asset directory outside the source checkout')
parser.add_argument('--readelf',type=Path,help='ARM-capable readelf executable, required for private library ELF proof')
args=parser.parse_args()
HERE=args.output_dir.resolve()
SOURCE=Path(__file__).resolve().parent
for ancestor in [SOURCE,*SOURCE.parents]:
    if (ancestor/'.git').exists():
        if HERE.is_relative_to(ancestor): parser.error('model/binary preparation output must be outside the Git checkout')
        break
HERE.mkdir(parents=True,exist_ok=True)
DOWNLOADS=HERE/'downloads'

def safe_extract(tar,base,limit):
    base.mkdir(parents=True,exist_ok=True)
    links=[]; total=0; records=[]
    for member in tar.getmembers():
        name=PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts: raise RuntimeError('unsafe package path')
        if not name.parts or name.parts[0].startswith('.'): continue
        target=base.joinpath(*name.parts)
        if not target.resolve().is_relative_to(base.resolve()): raise RuntimeError('package path escaped')
        if member.isdir(): target.mkdir(parents=True,exist_ok=True); continue
        if member.issym() or member.islnk(): links.append((member,target)); continue
        if not member.isfile(): raise RuntimeError('special package file')
        total+=member.size
        if total>limit: raise RuntimeError('package inflated size cap')
        target.parent.mkdir(parents=True,exist_ok=True)
        with tar.extractfile(member) as src,target.open('wb') as out: shutil.copyfileobj(src,out)
        records.append({'path':str(target.relative_to(HERE)),'bytes':member.size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    # Linux archives retain originals. Windows copies safe internal aliases.
    for member,target in links:
        link=PurePosixPath(member.linkname)
        if link.is_absolute():
            candidate=base.joinpath(*link.parts[1:]).resolve()
        else:
            candidate=(target.parent.joinpath(*link.parts) if member.issym() else base.joinpath(*link.parts)).resolve()
        if not candidate.is_relative_to(base.resolve()): raise RuntimeError('unsafe package alias')
        if not candidate.is_file():
            # loader aliases in libc6 .deb may resolve to another alias;
            # regular libc/ld versioned ELF files are collected independently.
            records.append({'path':str(target.relative_to(HERE)),'unresolved_alias':member.linkname}); continue
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(candidate,target)
        records.append({'path':str(target.relative_to(HERE)),'alias':member.linkname,'bytes':target.stat().st_size})
    return records

def deb_payload(path):
    data=path.read_bytes()
    if data[:8]!=b'!<arch>\n': raise RuntimeError('not Debian ar archive')
    offset=8
    while offset+60<=len(data):
        header=data[offset:offset+60]
        if header[58:60]!=b'`\n': raise RuntimeError('invalid ar header')
        name=header[:16].decode('ascii').strip().rstrip('/')
        size=int(header[48:58]); start=offset+60; end=start+size
        if end>len(data): raise RuntimeError('truncated Debian member')
        if name.startswith('data.tar'): return io.BytesIO(data[start:end])
        offset=end+(size&1)
    raise RuntimeError('missing Debian data archive')

pins=json.loads((SOURCE/'DEPENDENCIES.json').read_text(encoding='utf8'))
for pinned in pins['assets']:
    if not pinned['path'].endswith(('.apk','.deb')): continue
    candidate=HERE/pinned['path']
    if not candidate.is_file() or candidate.stat().st_size!=pinned['bytes'] or hashlib.sha256(candidate.read_bytes()).hexdigest()!=pinned['sha256']:
        raise RuntimeError('package differs from locked source checksum: '+pinned['path'])
packages=[]
for filename,expected in [('espeak-ng-1.52.0-r1.apk',9398633),('pcaudiolib-1.3-r0.apk',5100)]:
    path=DOWNLOADS/filename
    if path.stat().st_size!=expected: raise RuntimeError('APK byte count differs from pinned index')
    with tarfile.open(path,'r:gz',ignore_zeros=True) as tar:
        metadata=tar.extractfile('.PKGINFO').read().decode('utf8')
        records=safe_extract(tar,HERE/'espeak-alpine',25*1024*1024)
    packages.append({'file':filename,'bytes':expected,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'pkginfo':metadata,'files':records,'apk_signature_verified_on_phone':False})

private=HERE/'private-glibc'
private_lib=private/'lib'
private_lib.mkdir(parents=True,exist_ok=True)
for filename in ['libc6_2.31-0ubuntu9.18_armhf.deb','libstdc++6_10.5.0-1ubuntu1~20.04_armhf.deb','libgcc-s1_10.5.0-1ubuntu1~20.04_armhf.deb']:
    path=DOWNLOADS/filename
    package_root=private/'packages'/filename.removesuffix('.deb')
    with tarfile.open(fileobj=deb_payload(path),mode='r:*') as tar: records=safe_extract(tar,package_root,30*1024*1024)
    for candidate in package_root.rglob('*'):
        if candidate.is_file() and candidate.read_bytes()[:4]==b'\x7fELF':
            shutil.copyfile(candidate,private_lib/candidate.name)
    packages.append({'file':filename,'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'files':records})
for alias,canonical in {'ld-linux-armhf.so.3':'ld-2.31.so','libc.so.6':'libc-2.31.so','libm.so.6':'libm-2.31.so','libdl.so.2':'libdl-2.31.so','libpthread.so.0':'libpthread-2.31.so','librt.so.1':'librt-2.31.so'}.items():
    shutil.copyfile(private_lib/canonical,private_lib/alias)

readelf=args.readelf or shutil.which('arm-linux-gnueabihf-readelf') or shutil.which('arm-linux-androideabi-readelf') or shutil.which('readelf')
if not readelf: parser.error('--readelf is required when no ARM readelf is available in PATH')
proof=[]
for binary in [HERE/'espeak-alpine/usr/bin/espeak-ng',HERE/'espeak-alpine/usr/lib/libespeak-ng.so.1.52.0',private_lib/'ld-linux-armhf.so.3',private_lib/'libc.so.6']:
    output=subprocess.check_output([str(readelf),'-h','-A','-d','-n',str(binary)],text=True,encoding='utf8',errors='replace')
    proof.append('FILE '+str(binary.relative_to(HERE))+'\n'+output)
(HERE/'PRIVATE-LIBS-ELF.txt').write_text('\n'.join(proof),encoding='utf8')
manifest={'schema':1,'native_fallback':'Alpine ARMhf espeak-ng1.52.0-r1; mechanical/formant synthesis, not neural natural voice','native_required_system_libraries':['libc.musl-armhf.so.1','libgcc_s.so.1','libstdc++.so.6','libasound.so.2'],
 'piper_glibc_candidate':'Ubuntu Focal ARMhf glibc2.31 and GCC10 libraries in private-glibc/lib only; actual phone execution pending','system_libraries_replaced':False,'phone_executed':False,'packages':packages,
 'sources':['https://dl-4.alpinelinux.org/alpine/edge/community/armhf/APKINDEX.tar.gz','https://pkgs.alpinelinux.org/package/edge/community/armhf/espeak-ng','https://ports.ubuntu.com/pool/main/g/glibc/','https://ports.ubuntu.com/pool/main/g/gcc-10/']}
(HERE/'PRIVATE-LIBS-PREPARE.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8',newline='\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='packages'},indent=2))
print('private library bytes',sum(p.stat().st_size for p in private_lib.iterdir() if p.is_file()))
