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

class BridgeResponseError(RuntimeError):
    """A bounded error code received from the private bridge, not local failure."""
    def __init__(self,code):
        self.code=code if isinstance(code,str) and re.fullmatch(r'[a-z_]{1,48}',code) else 'invalid_remote_error'
        super().__init__(self.code)

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
                    if not result.get('ok'):raise BridgeResponseError(result.get('error_code','unavailable'))
                    return result
                if len(buffer)>=1280*1024:raise ValueError('response_limit')
                connection.settimeout(min(.1,max(.001,deadline-time.monotonic())))
                try:part=connection.recv(min(65536,1280*1024-len(buffer)))
                except socket.timeout:continue
                if not part:raise ConnectionError('bridge_unavailable')
                buffer.extend(part)

class BridgeLanguageModel:
    def __init__(self,path):self.ipc=IPC(path);self.last_metrics=None;self.mode='unknown'
    def generate(self,user_text,*,cancel,deadline,web_evidence=None):
        # Voice's network evidence is already handled by finite skills. Never
        # reinterpret remote snippets as typed actions through this proxy.
        self.mode='legacy_current_turn'
        result=self.ipc.request('chat',cancel,deadline,text=user_text)
        self.last_metrics=result.get('metrics');return LanguageReply(result.get('text','')[:120],None)
    def generate_messages(self,messages,*,cancel,deadline):
        if not isinstance(messages,list) or not messages or not isinstance(messages[-1],dict):raise ValueError('messages_required')
        last=messages[-1]
        if last.get('role')!='user' or not isinstance(last.get('content'),str) or not last['content'].strip():raise ValueError('last_user_required')
        # Probe each turn: an absent/cold service or a legacy capability must
        # not pin the client to that mode after a service upgrade/restart.
        self.mode='unknown'
        try:status=self.ipc.request('status',cancel,min(deadline,time.monotonic()+.75))
        except Exception:self.mode='unavailable';raise
        capabilities=status.get('capabilities')
        supported=capabilities.get('chat_messages') if isinstance(capabilities,dict) else None
        if supported is False:return self._legacy_current_turn(last['content'],cancel,deadline)
        if supported is True:self.mode='structured_history'
        try:result=self.ipc.request('chat',cancel,deadline,messages=messages)
        except BridgeResponseError as error:
            if error.code!='messages_unsupported':raise
            return self._legacy_current_turn(last['content'],cancel,deadline)
        self.mode='structured_history'
        self.last_metrics=result.get('metrics');return LanguageReply(result.get('text','')[:120],None)
    def _legacy_current_turn(self,text,cancel,deadline):
        self.mode='legacy_current_turn'
        # The old bridge may own a tiny generation-time history. Clear that
        # history before the legacy request; only the current user is sent.
        # A failed clear is an error, never permission to reuse stale answers.
        self.ipc.request('clear_history',cancel,min(deadline,time.monotonic()+1.5))
        return self.generate(text,cancel=cancel,deadline=deadline)
    def prepare_system(self,system,*,cancel,deadline):
        if not isinstance(system,str) or not system.strip() or len(system.encode('utf8'))>4096:raise ValueError('prepare_system_limit')
        if any(ord(char)<32 and char not in ('\n','\t') for char in system) or any(marker in system for marker in ('<|im_start|>','<|im_end|>','<think>','</think>')):raise ValueError('prepare_system_content')
        deadline=min(deadline,time.monotonic()+20)
        status=self.ipc.request('status',cancel,min(deadline,time.monotonic()+.75))
        capabilities=status.get('capabilities')
        if not isinstance(capabilities,dict) or capabilities.get('prepare_system') is not True:
            raise BridgeResponseError('prepare_system_unsupported')
        result=self.ipc.request('prepare_system',cancel,deadline,system=system)
        count=result.get('prefix_tokens');generated=result.get('generated_tokens')
        if result.get('status')!='complete' or result.get('initialized') is not True or type(count) is not int or not 1<=count<=512 or type(generated) is not int or generated!=0 or type(result.get('cache_hit')) is not bool:
            raise RuntimeError('invalid_prepare_ack')
        return {key:result[key] for key in ('status','initialized','prefix_tokens','generated_tokens','cache_hit')}
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
    def synthesize_failure(self,cancel):
        # This exact recovery phrase is already root-owned/hash-verified by
        # FixedCache. Never wait for a busy/failed model service to say it.
        return self.synthesize_notice('这次没有及时回答，请再问一次。',cancel)
    def synthesize_notice(self,text,cancel):
        if text not in ('我还没听清，请再说一遍。','这次没有及时回答，请再问一次。'):raise ValueError('notice_phrase_forbidden')
        if cancel.is_set():raise TimeoutError('cancelled')
        if self.fixed is None or text not in self.fixed.audio:raise RuntimeError('failure_cache_unavailable')
        return self.fixed.audio[text]
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
             '音量已设为百分之0。','音量已设为百分之100。','音量已设为百分之50。','我还没听清，请再说一遍。','好的。','请稍等。',
             '这次没有及时回答，请再问一次。')
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
