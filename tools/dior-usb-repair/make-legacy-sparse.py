#!/usr/bin/env python3
"""Create a deterministic old-bootloader sparse image using RAW + DONT_CARE only."""
import argparse, hashlib, json, struct
from pathlib import Path
MAGIC=0xED26FF3A; RAW=0xCAC1; SKIP=0xCAC3; BLOCK=4096
def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(4*1024*1024),b''): h.update(b)
    return h.hexdigest()
def build(src,out):
    size=src.stat().st_size
    if size%BLOCK: raise ValueError('raw image is not 4096-byte aligned')
    runs=[]; prev=None; start=count=idx=0
    with src.open('rb') as f:
        while True:
            b=f.read(BLOCK)
            if not b: break
            if len(b)!=BLOCK: raise ValueError('short final block')
            typ=RAW if any(b) else SKIP
            if prev is None: prev,start,count=typ,idx,1
            elif typ==prev: count+=1
            else: runs.append((prev,start,count)); prev,start,count=typ,idx,1
            idx+=1
    if prev is not None:runs.append((prev,start,count))
    with src.open('rb') as f,out.open('wb') as o:
        o.write(struct.pack('<I4H4I',MAGIC,1,0,28,12,BLOCK,size//BLOCK,len(runs),0))
        for typ,start,count in runs:
            if typ==RAW:
                o.write(struct.pack('<2H2I',typ,0,count,12+count*BLOCK)); f.seek(start*BLOCK); left=count*BLOCK
                while left:
                    b=f.read(min(left,4*1024*1024))
                    if not b: raise ValueError('truncated raw input')
                    o.write(b); left-=len(b)
            else:o.write(struct.pack('<2H2I',typ,0,count,12))
def verify(src,sparse):
    rawhash=digest(src); logical=hashlib.sha256(); zero=b'\0'*(1024*1024); types=set(); total=0
    with sparse.open('rb') as f:
        v=struct.unpack('<I4H4I',f.read(28))
        if v[:6]!=(MAGIC,1,0,28,12,BLOCK): raise ValueError('bad sparse header')
        for _ in range(v[7]):
            typ,_,count,size=struct.unpack('<2H2I',f.read(12)); types.add(typ); n=count*BLOCK
            if typ==RAW:
                if size!=12+n: raise ValueError('bad RAW chunk')
                left=n
                while left:
                    b=f.read(min(left,4*1024*1024))
                    if not b: raise ValueError('truncated RAW chunk')
                    logical.update(b); left-=len(b)
            elif typ==SKIP:
                if size!=12: raise ValueError('bad DONT_CARE chunk')
                left=n
                while left:
                    b=zero[:min(left,len(zero))]; logical.update(b); left-=len(b)
            else: raise ValueError(f'forbidden chunk type {typ:#x}')
            total+=n
        if f.read(): raise ValueError('trailing sparse bytes')
    if total!=src.stat().st_size or logical.hexdigest()!=rawhash: raise ValueError('sparse logical roundtrip mismatch')
    return {'raw_bytes':src.stat().st_size,'raw_sha256':rawhash,'sparse_bytes':sparse.stat().st_size,'sparse_sha256':digest(sparse),'chunk_types':[f'{x:#06x}' for x in sorted(types)],'logical_roundtrip_sha256':logical.hexdigest()}
def main():
    p=argparse.ArgumentParser(); p.add_argument('raw'); p.add_argument('sparse'); p.add_argument('--max-bytes',type=int,default=838860800); a=p.parse_args()
    src=Path(a.raw); out=Path(a.sparse); build(src,out); report=verify(src,out)
    if out.stat().st_size>a.max_bytes: raise ValueError('legacy sparse still exceeds target fastboot download limit')
    print(json.dumps(report,indent=2))
if __name__=='__main__': main()
