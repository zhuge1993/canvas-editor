#!/usr/bin/env python3
"""Stage pinned official KWS assets outside Git; no phone/system operations."""
import argparse
import concurrent.futures
import hashlib
import json
import math
from pathlib import Path,PurePosixPath
import shutil
import socket
import tarfile
import urllib.request
import zipfile

HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--worker',type=Path,required=True)
args=parser.parse_args();output=args.output.resolve();worker=args.worker.resolve(strict=True)
if output==HERE or output in HERE.parents or HERE in output.parents:raise ValueError('Assets must be outside source')
output.mkdir(parents=True,exist_ok=True);downloads=output/'downloads';downloads.mkdir(exist_ok=True)
pins=json.loads((HERE/'SOURCE-PINS.json').read_text(encoding='utf8'))
if hashlib.sha256(worker.read_bytes()).hexdigest()!=pins['qualified_worker_sha256']:raise ValueError('Worker qualification mismatch')
original=socket.getaddrinfo
socket.getaddrinfo=lambda host,port,family=0,type=0,proto=0,flags=0:original(host,port,socket.AF_INET,type,proto,flags)

def valid(path,size,sha):
    return path.is_file() and path.stat().st_size==size and hashlib.sha256(path.read_bytes()).hexdigest()==sha

def download(url,path,size,sha,ranges=False):
    if valid(path,size,sha):return
    if ranges:
        step=1024*1024;parts=downloads/(path.name+'.parts');parts.mkdir(exist_ok=True)
        def part(number):
            lo=number*step;hi=min(size,lo+step)-1;target=parts/(str(number)+'.part')
            if target.is_file() and target.stat().st_size==hi-lo+1:return target
            error=None
            for _ in range(6):
                try:
                    request=urllib.request.Request(url,headers={'Range':'bytes=%d-%d'%(lo,hi),'User-Agent':'Dior-KWS'})
                    with urllib.request.urlopen(request,timeout=10) as response:
                        if response.status!=206 or response.headers.get('Content-Range')!='bytes %d-%d/%d'%(lo,hi,size):raise ValueError('Unexpected range response')
                        block=response.read(step+1)
                    if len(block)!=hi-lo+1:raise ValueError('Range size mismatch')
                    target.write_bytes(block);return target
                except Exception as problem:error=problem
            raise error
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:pieces=list(pool.map(part,range(math.ceil(size/step))))
        with path.open('wb') as target:
            for piece in pieces:target.write(piece.read_bytes())
    else:
        with urllib.request.urlopen(url,timeout=30) as response:block=response.read(size+1)
        if len(block)!=size:raise ValueError('Download size mismatch')
        path.write_bytes(block)
    if not valid(path,size,sha):raise ValueError('Pinned artifact mismatch: '+path.name)

runtime=pins['runtime'];archive=downloads/'sherpa-armhf.tar.bz2'
download(runtime['url'],archive,runtime['bytes'],runtime['sha256'],ranges=True)
wanted={'bin/sherpa-onnx-keyword-spotter','lib/libonnxruntime.so','lib/libsherpa-onnx-c-api.so','lib/libsherpa-onnx-cxx-api.so'}
found=set()
with tarfile.open(archive,'r:bz2') as package:
    for member in package:
        parts=PurePosixPath(member.name).parts
        if len(parts)<2:continue
        relative='/'.join(parts[1:])
        if relative not in wanted:continue
        if not member.isfile() or member.size>32*1024*1024:raise ValueError('Unsafe required runtime member')
        target=output/'runtime'/relative;target.parent.mkdir(parents=True,exist_ok=True)
        with package.extractfile(member) as source:target.write_bytes(source.read())
        found.add(relative)
if found!=wanted:raise ValueError('Required runtime files missing')
model=output/'model-small';model.mkdir(exist_ok=True)
for item in pins['models']['files']:
    if PurePosixPath(item['path']).name!=item['path']:raise ValueError('Invalid fixed model name')
    download(item['url'],model/item['path'],item['bytes'],item['sha256'])
(model/'MANIFEST.json').write_text(json.dumps(pins['models'],indent=2)+'\n',encoding='utf8')
dictionary=pins['pypinyin'];wheel=downloads/'pypinyin.whl'
download(dictionary['url'],wheel,dictionary['bytes'],dictionary['sha256'])
vendor=output/'pypinyin-vendor';vendor.mkdir(exist_ok=True);total=0
with zipfile.ZipFile(wheel) as package:
    for entry in package.infolist():
        name=PurePosixPath(entry.filename)
        if name.is_absolute() or '..' in name.parts:raise ValueError('Unsafe wheel member')
        if entry.is_dir():continue
        total+=entry.file_size
        if total>20*1024*1024:raise ValueError('Dictionary extraction budget')
        target=vendor.joinpath(*name.parts);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(package.read(entry))
for name in ['compile_keywords.py','kws_adapter.py','run-native-benchmark.py','run-cli-benchmark.py']:
    shutil.copyfile(HERE/name,output/name)
native=output/'native';native.mkdir(exist_ok=True);shutil.copyfile(worker,native/'kws-worker')
print(json.dumps({'status':'STAGED_PINNED_RUNTIME','output':str(output),'system_install':False,
    'worker_sha256':pins['qualified_worker_sha256'],'phone_or_human_tested_by_this_preparer':False}))
