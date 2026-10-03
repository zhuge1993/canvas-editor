"""Voice-side bounded IPC proxies; no second resident model is constructed."""
import base64
import io
import json
import errno
import hashlib
import os
import re
import stat
from pathlib import Path
import socket
import sys
import threading
import time
import uuid
import wave
from interfaces import AudioClip,LanguageReply
sys.dont_write_bytecode=True

class IPC:
    def __init__(self,path='/run/dior-inference/inference.sock'):self.path=path
    def request(self,op,cancel=None,deadline=None,**payload):
        deadline=deadline or time.monotonic()+3;cancel=cancel or threading.Event()
        ident=uuid.uuid4().hex;remaining=deadline-time.monotonic()
        if remaining<=0:raise TimeoutError('deadline')
        request={'v':1,'id':ident,'op':op,'deadline_ms':max(1000,min(30000,int(remaining*1000))),**payload}
        data=(json.dumps(request,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(data)>1024*1024:raise ValueError('request_limit')
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
            connection.settimeout(min(2,remaining));connection.connect(self.path);connection.sendall(data)
            buffer=bytearray()
            while True:
                if cancel.is_set() or time.monotonic()>=deadline:raise TimeoutError('cancelled_or_deadline')
                end=buffer.find(b'\n')
                if end>=0:
                    result=json.loads(bytes(buffer[:end]))
                    if result.get('id')!=ident:raise RuntimeError('response_order')
                    if not result.get('ok'):raise RuntimeError(result.get('error_code','unavailable'))
                    return result
                if len(buffer)>=1280*1024:raise ValueError('response_limit')
                connection.settimeout(min(.1,max(.001,deadline-time.monotonic())))
                try:part=connection.recv(min(65536,1280*1024-len(buffer)))
                except socket.timeout:continue
                if not part:raise ConnectionError('bridge_unavailable')
                buffer.extend(part)

class BridgeLanguageModel:
    def __init__(self,path):self.ipc=IPC(path);self.last_metrics=None
    def generate(self,user_text,*,cancel,deadline,web_evidence=None):
        # Voice's network evidence is already handled by finite skills. Never
        # reinterpret remote snippets as typed actions through this proxy.
        result=self.ipc.request('chat',cancel,deadline,text=user_text)
        self.last_metrics=result.get('metrics');return LanguageReply(result.get('text','')[:120],None)
    def clear_history(self):
        try:self.ipc.request('clear_history',deadline=time.monotonic()+1.5)
        except (OSError,RuntimeError,TimeoutError):pass
    def close(self):self.clear_history()

class BridgeTTS:
    def __init__(self,path,fixed_cache_root=None):self.ipc=IPC(path);self.fixed=FixedCache(fixed_cache_root) if fixed_cache_root else None
    def synthesize(self,text,cancel):
        try:result=self.ipc.request('tts',cancel,time.monotonic()+30,text=text)
        except OSError as error:
            if error.errno in (errno.ENOENT,errno.ECONNREFUSED) and self.fixed and text in self.fixed.audio and not cancel.is_set():return self.fixed.audio[text]
            raise
        data=base64.b64decode(result['audio_wav_base64'],validate=True)
        if len(data)>640044:raise ValueError('audio_limit')
        with wave.open(io.BytesIO(data),'rb') as audio:
            if (audio.getnchannels(),audio.getsampwidth(),audio.getframerate())!=(1,2,16000):raise ValueError('audio_format')
            return AudioClip(audio.readframes(audio.getnframes()),16000)
    def close(self):pass

class VoiceASRLease:
    def __init__(self,path):self.ipc=IPC(path);self.local=threading.local()
    def begin(self):
        token=uuid.uuid4().hex
        try:self.ipc.request('begin_voice_asr',deadline=time.monotonic()+2,lease_id=token,ttl_ms=20000)
        except OSError as error:
            if error.errno in (errno.ENOENT,errno.ECONNREFUSED):self.local.token=None;return
            raise
        self.local.token=token
    def end(self):
        token=getattr(self.local,'token',None)
        if token:
            try:self.ipc.request('end_voice_asr',deadline=time.monotonic()+1,lease_id=token)
            except (OSError,RuntimeError,TimeoutError):pass
            self.local.token=None

class FixedCache:
    """Only qualified readonly fixed PCM; no Piper/model fallback is loaded."""
    PHRASES=('我在，请说。','好的，唤醒词已经更新。','好的，保持原来的唤醒词。','请说确认，或者取消。',
             '音量已设为百分之0。','音量已设为百分之100。','音量已设为百分之50。','我还没听清，请再说一遍。','好的。','请稍等。')
    def __init__(self,root):
        self.audio={};root=Path(root)
        manifest=root/'manifest.json';info=manifest.lstat()
        if not stat.S_ISREG(info.st_mode) or manifest.is_symlink() or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>32768:raise ValueError('fixed_cache_manifest')
        data=json.loads(manifest.read_text(encoding='utf8'));total=0
        if data.get('schema')!=1 or data.get('engine')!='piper' or data.get('model_sha256')!='d30b143fac66d821a1285aa013295adf5cd129d3cc11d70334e51c7b20662c37':raise ValueError('fixed_cache_provenance')
        for phrase,row in data.get('phrases',{}).items():
            if phrase not in self.PHRASES or row.get('file')!='phrase-%02d.pcm'%self.PHRASES.index(phrase):raise ValueError('fixed_cache_phrase')
            path=root/row['file'];info=path.lstat();size=row.get('bytes')
            if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_uid!=0 or info.st_mode&0o022 or type(size) is not int or size!=info.st_size or not 0<size<=640000 or size%2 or row.get('sample_rate')!=16000:raise ValueError('fixed_cache_pcm')
            total+=size
            if total>1024*1024:raise ValueError('fixed_cache_limit')
            pcm=path.read_bytes()
            if hashlib.sha256(pcm).hexdigest()!=row.get('sha256'):raise ValueError('fixed_cache_hash')
            self.audio[phrase]=AudioClip(pcm,16000)

class Availability:
    def __init__(self,path):self.ipc=IPC(path);self.snapshot={'ready':False,'error_code':'unchecked'}
    def check(self):
        try:self.snapshot=self.ipc.request('status',deadline=time.monotonic()+.4)
        except (OSError,RuntimeError,TimeoutError):self.snapshot={'ready':False,'error_code':'unavailable'}
        return self.snapshot
