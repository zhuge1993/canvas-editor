#!/usr/bin/env python3
"""Fetch checksum-pinned official TTS assets to a private non-Git directory."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import urllib.request

SOURCE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir',type=Path,required=True)
parser.add_argument('--include',choices=['all','native','piper'],default='all')
args=parser.parse_args()
output=args.output_dir.resolve()
for ancestor in [SOURCE,*SOURCE.parents]:
    if (ancestor/'.git').exists():
        if output.is_relative_to(ancestor): parser.error('model/binary output must remain outside the Git checkout')
        break
pins=json.loads((SOURCE/'DEPENDENCIES.json').read_text(encoding='utf8'))

def verified(path,asset):
    if not path.is_file() or path.stat().st_size!=asset['bytes']: return False
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''): digest.update(chunk)
    return digest.hexdigest()==asset['sha256']

for asset in pins['assets']:
    native=asset['path'].endswith('.apk')
    if args.include=='native' and not native: continue
    if args.include=='piper' and native: continue
    target=output/asset['path']
    if not target.resolve().is_relative_to(output): raise RuntimeError('asset path escaped')
    if verified(target,asset): print('VERIFIED '+asset['path'],flush=True);continue
    target.parent.mkdir(parents=True,exist_ok=True)
    temporary=target.with_name(target.name+'.download')
    try:
        try:
            request=urllib.request.Request(asset['url'],headers={'User-Agent':'DiorVoice-offline-asset-preparation'})
            with urllib.request.urlopen(request,timeout=90) as response,temporary.open('wb') as stream:
                count=0
                while True:
                    chunk=response.read(256*1024)
                    if not chunk: break
                    count+=len(chunk)
                    if count>asset['bytes']: raise RuntimeError('asset exceeded pinned byte count')
                    stream.write(chunk)
        except OSError:
            curl=shutil.which('curl') or shutil.which('curl.exe')
            if not curl: raise
            # curl keeps normal certificate/hostname validation. No mirrors,
            # insecure TLS flag, source execution or package installation.
            subprocess.run([curl,'--fail','--silent','--show-error','--location','--retry','2',
                '--retry-all-errors','--max-time','1200','--max-filesize',str(asset['bytes']),
                '--output',str(temporary),asset['url']],check=True)
        if not verified(temporary,asset): raise RuntimeError('asset checksum/size mismatch: '+asset['path'])
        temporary.replace(target)
        print('VERIFIED '+asset['path'],flush=True)
    finally:
        if temporary.is_file(): temporary.unlink()
