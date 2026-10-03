#!/usr/bin/env python3
"""Pre-generate the finite phrase allowlist; runtime cache is readonly and <=1MiB."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from offline_tts import OfflineTTS,FIXED_PHRASES,FIXED_CACHE_LIMIT_BYTES,PIPER_MODEL_SHA256

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--base',type=Path,required=True,help='private extracted TTS runtime and model directory')
parser.add_argument('--output-dir',type=Path,help='new cache directory; default BASE/fixed-cache')
parser.add_argument('--engine',choices=['piper','espeak'],default='piper')
parser.add_argument('--timeout',type=float,default=60.0)
args=parser.parse_args()
base=args.base.resolve();output=(args.output_dir or base/'fixed-cache').resolve()
source=Path(__file__).resolve().parent
for ancestor in [source,*source.parents]:
    if (ancestor/'.git').exists():
        if output.is_relative_to(ancestor): parser.error('generated audio must remain outside the Git checkout')
        break
if output.exists(): parser.error('cache directory already exists; choose a fresh private directory')
output.parent.mkdir(parents=True,exist_ok=True)
model_sha=None
if args.engine=='piper':
    model=base/'models/zh_CN-huayan-x_low.onnx'
    model_sha=hashlib.sha256(model.read_bytes()).hexdigest()
    if model_sha!=PIPER_MODEL_SHA256: raise RuntimeError('Piper model differs from pinned voice')
engine=OfflineTTS(base,args.engine,args.timeout,use_fixed_cache=False)
temporary=Path(tempfile.mkdtemp(prefix='.fixed-cache-build-',dir=output.parent)).resolve()
if not temporary.is_relative_to(output.parent): raise RuntimeError('cache stage escaped target parent')
manifest={'schema':1,'engine':args.engine,'model_sha256':model_sha,'readonly_runtime':True,
    'dynamic_transcripts_cached':False,'max_phrases':len(FIXED_PHRASES),'max_pcm_bytes':FIXED_CACHE_LIMIT_BYTES,
    'voice_dataset_license':'Unknown' if args.engine=='piper' else 'GPL-3.0-or-later eSpeak data',
    'phrases':{},'skipped_byte_budget':[]}
total=0
try:
    for index,phrase in enumerate(FIXED_PHRASES):
        audio=engine.synthesize(phrase,threading.Event())
        if total+len(audio.pcm16)>FIXED_CACHE_LIMIT_BYTES:
            manifest['skipped_byte_budget'].append(index)
            print(json.dumps({'phrase_index':index,'status':'SKIP_BYTE_BUDGET'}),flush=True)
            continue
        name='phrase-%02d.pcm'%index
        path=temporary/name
        path.write_bytes(audio.pcm16)
        manifest['phrases'][phrase]={'file':name,'sample_rate':audio.sample_rate,'bytes':len(audio.pcm16),
            'sha256':hashlib.sha256(audio.pcm16).hexdigest(),'generation':engine.last_report}
        total+=len(audio.pcm16)
        print(json.dumps({'phrase_index':index,'status':'GENERATED','bytes':len(audio.pcm16),
            'synthesis_seconds':engine.last_report['synthesis_seconds']}),flush=True)
    if not manifest['phrases']: raise RuntimeError('no fixed speech generated')
    manifest['total_pcm_bytes']=total
    (temporary/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    # Files are regular read-only assets. Never place dynamic transcripts here.
    if os.name=='posix':
        for path in temporary.iterdir(): path.chmod(0o444)
    temporary.replace(output)
    print(json.dumps({'status':'FIXED_CACHE_GENERATED','phrases':len(manifest['phrases']),
        'total_pcm_bytes':total,'skipped_byte_budget':manifest['skipped_byte_budget'],
        'output':str(output),'phone_playback_tested':False}),flush=True)
finally:
    if temporary.exists():
        # This is only our verified private staging directory, never arbitrary
        # existing user data or an existing cache tree.
        if not temporary.is_relative_to(output.parent) or not temporary.name.startswith('.fixed-cache-build-'):
            raise RuntimeError('refuse unsafe cache-stage cleanup')
        shutil.rmtree(temporary)
