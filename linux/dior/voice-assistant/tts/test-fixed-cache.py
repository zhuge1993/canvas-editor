#!/usr/bin/env python3
"""Static fixture cache contracts; never reports synthetic PCM as real TTS."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import threading
from offline_tts import OfflineTTS,TTSCancelled,FIXED_PHRASES,PIPER_MODEL_SHA256

class NoWorkerTTS(OfflineTTS):
    def _command(self): raise AssertionError('fixed phrase spawned model worker')

base=Path(tempfile.mkdtemp(prefix='dior-tts-cache-contract-')).resolve()
if not base.is_relative_to(Path(tempfile.gettempdir()).resolve()): raise RuntimeError('unsafe test temp directory')
root=base/'fixed-cache';root.mkdir()
pcm=b'\x11\x00'*1600
entry={'file':'phrase-00.pcm','bytes':len(pcm),'sample_rate':16000,'sha256':hashlib.sha256(pcm).hexdigest()}
manifest={'schema':1,'engine':'piper','model_sha256':PIPER_MODEL_SHA256,'phrases':{FIXED_PHRASES[0]:entry}}
def write(data): (root/'manifest.json').write_text(json.dumps(data,ensure_ascii=False),encoding='utf8')
tests=[]
try:
    (root/'phrase-00.pcm').write_bytes(pcm);write(manifest)
    tts=NoWorkerTTS(base,'piper')
    files_before=sorted((p.name,p.stat().st_size) for p in root.iterdir())
    audio=tts.synthesize(FIXED_PHRASES[0],threading.Event())
    assert audio.pcm16==pcm and tts.last_report['cache_hit'] and not tts.last_report['model_inference_this_call']
    assert not tts.last_report['worker_spawned']
    assert sorted((p.name,p.stat().st_size) for p in root.iterdir())==files_before
    tests.append('whitelisted cache hit starts no model and writes no runtime files')
    cancel=threading.Event();cancel.set()
    try:tts.synthesize(FIXED_PHRASES[0],cancel)
    except TTSCancelled:pass
    else:raise AssertionError('cancelled cache audio returned')
    tests.append('cancelled fixed speech discarded')
    dynamic=dict(manifest);dynamic['phrases']={'untrusted dynamic answer':entry};write(dynamic)
    rejected=NoWorkerTTS(base,'piper');assert not rejected._fixed_cache and rejected.fixed_cache_error
    tests.append('dynamic phrase cannot enter fixed cache')
    oversized=dict(manifest);oversized['phrases']={FIXED_PHRASES[0]:dict(entry,bytes=1048578)};write(oversized)
    rejected=NoWorkerTTS(base,'piper');assert not rejected._fixed_cache and rejected.fixed_cache_error
    tests.append('1MiB cache byte cap enforced before reading PCM')
    write(manifest);(root/'phrase-00.pcm').write_bytes(b'\x00'*len(pcm))
    rejected=NoWorkerTTS(base,'piper');assert not rejected._fixed_cache and rejected.fixed_cache_error
    tests.append('corrupt PCM checksum rejected')
    write([])
    rejected=NoWorkerTTS(base,'piper');assert not rejected._fixed_cache and rejected.fixed_cache_error
    tests.append('invalid manifest safely falls back to selected offline engine')
    print(json.dumps({'status':'PASS_HOST_STATIC_CACHE_CONTRACT','tests':tests,
        'phone_tts_tested':False,'real_voice_generated':False,'dynamic_audio_persisted':False}))
finally:
    if not base.is_relative_to(Path(tempfile.gettempdir()).resolve()) or not base.name.startswith('dior-tts-cache-contract-'):
        raise RuntimeError('unsafe fixture cleanup')
    shutil.rmtree(base)
