#!/usr/bin/env python3
"""Download/verify pinned public WAVs and optional OpenCC dictionaries outside Git."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.request
import wave

HERE=Path(__file__).resolve().parent
def digest(data):return hashlib.sha256(data).hexdigest()

def fetch(url,limit):
    if not url.startswith('https://'):raise ValueError('Expected HTTPS source')
    request=urllib.request.Request(url,headers={'User-Agent':'Dior-ASR-Reproduction/1'})
    with urllib.request.urlopen(request,timeout=30) as response:
        content=bytearray()
        while True:
            chunk=response.read(min(65536,limit+1-len(content)))
            if not chunk:break
            content.extend(chunk)
            if len(content)>limit:raise ValueError('Source exceeds byte budget')
    return bytes(content)

def verified_file(path,expected):
    if not path.is_file() or path.is_symlink():return False
    if path.stat().st_size!=expected['bytes'] or digest(path.read_bytes())!=expected['sha256']:
        raise ValueError('Existing output differs from pinned content: '+str(path))
    return True

def save(path,data,expected):
    if len(data)!=expected['bytes'] or digest(data)!=expected['sha256']:raise ValueError('Downloaded content hash mismatch: '+path.name)
    path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists():
        if verified_file(path,expected):return
        raise ValueError('Refusing to replace existing output')
    with path.open('xb') as f:f.write(data)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True,help='External cache root; WAV files under audio/, optional dictionaries under opencc/')
    parser.add_argument('--with-opencc',action='store_true')
    parser.add_argument('--verify-only',action='store_true',help='Do not access network or write files')
    args=parser.parse_args();output=args.output.resolve()
    manifest=json.loads((HERE/'evaluation-manifest.json').read_text(encoding='utf8'))
    checked=0
    for sample in manifest['samples']:
        name=sample['file']
        if Path(name).name!=name:raise ValueError('Unexpected sample basename')
        target=output/'audio'/name;expected={'bytes':sample['bytes'],'sha256':sample['audio_sha256']}
        if not verified_file(target,expected):
            if args.verify_only:raise ValueError('Missing pinned audio: '+name)
            data=fetch(sample['audio_source'],8*1024*1024)
            if sample.get('crop_start_s') is not None:
                with wave.open(io.BytesIO(data),'rb') as original:
                    if (original.getnchannels(),original.getsampwidth(),original.getframerate(),original.getcomptype())!=(1,2,16000,'NONE'):raise ValueError('Unexpected crop source format')
                    start=round(sample['crop_start_s']*16000);frames=sample['frames'];original.setpos(start);raw=original.readframes(frames)
                    if len(raw)!=frames*2:raise ValueError('Crop source shorter than pinned range')
                destination=io.BytesIO()
                with wave.open(destination,'wb') as out:
                    out.setnchannels(1);out.setsampwidth(2);out.setframerate(16000);out.writeframes(raw)
                data=destination.getvalue()
            save(target,data,expected)
        checked+=1
    dictionaries=0
    if args.with_opencc:
        pins=json.loads((HERE/'opencc-sources.json').read_text(encoding='utf8'))
        for item in pins['dictionaries']:
            target=output/'opencc'/item['name']
            if not verified_file(target,item):
                if args.verify_only:raise ValueError('Missing pinned dictionary: '+item['name'])
                save(target,fetch(item['source'],128*1024),item)
            dictionaries+=1
    print(json.dumps({'status':'PINNED_INPUTS_PASS','audio_files':checked,'opencc_dictionaries':dictionaries,
        'microphone_used':False,'cloud_recognizer_used':False,'training_membership':'unknown'}))

if __name__=='__main__':main()
