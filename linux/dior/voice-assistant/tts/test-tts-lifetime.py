#!/usr/bin/env python3
"""Host process-lifecycle QA; does not claim physical speech synthesis."""
import io
import os
import sys
import threading
import time
import wave
from offline_tts import OfflineTTS,TTSCancelled,TTSError

class FixtureTTS(OfflineTTS):
    def __init__(self,code,**kwargs): super().__init__(**kwargs); self.code=code
    def _command(self): return [sys.executable,'-c',self.code],dict(os.environ),22050

tests=[]
audio=FixtureTTS('import sys,io,wave;sys.stdin.buffer.read();b=io.BytesIO();w=wave.open(b,"wb");w.setnchannels(1);w.setsampwidth(2);w.setframerate(22050);w.writeframes(b"\\x01\\x00"*2205);w.close();sys.stdout.buffer.write(b.getvalue())').synthesize('voice test',threading.Event())
assert audio.sample_rate==22050 and len(audio.pcm16)==4410
tests.append('bounded in-memory WAV to PCM')
cancel=threading.Event(); cancelled=[]
engine=FixtureTTS('import time,sys;sys.stdin.buffer.read();time.sleep(30)')
def run_cancel():
    try: engine.synthesize('cancel voice',cancel)
    except TTSCancelled: cancelled.append(True)
started=time.monotonic(); job=threading.Thread(target=run_cancel); job.start(); time.sleep(0.15); cancel.set(); job.join(2)
assert not job.is_alive() and cancelled and time.monotonic()-started<2
tests.append('cancel terminates worker and drops stale audio')
try: FixtureTTS('import sys;sys.stdin.buffer.read();sys.stdout.buffer.write(b"x"*2000000)').synthesize('over size',threading.Event())
except TTSError: pass
else: raise AssertionError('oversized PCM accepted')
tests.append('over-sized child output bounded')
try: FixtureTTS('import time,sys;sys.stdin.buffer.read();time.sleep(30)',timeout=1.0).synthesize('deadline',threading.Event())
except TTSError: pass
else: raise AssertionError('deadline not enforced')
tests.append('synthesis deadline terminates worker')
print({'status':'PASS_HOST_LIFETIME_ONLY','tests':tests,'phone_tts_tested':False,'audio_file_created':False})
