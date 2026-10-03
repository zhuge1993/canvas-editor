"""One resident Qwen3.5 candidate; explicit conversations, no internal history."""
import atexit
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import signal
import stat
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode=True
MODEL_SHA256='57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf'
MODEL_BYTES=563036064
LINE_LIMIT=16384
MARKERS=('<|im_start|>','<|im_end|>','<think>','</think>')

def validate_messages(messages):
    if not isinstance(messages,list) or not 1<=len(messages)<=12:raise ValueError('messages_limit')
    count=0;expected='user'
    for index,message in enumerate(messages):
        if not isinstance(message,dict) or set(message)!={'role','content'}:raise ValueError('message_fields')
        role=message['role'];content=message['content']
        if not isinstance(content,str) or not content.strip():raise ValueError('empty_message')
        size=len(content.encode('utf8'));count+=size
        if size>4096 or count>8192 or any(marker in content for marker in MARKERS):raise ValueError('message_content')
        if role=='system' and index==0:continue
        if role!=expected:raise ValueError('message_order')
        expected='assistant' if expected=='user' else 'user'
    if expected!='assistant':raise ValueError('last_role_must_be_user')
    return [dict(message) for message in messages]

def speech_text(text):
    if not isinstance(text,str):raise RuntimeError('invalid_model_text')
    text=text.strip()
    if len(text)<=120:return text
    bounded=text[:120]
    stop=max(bounded.rfind(char) for char in '。！？!?\n')
    return bounded[:stop+1] if stop>=12 else bounded

