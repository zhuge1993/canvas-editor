#!/usr/bin/env python3
"""Pinned, bounded offline Chinese TTS candidate preparation; never deploys."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import urllib.request

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
DOWNLOADS = HERE/'downloads'
FILES = HERE/'piper-armv7'
MODEL = HERE/'models'
HF_REV = '375a0fe641dea077c2a47b4e9a056d6da521eed3'
BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/'+HF_REV+'/zh/zh_CN/huayan/x_low/'
DOWNLOADS.mkdir(exist_ok=True)
MODEL.mkdir(exist_ok=True)

def fetch(url,path,limit,expected=None,md5=None):
    if not path.is_file():
        request=urllib.request.Request(url,headers={'User-Agent':'DiorVoice-local-TTS-test'})
        total=0
        temporary=path.with_suffix(path.suffix+'.download')
        try:
            with urllib.request.urlopen(request,timeout=90) as response,temporary.open('wb') as out:
                while True:
                    chunk=response.read(1024*256)
                    if not chunk: break
                    total+=len(chunk)
                    if total>limit: raise RuntimeError('download size limit exceeded')
                    out.write(chunk)
            if expected is not None and total!=expected: raise RuntimeError('unexpected byte length')
            temporary.replace(path)
        finally:
            if temporary.is_file(): temporary.unlink()
    data=path.read_bytes()
    pins=json.loads((SOURCE/'DEPENDENCIES.json').read_text(encoding='utf8'))
    relative=path.relative_to(HERE).as_posix()
    pinned=next((a for a in pins['assets'] if a['path']==relative),None)
    if pinned is None or len(data)!=pinned['bytes'] or hashlib.sha256(data).hexdigest()!=pinned['sha256']:
        raise RuntimeError('asset differs from locked source checksum: '+relative)
    if len(data)>limit or (expected is not None and len(data)!=expected): raise RuntimeError('size mismatch '+str(path))
    if md5 and hashlib.md5(data).hexdigest()!=md5: raise RuntimeError('official voices.json MD5 mismatch')
    return {'file':str(path.relative_to(HERE)),'url':url,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}

artifacts=[]
archive=DOWNLOADS/'piper_linux_armv7l-2023.11.14-2.tar.gz'
artifacts.append(fetch('https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_armv7l.tar.gz',archive,40*1024*1024))
artifacts.append(fetch(BASE+'zh_CN-huayan-x_low.onnx',MODEL/'zh_CN-huayan-x_low.onnx',25*1024*1024,20628813,'2b96570db6becd09814a608c8d14a64f'))
artifacts.append(fetch(BASE+'zh_CN-huayan-x_low.onnx.json',MODEL/'zh_CN-huayan-x_low.onnx.json',65536,4164,'39efce50e05f04893ae656f9008698f7'))
artifacts.append(fetch(BASE+'MODEL_CARD',MODEL/'MODEL_CARD-huayan-x_low',65536,237,'715587a977945498c5741b74eb81a1fd'))

FILES.mkdir(exist_ok=True)
members=[]
links=[]
with tarfile.open(archive,'r:gz') as tar:
    total=0
    for member in tar.getmembers():
        name=PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not name.parts or name.parts[0]!='piper': raise RuntimeError('unsafe archive path')
        target=FILES.joinpath(*name.parts[1:])
        if not target.resolve().is_relative_to(FILES.resolve()): raise RuntimeError('archive escape')
        if member.isdir(): target.mkdir(parents=True,exist_ok=True); continue
        if member.issym() or member.islnk(): links.append((member,target)); continue
        if not member.isfile(): raise RuntimeError('special archive member')
        total+=member.size
        if total>150*1024*1024: raise RuntimeError('archive expanded size limit exceeded')
        target.parent.mkdir(parents=True,exist_ok=True)
        source=tar.extractfile(member)
        with source,target.open('wb') as out: shutil.copyfileobj(source,out)
        members.append({'path':member.name,'bytes':member.size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()})
    # On Windows, materialize only safe internal shared-library aliases as file
    # copies. Original archive and alias map stay available for Linux install.
    link_map={target.resolve():(member,target) for member,target in links}
    def resolve_alias(candidate,seen=None):
        seen=set() if seen is None else seen
        candidate=candidate.resolve()
        if not candidate.is_relative_to(FILES.resolve()): raise RuntimeError('unsafe archive alias')
        if candidate.is_file(): return candidate
        if candidate in seen or candidate not in link_map: raise RuntimeError('cyclic/unresolved archive alias')
        seen.add(candidate)
        nested,nested_target=link_map[candidate]
        nested_link=PurePosixPath(nested.linkname)
        if nested_link.is_absolute(): raise RuntimeError('absolute archive alias')
        next_path=nested_target.parent.joinpath(*nested_link.parts) if nested.issym() else FILES.joinpath(*nested_link.parts[1:])
        return resolve_alias(next_path,seen)
    for member,target in links:
        link=PurePosixPath(member.linkname)
        if link.is_absolute(): raise RuntimeError('absolute archive link')
        candidate=(target.parent.joinpath(*link.parts) if member.issym() else FILES.joinpath(*link.parts[1:])).resolve()
        candidate=resolve_alias(candidate)
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(candidate,target)
        members.append({'path':member.name,'alias_target':member.linkname,'bytes':target.stat().st_size})

manifest={'schema':1,'candidate':'local CPU neural TTS','piper_version':'2023.11.14-2','piper_commit':'38917ffd8c0e219c6581d73e07b30ef1d572fce1','model_revision':HF_REV,
 'voice':'zh_CN-huayan-x_low','sample_rate_hz':16000,'voice_quality_label':'x_low','voice_dataset_license':'Unknown as explicitly stated by upstream MODEL_CARD; do not publicly redistribute weights',
 'official_binary_platform':'Linux ARMv7l Raspberry Pi3/4; glibc compatibility and ARMv7 CPU instructions still require ELF and phone verification',
 'system_libraries_replaced':False,'phone_executed':False,'temporary_audio_created':False,'artifacts':artifacts,'archive_members':members,
 'sources':['https://github.com/rhasspy/piper/releases/tag/2023.11.14-2','https://github.com/rhasspy/piper/blob/2023.11.14-2/README.md',BASE+'MODEL_CARD']}
(HERE/'PIPER-PREPARE.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8',newline='\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='archive_members'},indent=2))
