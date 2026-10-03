#!/usr/bin/env python3
"""Offline TTS synthesis only: bounded in-memory audio and cancellable worker.

Piper is neural speech; espeak is an explicitly labelled mechanical fallback.
No microphone, ALSA playback, mixer, network request or audio file is used here.
"""
from dataclasses import dataclass
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
import wave
import sys
import hashlib
import re

# Resolve the native Linux function in the parent, before any threaded fork.
# Child setup uses only prctl/getppid/setrlimit/_exit; no imports, file IO,
# library loading, CPU affinity or signal-handler installation in preexec.
_LINUX_CHILD_GUARDS=sys.platform.startswith('linux')
_PRCTL=None
_RESOURCE=None
if _LINUX_CHILD_GUARDS:
    import ctypes
    import resource
    _RESOURCE=resource
    _LIBC=ctypes.CDLL(None,use_errno=True)
    _PRCTL=_LIBC.prctl
    _PRCTL.argtypes=[ctypes.c_int,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong,ctypes.c_ulong]
    _PRCTL.restype=ctypes.c_int

CHILD_VM_LIMIT_BYTES=1024*1024*1024
CHILD_FD_LIMIT=64

def _unix_child_setup(expected_parent_pid):
    # PR_SET_PDEATHSIG=1. Verify the PID afterwards to close the race where
    # the parent dies before prctl has armed the death signal.
    if _PRCTL(1,signal.SIGTERM,0,0,0)!=0: os._exit(126)
    if os.getppid()!=expected_parent_pid: os._exit(126)
    _RESOURCE.setrlimit(_RESOURCE.RLIMIT_CORE,(0,0))
    for kind,desired in ((_RESOURCE.RLIMIT_AS,CHILD_VM_LIMIT_BYTES),
                         (_RESOURCE.RLIMIT_NOFILE,CHILD_FD_LIMIT)):
        _soft,hard=_RESOURCE.getrlimit(kind)
        cap=desired if hard==_RESOURCE.RLIM_INFINITY else min(desired,hard)
        _RESOURCE.setrlimit(kind,(cap,cap))

SUPPORTED_RATES={8000,16000,22050,24000,44100,48000}
FIXED_PHRASES=(
    "我在，请说。",
    "好的，唤醒词已经更新。",
    "好的，保持原来的唤醒词。",
    "请说确认，或者取消。",
    "音量已设为百分之0。",
    "音量已设为百分之100。",
    "音量已设为百分之50。",
    "我还没听清，请再说一遍。",
    "好的。",
    "请稍等。",
    "这次没有及时回答，请再问一次。",
)
FIXED_CACHE_LIMIT_BYTES=1024*1024
PIPER_MODEL_SHA256='d30b143fac66d821a1285aa013295adf5cd129d3cc11d70334e51c7b20662c37'

class TTSError(RuntimeError): pass
class TTSCancelled(TTSError): pass

@dataclass(frozen=True)
class TTSAudio:
    pcm16: bytes
    sample_rate: int

def _stop_process(process):
    if process.poll() is not None: return
    try:
        if os.name=='posix': os.killpg(process.pid,signal.SIGTERM)
        else: process.terminate()
    except ProcessLookupError: return
    try: process.wait(timeout=0.5)
    except subprocess.TimeoutExpired:
        try:
            if os.name=='posix': os.killpg(process.pid,signal.SIGKILL)
            else: process.kill()
        except ProcessLookupError: pass
        process.wait(timeout=1.0)

def _run_bounded(command,environment,text,cancel,timeout,max_bytes):
    if cancel.is_set(): raise TTSCancelled('TTS cancelled before synthesis')
    start=time.monotonic(); stdout=bytearray(); stderr=bytearray()
    oversize=threading.Event(); first_audio=[None]
    expected_parent_pid=os.getpid()
    if os.name=='posix' and not _LINUX_CHILD_GUARDS:
        raise TTSError('offline heavy TTS lifecycle guards require Linux')
    setup=(lambda: _unix_child_setup(expected_parent_pid)) if _LINUX_CHILD_GUARDS else None
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
        env=environment,start_new_session=(os.name=='posix'),bufsize=0,preexec_fn=setup)
    def drain(stream,out,limit,audio=False):
        try:
            while True:
                chunk=stream.read(16384)
                if not chunk: break
                if audio and first_audio[0] is None: first_audio[0]=time.monotonic()-start
                remaining=limit-len(out)
                out.extend(chunk[:max(0,remaining)])
                if audio and len(chunk)>remaining: oversize.set()
        finally: stream.close()
    readers=[threading.Thread(target=drain,args=(process.stdout,stdout,max_bytes,True),daemon=True),
             threading.Thread(target=drain,args=(process.stderr,stderr,8192),daemon=True)]
    for reader in readers: reader.start()
    reason=None
    try:
        try: process.stdin.write((text+'\n').encode('utf8'))
        except BrokenPipeError: pass  # Preserve the worker exit/error evidence below.
        finally: process.stdin.close()
        while process.poll() is None:
            if cancel.is_set(): reason='cancelled'; break
            if oversize.is_set(): reason='audio exceeded duration cap'; break
            if time.monotonic()-start>timeout: reason='synthesis deadline exceeded'; break
            time.sleep(0.02)
        if reason: _stop_process(process)
        for reader in readers: reader.join(timeout=1.0)
        if cancel.is_set() or reason=='cancelled': raise TTSCancelled('TTS cancelled; stale audio discarded')
        if reason: raise TTSError(reason)
        if process.returncode: raise TTSError('offline TTS worker failed '+str(process.returncode)+': '+stderr.decode('utf8','replace')[:1200])
        if oversize.is_set(): raise TTSError('audio exceeded duration cap')
        return bytes(stdout),bytes(stderr),time.monotonic()-start,first_audio[0]
    finally:
        _stop_process(process)
        if process.stdin and not process.stdin.closed: process.stdin.close()

