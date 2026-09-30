#!/usr/bin/env python3
"""Extract the verified pmOS_root ext4 subpartition for direct userdata flashing."""
from __future__ import annotations
import argparse, hashlib, json, struct, uuid
from pathlib import Path
RAW_BYTES=1186988032
RAW_SHA='b03b8a94b73cac09dcbadbfbc372076fc356d500e2ef52c9fa83fce427f2be99'
ROOT_OFFSET=511705088
ROOT_BYTES=674234368
ROOT_UUID='2b3bcea5-5043-47de-a4f3-4959104f4762'
MAX_DOWNLOAD=838860800

def sha(p:Path)->str:
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(4*1024*1024),b''): h.update(b)
 return h.hexdigest()

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('raw'); ap.add_argument('output'); a=ap.parse_args()
 raw=Path(a.raw); out=Path(a.output)
 if raw.stat().st_size!=RAW_BYTES or sha(raw)!=RAW_SHA: raise ValueError('USB repair source image identity mismatch')
 with raw.open('rb') as src,out.open('wb') as dst:
  src.seek(ROOT_OFFSET); left=ROOT_BYTES
  while left:
   b=src.read(min(left,4*1024*1024))
   if not b: raise ValueError('source image truncated')
   dst.write(b); left-=len(b)
 if out.stat().st_size!=ROOT_BYTES or ROOT_BYTES>MAX_DOWNLOAD: raise ValueError('direct root image size invalid')
 with out.open('rb') as f: f.seek(1024); sb=f.read(1024)
 if struct.unpack_from('<H',sb,0x38)[0]!=0xEF53: raise ValueError('root partition is not ext filesystem')
 fsuuid=str(uuid.UUID(bytes=sb[0x68:0x78])); label=sb[0x78:0x88].split(b'\0')[0].decode('ascii')
 if fsuuid!=ROOT_UUID or label!='pmOS_root': raise ValueError('root UUID/label mismatch')
 blocks=struct.unpack_from('<I',sb,0x04)[0]; block_size=1024<<struct.unpack_from('<I',sb,0x18)[0]
 print(json.dumps({'source_raw_sha256':RAW_SHA,'root_offset':ROOT_OFFSET,'output_bytes':out.stat().st_size,'output_sha256':sha(out),'filesystem_uuid':fsuuid,'filesystem_label':label,'filesystem_bytes':blocks*block_size,'boot_pmos_root_uuid':ROOT_UUID,'uuid_matches_boot':True,'fastboot_max_download_bytes':MAX_DOWNLOAD,'fits_fastboot_max_download':True,'flash_partition':'userdata','flash_boot':False,'sparse':False},indent=2))
if __name__=='__main__': main()
