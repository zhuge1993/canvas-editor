"""Resident local Qwen worker adapter. Never executes a model-suggested action."""
import importlib.util
import hashlib
import atexit
import collections
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
MODEL_SHA256='7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed'
MODEL_BYTES=428730208
LINE_LIMIT=16384


class LocalLanguageModel:
    def __init__(self,binary,model,*,threads=2,load_timeout=45):
        if threads not in (1,2,3,4) or not 1<=load_timeout<=90:raise ValueError('invalid LLM limits')
        self.binary=self._trusted(binary,8*1024*1024);self.model=self._trusted(model,MODEL_BYTES)
        if self.model.stat().st_size!=MODEL_BYTES:raise ValueError('wrong qualified model size')
        model_hash=hashlib.sha256()
        with self.model.open('rb') as model_stream:
            for block in iter(lambda:model_stream.read(1024*1024),b''):model_hash.update(block)
        if model_hash.hexdigest()!=MODEL_SHA256:raise ValueError('qualified model SHA256 mismatch')
        self._serial=0;self._lock=threading.Lock();self._write_lock=threading.Lock()
        self._history=collections.deque(maxlen=2);self._history_lock=threading.Lock();self._history_epoch=0
        self._responses=queue.Queue(maxsize=128);self._fault=threading.Event()
        self._stderr=bytearray();self._stderr_lock=threading.Lock();self.last_metrics=None
        launcher=self._trusted('/opt/dior-android/run-native.py',65536)
        spec=importlib.util.spec_from_file_location('dior_readonly_llm_transport',launcher)
        transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
        _unused_gpu_probe,private_env,fd=transport.runtime_environment('opencl',[])
        env={key:private_env[key] for key in ('LD_LIBRARY_PATH','ANDROID_PROPERTY_WORKSPACE')}
        env.update(PATH='/usr/bin:/bin',LANG='C.UTF-8')
        parent_pid=os.getpid()
        def limits():
            import resource
            import ctypes
            resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(1024*1024*1024,)*2)
            resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
            # Linux3.4 supports PR_SET_PDEATHSIG. This also covers a supervisor
            # killing the parent during cold model loading, before core startup.
            libc=ctypes.CDLL(None,use_errno=True)
            if libc.prctl(1,signal.SIGTERM,0,0,0)!=0:raise OSError(ctypes.get_errno(),'LLM parent-death signal failed')
            if os.getppid()!=parent_pid:os.kill(os.getpid(),signal.SIGTERM)
        try:
            self.process=subprocess.Popen([str(self.binary),str(self.model),str(threads)],stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,stderr=subprocess.PIPE,pass_fds=(fd,),close_fds=True,
                env=env,start_new_session=True,preexec_fn=limits,bufsize=0)
        finally:os.close(fd)
        atexit.register(self.close)
        threading.Thread(target=self._read_stdout,daemon=True).start();threading.Thread(target=self._read_stderr,daemon=True).start()
        try:
            self.ready=self._receive(time.monotonic()+load_timeout)
            if self.ready.get('type')!='ready' or self.ready.get('gpu_used') is not False:raise RuntimeError('invalid CPU LLM readiness')
        except BaseException:self.close();raise

    @staticmethod
    def _trusted(value,budget):
        path=Path(value);info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or not 0<info.st_size<=budget:
            raise ValueError('LLM paths must be qualified root-owned immutable regular files')
        return path.resolve(strict=True)

    def _read_stdout(self):
        try:
            while True:
                line=self.process.stdout.readline(LINE_LIMIT+1)
                if not line:break
                if len(line)>LINE_LIMIT or not line.endswith(b'\n'):raise RuntimeError('LLM stdout limit')
                value=json.loads(line)
                if not isinstance(value,dict):raise RuntimeError('LLM output must be an object')
                self._responses.put_nowait(value)
        except Exception:self._fault.set()
        finally:self._fault.set()

    def _read_stderr(self):
        try:
            while True:
                block=self.process.stderr.read(1024)
                if not block:return
                with self._stderr_lock:
                    self._stderr.extend(block)
                    if len(self._stderr)>16384:del self._stderr[:-16384]
        except (OSError,ValueError):pass

    def _send(self,value):
        line=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8')
        if len(line)>LINE_LIMIT:raise ValueError('LLM request limit')
        with self._write_lock:
            at=0
            while at<len(line):
                count=self.process.stdin.write(line[at:])
                if not count:raise RuntimeError('LLM pipe closed')
                at+=count
            self.process.stdin.flush()

    def _receive(self,deadline):
        while time.monotonic()<deadline:
            try:return self._responses.get(timeout=min(.05,max(.001,deadline-time.monotonic())))
            except queue.Empty:
                if self._fault.is_set():raise RuntimeError('LLM worker unavailable')
        raise TimeoutError('local LLM deadline')

    def clear_history(self):
        """Forget short in-memory excerpts immediately, including in-flight saves."""
        with self._history_lock:
            self._history.clear();self._history_epoch+=1

    def _conversation_input(self,user_text):
        with self._history_lock:
            excerpts=list(self._history);epoch=self._history_epoch
        while excerpts:
            context='前文：\n'+''.join('问：'+q+'\n答：'+a+'\n' for q,a in excerpts)+'现在：'+user_text
            if len(context.encode('utf8'))<=768:return context,epoch,len(excerpts)
            excerpts.pop(0)
        return user_text,epoch,0

    def generate(self,user_text,*,cancel,deadline,web_evidence=None):
        from interfaces import LanguageReply
        if not isinstance(user_text,str) or not user_text.strip() or len(user_text.encode('utf8'))>768:
            raise ValueError('bounded nonempty user text required')
        with self._lock:
            if cancel.is_set() or deadline<=time.monotonic():return LanguageReply('',None)
            self._serial+=1;ident='llm_'+str(self._serial)
            bounded_input,history_epoch,history_count=self._conversation_input(user_text)
            request={'op':'generate','id':ident,'text':bounded_input,'max_tokens':24,
                     'deadline_ms':max(100,min(30000,int((deadline-time.monotonic())*1000)))}
            if web_evidence is not None:
                request['web_evidence']={key:str(web_evidence.get(key,''))[:300] for key in ('title','excerpt','source_url')}
            self._send(request);done=None;abort_sent=False;cancel_until=None
            while True:
                stopped=cancel.is_set() or time.monotonic()>=deadline
                if stopped and not abort_sent:
                    self._send({'op':'cancel','id':ident});abort_sent=True;cancel_until=time.monotonic()+2
                if abort_sent and time.monotonic()>=cancel_until:
                    self.close();return LanguageReply('',None)
                try:value=self._receive(min(deadline,time.monotonic()+.1) if not abort_sent else min(cancel_until,time.monotonic()+.1))
                except TimeoutError:continue
                if value.get('type')=='error':raise RuntimeError('LLM request rejected')
                if value.get('id')!=ident:continue
                if value.get('type')=='done':
                    if value.get('status')=='prompt_context_limit' and history_count and not cancel.is_set() and deadline-time.monotonic()>.2:
                        # Token count depends on language/content. If the native
                        # tokenizer rejects a composed prompt, retry once with
                        # the current question and no old excerpts.
                        self._serial+=1;ident='llm_'+str(self._serial);history_count=0
                        request.update(id=ident,text=user_text,deadline_ms=max(100,min(30000,int((deadline-time.monotonic())*1000))))
                        self._send(request);continue
                    done=value;break
            self.last_metrics=done
            self.last_metrics['history_excerpt_turns']=history_count
            if cancel.is_set() or abort_sent or done.get('status')!='complete':return LanguageReply('',None)
            # Never turn model text or web evidence into TypedIntent, shell,
            # volume changes or wake-word writes. Core owns all rule skills.
            text=done.get('text','')
            if not isinstance(text,str):raise RuntimeError('invalid LLM text')
            text=text.strip()[:120]
            if text:
                with self._history_lock:
                    if history_epoch==self._history_epoch:self._history.append((user_text[:24],text[:24]))
            return LanguageReply(text,None)

    def close(self):
        atexit.unregister(self.close)
        process=getattr(self,'process',None)
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