class OfflineTTS:
    def __init__(self,base=None,engine='espeak',timeout=30.0,max_seconds=20.0,use_fixed_cache=True):
        self.base=Path(base or Path(__file__).resolve().parent).resolve()
        if engine not in ('espeak','piper'): raise ValueError('select espeak or piper explicitly')
        if not 1.0<=timeout<=120.0 or not 1.0<=max_seconds<=20.0: raise ValueError('TTS bounds out of range')
        self.engine=engine; self.timeout=timeout; self.max_seconds=max_seconds; self.last_report=None
        self._lock=threading.Lock()
        self._fixed_cache={}; self.fixed_cache_error=None
        if use_fixed_cache: self._load_fixed_cache()

    def _load_fixed_cache(self):
        root=self.base/'fixed-cache'
        manifest=root/'manifest.json'
        if not manifest.is_file(): return
        try:
            if manifest.is_symlink() or manifest.stat().st_size>32768: raise ValueError('invalid fixed cache manifest')
            data=json.loads(manifest.read_text(encoding='utf8'))
            if not isinstance(data,dict): raise ValueError('invalid fixed cache object')
            phrases=data.get('phrases')
            if type(data.get('schema')) is not int or data.get('schema')!=1 or data.get('engine')!=self.engine or not isinstance(phrases,dict) or len(phrases)>len(FIXED_PHRASES):
                raise ValueError('fixed cache engine/schema mismatch')
            if self.engine=='piper' and data.get('model_sha256')!=PIPER_MODEL_SHA256: raise ValueError('fixed cache model mismatch')
            cache={}; total=0
            for phrase,entry in phrases.items():
                if phrase not in FIXED_PHRASES or not isinstance(entry,dict): raise ValueError('non-whitelisted fixed cache phrase')
                name=entry.get('file',''); rate=entry.get('sample_rate'); declared=entry.get('bytes')
                if not isinstance(name,str) or not re.fullmatch(r'phrase-[0-9]{2}\.pcm',name): raise ValueError('invalid fixed PCM name')
                if name!='phrase-%02d.pcm'%FIXED_PHRASES.index(phrase): raise ValueError('fixed PCM phrase index mismatch')
                if type(rate) is not int or rate not in SUPPORTED_RATES or type(declared) is not int or declared<=0 or declared%2 or declared>self.max_seconds*rate*2:
                    raise ValueError('invalid fixed PCM bounds')
                total+=declared
                if total>FIXED_CACHE_LIMIT_BYTES: raise ValueError('fixed cache exceeds 1MiB')
                path=root/name
                if path.is_symlink() or not path.is_file() or path.stat().st_size!=declared: raise ValueError('invalid fixed PCM file')
                pcm=path.read_bytes()
                if hashlib.sha256(pcm).hexdigest()!=entry.get('sha256'): raise ValueError('fixed PCM checksum mismatch')
                cache[phrase]=TTSAudio(pcm,rate)
            self._fixed_cache=cache
        except (OSError,ValueError,TypeError) as error:
            # Invalid cache is never treated as generated audio. The normal
            # explicitly selected offline engine remains available.
            self.fixed_cache_error=str(error)[:200]; self._fixed_cache={}

    def _command(self):
        environment=dict(os.environ)
        # Do not leak the Bionic property transport or foreign library path
        # into musl or private-glibc synthesis children.
        environment.pop('ANDROID_PROPERTY_WORKSPACE',None)
        environment.pop('LD_PRELOAD',None)
        environment.pop('LD_LIBRARY_PATH',None)
        environment['OMP_NUM_THREADS']='2'
        environment['OPENBLAS_NUM_THREADS']='2'
        if self.engine=='espeak':
            binary=self.base/'espeak-alpine/usr/bin/espeak-ng'
            library=self.base/'espeak-alpine/usr/lib'
            environment['LD_LIBRARY_PATH']=str(library)
            return [str(binary),'--path='+str(self.base/'espeak-alpine/usr/share'),'-v','cmn','-s','230','--stdin','--stdout'],environment,22050
        piper=self.base/'piper-armv7'
        libraries=self.base/'private-glibc/lib'
        model=self.base/'models/zh_CN-huayan-x_low.onnx'
        return [str(libraries/'ld-linux-armhf.so.3'),'--library-path',str(libraries)+':'+str(piper),
            str(piper/'piper'),'--model',str(model),'--config',str(model)+'.json',
            '--espeak_data',str(piper/'espeak-ng-data'),'--output-raw'],environment,16000

    def synthesize(self,text,cancel):
        if not isinstance(text,str) or not text.strip() or len(text)>120 or '\x00' in text:
            raise TTSError('speech text must contain 1..120 characters without NUL')
        if not hasattr(cancel,'is_set'): raise TypeError('cancel must provide is_set')
        if not self._lock.acquire(blocking=False): raise TTSError('one TTS synthesis at a time')
        try:
            lookup_start=time.monotonic()
            if cancel.is_set(): raise TTSCancelled('TTS cancelled before cached speech')
            cached=self._fixed_cache.get(text.strip())
            if cached is not None:
                elapsed=time.monotonic()-lookup_start
                self.last_report={'engine':self.engine,'neural_voice':self.engine=='piper',
                    'mechanical_fallback':self.engine=='espeak','offline':True,'cloud_used':False,
                    'cache_hit':True,'cache_kind':'fixed_readonly_whitelist','model_inference_this_call':False,
                    'sample_rate':cached.sample_rate,'pcm_bytes':len(cached.pcm16),
                    'audio_seconds':len(cached.pcm16)/(2.0*cached.sample_rate),
                    'synthesis_seconds':elapsed,'first_output_seconds':elapsed,
                    'real_time_factor':elapsed/(len(cached.pcm16)/(2.0*cached.sample_rate)),
                    'worker_spawned':False,'audio_file_created':False}
                return cached
            command,environment,rate=self._command()
            raw,_stderr,elapsed,first=_run_bounded(command,environment,text.strip(),cancel,self.timeout,
                int(self.max_seconds*rate*2)+4096)
            if self.engine=='espeak':
                # espeak stdout is streaming WAV, with a placeholder data size.
                # Validate actual bounded bytes, not its future frame count.
                try:
                    with wave.open(io.BytesIO(raw),'rb') as wav:
                        if wav.getnchannels()!=1 or wav.getsampwidth()!=2 or wav.getframerate() not in SUPPORTED_RATES:
                            raise TTSError('unexpected offline synthesis WAV format')
                        rate=wav.getframerate(); pcm=wav.readframes(int(self.max_seconds*rate)+1)
                except (wave.Error,EOFError) as error: raise TTSError('invalid offline synthesis WAV') from error
            else: pcm=raw
            if cancel.is_set(): raise TTSCancelled('TTS cancelled; completed stale audio discarded')
            if not pcm or len(pcm)%2 or len(pcm)>int(self.max_seconds*rate*2): raise TTSError('invalid or oversized TTS PCM')
            duration=len(pcm)/(2.0*rate)
            self.last_report={'engine':self.engine,'neural_voice':self.engine=='piper',
                'mechanical_fallback':self.engine=='espeak','offline':True,'cloud_used':False,
                'sample_rate':rate,'pcm_bytes':len(pcm),'audio_seconds':duration,'synthesis_seconds':elapsed,
                'first_output_seconds':first,'real_time_factor':elapsed/duration,'audio_file_created':False}
            self.last_report['cache_hit']=False
            self.last_report['model_inference_this_call']=True
            self.last_report['worker_spawned']=True
            self.last_report['linux_child_lifecycle_guards']=_LINUX_CHILD_GUARDS
            self.last_report['child_limits']={'core_bytes':0,'address_space_bytes':CHILD_VM_LIMIT_BYTES,
                'open_files':CHILD_FD_LIMIT,'parent_death_signal':'SIGTERM'} if _LINUX_CHILD_GUARDS else None
            return TTSAudio(pcm,rate)
        finally: self._lock.release()

def main():
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base',type=Path,default=Path(__file__).resolve().parent)
    parser.add_argument('--engine',choices=['espeak','piper'],default='espeak')
    parser.add_argument('--timeout',type=float,default=30.0)
    parser.add_argument('--report',type=Path)
    parser.add_argument('--raw-stdout',action='store_true')
    args=parser.parse_args()
    import sys
    text=sys.stdin.buffer.read(2048).decode('utf8').strip()
    engine=OfflineTTS(args.base,args.engine,args.timeout)
    audio=engine.synthesize(text,threading.Event())
    if args.raw_stdout: sys.stdout.buffer.write(audio.pcm16); sys.stdout.buffer.flush()
    report=json.dumps(engine.last_report,ensure_ascii=False)
    print(report,file=sys.stderr,flush=True)
    if args.report: args.report.write_text(report+'\n',encoding='utf8')
    return 0

if __name__=='__main__': raise SystemExit(main())
