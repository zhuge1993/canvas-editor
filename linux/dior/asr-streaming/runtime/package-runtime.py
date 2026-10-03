#!/usr/bin/env python3
"""Package qualified CPU worker and externally supplied readonly model.

All inputs/output locations are caller selected. No SDK, recordings or logs.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import stat
import tarfile
SOURCE_COMMIT='c794e1439fce79932e989220aa1c2848ecbdcdcf'
WORKER_SHA='0d2206ee5fe10e63979a5f959883b5e414136f346e42e2b5eb0c4aeeee3b5dbd'
MODEL_NAMES=tuple(sorted(('tokens.txt',)+tuple(f'{c}_jit_trace-pnnx.ncnn.{s}' for c in ('encoder','decoder','joiner') for s in ('param','bin'))))
def regular(path):
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_size>45*1024*1024:raise ValueError('Expected bounded regular input: '+str(path))
    return path.read_bytes()
def stable_json(value):return (json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
def build(source_root,worker,model_dir,output,verify_only=False):
    runtime=source_root/'runtime';config=json.loads(regular(runtime/'dior-asr.json'))
    if config.get('source_commit')!=SOURCE_COMMIT or config.get('worker_sha256')!=WORKER_SHA or config.get('model_name')!='bilingual32':raise ValueError('Profile differs from qualified build')
    descriptors={e['path']:e for e in config['model_files']}
    if set(descriptors)!=set(MODEL_NAMES):raise ValueError('Expected seven model files')
    payload={}
    def add(name,path,mode=0o644):
        if name in payload:raise ValueError('Duplicate package file')
        payload[name]=(regular(path),mode)
    for name in ('asr-broker.py','asr-client.py','launch-stream-worker.py','README-install.md'):add('program/'+name,runtime/name)
    add('program/stream-worker',worker,0o755)
    if hashlib.sha256(payload['program/stream-worker'][0]).hexdigest()!=WORKER_SHA:raise ValueError('Binary qualification SHA mismatch; rerun device gate before publishing a new build')
    payload['etc/dior-asr.json']=(stable_json(config),0o640)
    add('service/dior-asr.openrc',runtime/'dior-asr.openrc',0o755)
    for directory in ('src','runtime','build','eval','tests','licenses'):
        for file in sorted((source_root/directory).glob('*')):
            if file.is_file() and file.suffix in ('.py','.json','.md','.txt','.cpp','.c','.h','.sh','.patch','.openrc'):add('program/source/'+directory+'/'+file.name,file)
    for name in ('README.md','BUILDING.md','provenance.json','model-sources.json'):
        if (source_root/name).is_file():add('program/source/'+name,source_root/name)
    for name in MODEL_NAMES:
        data=regular(model_dir/name);expected=descriptors[name]
        if len(data)!=expected['bytes'] or hashlib.sha256(data).hexdigest()!=expected['sha256']:raise ValueError('Readonly model SHA mismatch: '+name)
        payload['models/bilingual32/'+name]=(data,0o444)
    if len(payload)+1>80 or sum(len(v[0]) for v in payload.values())>80*1024*1024:raise ValueError('Package exceeds installer budget')
    manifest={'format':'dior-asr-runtime-v1','source_commit':SOURCE_COMMIT,'model_name':'bilingual32','worker_sha256':WORKER_SHA,'files':[{'path':n,'bytes':len(d),'sha256':hashlib.sha256(d).hexdigest(),'mode':m} for n,(d,m) in sorted(payload.items())]}
    if verify_only:
        print(json.dumps({'status':'INPUTS_HASHES_PASS','file_count':len(payload),'worker_sha256':WORKER_SHA,'model_files':7,'phone_install_verified':False}));return
    payload['PACKAGE-MANIFEST.json']=(stable_json(manifest),0o644)
    output.mkdir(parents=True,exist_ok=True);archive=output/'dior-asr-runtime.tar.gz'
    with archive.open('wb') as raw:
        with gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0,compresslevel=6) as gz:
            with tarfile.open(fileobj=gz,mode='w',format=tarfile.USTAR_FORMAT) as tar:
                for name,(data,mode) in sorted(payload.items()):
                    member=tarfile.TarInfo(name);member.size=len(data);member.mode=mode;member.uid=member.gid=member.mtime=0;member.uname=member.gname='root';tar.addfile(member,io.BytesIO(data))
    sha=hashlib.sha256(archive.read_bytes()).hexdigest();(output/'PACKAGE-MANIFEST.json').write_bytes(stable_json(manifest))
    proof={'archive':archive.name,'bytes':archive.stat().st_size,'sha256':sha,'file_count':len(payload),'worker_sha256':WORKER_SHA,'model_files':7,'sdk_included':False,'phone_install_verified':False}
    (output/'PACKAGE.json').write_bytes(stable_json(proof));print(json.dumps(proof))
if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source-root',type=Path,default=Path(__file__).resolve().parent.parent);parser.add_argument('--worker',type=Path,required=True);parser.add_argument('--model-dir',type=Path,required=True);parser.add_argument('--output',type=Path,required=True);parser.add_argument('--verify-only',action='store_true');args=parser.parse_args();build(args.source_root.resolve(),args.worker.resolve(),args.model_dir.resolve(),args.output.resolve(),args.verify_only)