class LocalLanguageModel:
    explicit_messages=True
    def __init__(self,binary,model,*,threads=3,load_timeout=90):
        if type(threads) is not int or threads not in (1,2,3,4) or not 1<=load_timeout<=120:raise ValueError('limits')
        self.binary=self._trusted(binary,12*1024*1024);self.model=self._trusted(model,MODEL_BYTES)
        if self.model.stat().st_size!=MODEL_BYTES:raise ValueError('model_size')
        digest=hashlib.sha256()
        with self.model.open('rb') as stream:
            for block in iter(lambda:stream.read(1048576),b''):digest.update(block)
        if digest.hexdigest()!=MODEL_SHA256:raise ValueError('model_hash')
        self._serial=0;self._lock=threading.Lock();self._write_lock=threading.Lock()
        self._responses=queue.Queue(maxsize=256);self._fault=threading.Event();self.last_metrics=None
        self._stderr=bytearray();self._stderr_lock=threading.Lock()
        launcher=self._trusted('/opt/dior-android/run-native.py',65536)
        spec=importlib.util.spec_from_file_location('dior_qwen35_transport',launcher)
        transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
        unused,private,fd=transport.runtime_environment('opencl',[])
        env={key:private[key] for key in ('LD_LIBRARY_PATH','ANDROID_PROPERTY_WORKSPACE')}
        env.update(PATH='/usr/bin:/bin',LANG='C.UTF-8');parent=os.getpid()
        def limits():
            import resource
            resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(1400*1024*1024,)*2)
            resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
            libc=ctypes.CDLL(None,use_errno=True)
            if libc.prctl(1,signal.SIGTERM,0,0,0)!=0:raise OSError(ctypes.get_errno(),'parent_death_signal')
            if os.getppid()!=parent:os.kill(os.getpid(),signal.SIGTERM)
        try:
            self.process=subprocess.Popen([str(self.binary),str(self.model),str(threads)],stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(fd,),env=env,start_new_session=True,
                preexec_fn=limits,bufsize=0)
        finally:os.close(fd)
        atexit.register(self.close)
        threading.Thread(target=self._read_stdout,daemon=True).start();threading.Thread(target=self._read_stderr,daemon=True).start()
        try:
            self.ready=self._receive(time.monotonic()+load_timeout)
            if self.ready.get('type')!='ready' or self.ready.get('gpu_used') is not False or self.ready.get('context_tokens')!=1024:
                raise RuntimeError('invalid_model_readiness')
            self.ready['model_id']='Qwen3.5-0.8B-Q4_0'
        except BaseException:self.close();raise

    @staticmethod
    def _trusted(value,budget):
        path=Path(value);info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or not 0<info.st_size<=budget:
            raise ValueError('untrusted_model_artifact')
        return path.resolve(strict=True)

    def _read_stdout(self):
        try:
            while True:
                line=self.process.stdout.readline(LINE_LIMIT+1)
                if not line:break
                if len(line)>LINE_LIMIT or not line.endswith(b'\n'):raise RuntimeError('native_frame_limit')
                value=json.loads(line)
                if not isinstance(value,dict):raise RuntimeError('native_object_required')
                self._responses.put_nowait(value)
        except Exception:self._fault.set()
        finally:self._fault.set()

    def _read_stderr(self):
        try:
            for block in iter(lambda:self.process.stderr.read(1024),b''):
                with self._stderr_lock:
                    self._stderr.extend(block)
                    if len(self._stderr)>16384:del self._stderr[:-16384]
        except (OSError,ValueError):pass

    def _send(self,value):
        line=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(line)>LINE_LIMIT:raise ValueError('native_request_limit')
        with self._write_lock:
            offset=0
            while offset<len(line):
                written=self.process.stdin.write(line[offset:])
                if not written:raise RuntimeError('native_pipe_closed')
                offset+=written
            self.process.stdin.flush()

    def _receive(self,deadline):
        while time.monotonic()<deadline:
            try:return self._responses.get(timeout=min(.05,max(.001,deadline-time.monotonic())))
            except queue.Empty:
                if self._fault.is_set():raise RuntimeError('native_unavailable')
        raise TimeoutError('model_deadline')

    def generate(self,user_text,*,cancel,deadline,web_evidence=None):
        # Website requests stay stateless; their already authorized project
        # facts are supplied as user data by the bridge, not persisted here.
        messages=[{'role':'system','content':'你是FlowBoard网站的中文助手。用一两句简短中文准确回答，只依据给定资料，不编造数据或已经执行的操作。'},
                  {'role':'user','content':user_text}]
        return self.generate_messages(messages,cancel=cancel,deadline=deadline,use_prefix_cache=False)

    def generate_messages(self,messages,*,cancel,deadline,web_evidence=None,use_prefix_cache=True):
        from interfaces import LanguageReply
        messages=validate_messages(messages)
        with self._lock:
            if cancel.is_set() or deadline<=time.monotonic():return LanguageReply('',None)
            self._serial+=1;ident='qwen35_'+str(self._serial)
            self._send({'op':'generate','id':ident,'messages':messages,'max_tokens':96,
                        'use_prefix_cache':bool(use_prefix_cache),
                        'deadline_ms':max(100,min(30000,int((deadline-time.monotonic())*1000)))})
            abort_until=None
            while True:
                if (cancel.is_set() or time.monotonic()>=deadline) and abort_until is None:
                    self._send({'op':'cancel','id':ident});abort_until=time.monotonic()+2
                if abort_until is not None and time.monotonic()>=abort_until:
                    self.close();return LanguageReply('',None)
                try:value=self._receive(min(abort_until or deadline,time.monotonic()+.1))
                except TimeoutError:continue
                if value.get('type')=='error':raise RuntimeError('native_request_rejected')
                if value.get('id')!=ident or value.get('type')!='done':continue
                self.last_metrics=value
                if cancel.is_set() or abort_until is not None or value.get('status')!='complete':return LanguageReply('',None)
                return LanguageReply(speech_text(value.get('text')),None)

    def clear_history(self):
        # Only the bridge's single scheduler invokes this. A context close also
        # releases bounded native mathematical checkpoints containing old turns.
        with self._lock:
            self._serial+=1;ident='clear_'+str(self._serial)
            self._send({'op':'clear_cache','id':ident})
            deadline=time.monotonic()+3
            while True:
                result=self._receive(deadline)
                if result.get('type')=='error':raise RuntimeError('native_cache_clear_rejected')
                if result.get('id')==ident and result.get('type')=='cache_cleared':return

    def close(self):
        atexit.unregister(self.close);process=getattr(self,'process',None)
        if process is None:return
        if process.poll() is None:
            try:os.killpg(process.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.wait(timeout=2)
        for stream in (process.stdin,process.stdout,process.stderr):
            try:stream.close()
            except (OSError,ValueError):pass
