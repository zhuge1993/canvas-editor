"""Separate GNU/ORT KWS process; never load its libraries into musl Python."""
import atexit
import ctypes
import hashlib
import json
import os
from pathlib import Path
import queue
import signal
import stat
import subprocess
import threading
import time
from compile_keywords import compile_keyword

WORKER_SHA256='74cbb47f56ab1e46bd391388932e17614814203258735324689774ff5021ecf8'
RUNTIME_HASHES={'libsherpa-onnx-c-api.so':'d6cf63255fa2fee929bde2d50ac508fb5832ced08fc2285be95cdcf63cc35471',
                'libonnxruntime.so':'9725dc78a0c5cacd873148f7bee14a63aac8ec87a62830354dba443148fa150c'}
LINE_LIMIT=16384

class LocalKeywordSpotter:
    def __init__(self,base,tts_base,*,keyword='二狗',threads=2,score=1.5,threshold=.35,load_timeout=30):
        if threads not in (1,2):raise ValueError('KWS threads must be1 or2')
        self.base=Path(base).resolve(strict=True);self.tts_base=Path(tts_base).resolve(strict=True)
        self.score=score;self.threshold=threshold;self._lock=threading.Lock();self._serial=0
        self._responses=queue.Queue(maxsize=8);self._fault=threading.Event();self._stderr=bytearray()
        self.keyword=keyword;compiled=self.validate_keyword(keyword)
        worker=self._trusted(self.base/'native/kws-worker',65536)
        if hashlib.sha256(worker.read_bytes()).hexdigest()!=WORKER_SHA256:raise ValueError('Qualified KWS worker hash mismatch')
        for name,digest in RUNTIME_HASHES.items():
            library=self._trusted(self.base/'runtime/lib'/name,32*1024*1024)
            if hashlib.sha256(library.read_bytes()).hexdigest()!=digest:raise ValueError('Paired KWS runtime qualification mismatch')
        manifest_path=self._trusted(self.base/'model-small/MANIFEST.json',16384)
        manifest=json.loads(manifest_path.read_text(encoding='utf8'))
        for item in manifest['files']:
            p=self._trusted(self.base/'model-small'/item['path'],16*1024*1024)
            if p.stat().st_size!=item['bytes'] or hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('KWS model qualification mismatch')
        libraries=self.tts_base/'private-glibc/lib';loader=self._trusted(libraries/'ld-linux-armhf.so.3',2*1024*1024,allow_symlink=True)
        command=[str(loader),'--library-path',str(self.base/'runtime/lib')+':'+str(libraries),str(worker),
          '--encoder',str(self.base/'model-small/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          '--decoder',str(self.base/'model-small/decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
          '--joiner',str(self.base/'model-small/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
          '--tokens',str(self.base/'model-small/tokens.txt'),'--keywords',compiled,'--threads',str(threads)]
        parent_pid=os.getpid()
        def limits():
            import resource
            resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,)*2)
            resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
            libc=ctypes.CDLL(None,use_errno=True)
            if libc.prctl(1,signal.SIGTERM,0,0,0):raise OSError(ctypes.get_errno(),'KWS PDEATHSIG')
            if os.getppid()!=parent_pid:os.kill(os.getpid(),signal.SIGTERM)
        self.process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
            env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},preexec_fn=limits,start_new_session=True,bufsize=0)
        atexit.register(self.close)
        threading.Thread(target=self._stdout,daemon=True).start();threading.Thread(target=self._stderr_reader,daemon=True).start()
        try:
            self.ready=self._receive(time.monotonic()+load_timeout)
            if self.ready.get('op')!='ready' or not self.ready.get('ok'):raise RuntimeError('KWS model/stream not ready')
        except BaseException:self.close();raise

    @staticmethod
    def _trusted(path,limit,allow_symlink=False):
        path=Path(path)
        if allow_symlink:path=path.resolve(strict=True)
        info=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or not 0<info.st_size<=limit:raise ValueError('Expected immutable root-owned qualified file: '+path.name)
        return path.resolve(strict=True)

    def validate_keyword(self,keyword):
        return compile_keyword(keyword,self.base/'model-small/tokens.txt',score=self.score,threshold=self.threshold)

    def _stdout(self):
        try:
            while True:
                line=self.process.stdout.readline(LINE_LIMIT+1)
                if not line:break
                if len(line)>LINE_LIMIT or not line.endswith(b'\n'):raise RuntimeError('KWS output limit')
                response=json.loads(line)
                if not isinstance(response,dict):raise RuntimeError('KWS output object required')
                self._responses.put_nowait(response)
        except Exception:self._fault.set()
        finally:self._fault.set()

    def _stderr_reader(self):
        try:
            while True:
                data=self.process.stderr.read(1024)
                if not data:return
                self._stderr.extend(data)
                if len(self._stderr)>16384:del self._stderr[:-16384]
        except (OSError,ValueError):pass

    def _receive(self,deadline):
        while time.monotonic()<deadline:
            try:return self._responses.get(timeout=min(.05,max(.001,deadline-time.monotonic())))
            except queue.Empty:
                if self._fault.is_set():raise RuntimeError('KWS worker exited')
        raise TimeoutError('KWS bounded RPC timeout')

    def _rpc_locked(self,op,**data):
        self._serial=(self._serial%2147483647)+1;request={'op':op,'id':self._serial,**data}
        encoded=(json.dumps(request,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8')
        if len(encoded)>LINE_LIMIT:raise ValueError('KWS request bound')
        at=0
        while at<len(encoded):
            n=self.process.stdin.write(encoded[at:])
            if not n:raise RuntimeError('KWS pipe closed')
            at+=n
        self.process.stdin.flush()
        try:response=self._receive(time.monotonic()+5)
        except Exception:self.close();raise
        if response.get('id')!=self._serial:raise RuntimeError('KWS response order')
        if not response.get('ok'):raise ValueError('KWS request rejected: '+str(response.get('error')))
        return response

    def feed(self,pcm16):
        """Call from a bounded recognition consumer, never a PCM I/O callback."""
        if not isinstance(pcm16,bytes) or len(pcm16)!=640:raise ValueError('Exactly20ms PCM16mono16k required')
        with self._lock:
            response=self._rpc_locked('feed',pcm16_hex=pcm16.hex())
            response['native_raw_keyword']=response.get('keyword','')
            response['filtered_noncurrent_keyword']=bool(response['native_raw_keyword'] and response['native_raw_keyword']!=self.keyword)
            if response.get('keyword')!=self.keyword:response['keyword']=''
            return response

    def set_keyword(self,keyword):
        compiled=self.validate_keyword(keyword)
        with self._lock:
            result=self._rpc_locked('set_keywords',keywords_string=compiled)
            self.keyword=keyword
            return result

    def reset(self):
        with self._lock:return self._rpc_locked('reset')

    def ping(self):
        with self._lock:return self._rpc_locked('ping')

    def status(self):
        return {'alive':self.process.poll() is None,'worker_pid':self.process.pid,'keyword':self.keyword,
                'gpu_used':False,'model_load_count':1,'ready':dict(self.ready),
                'stderr_retained_bytes':len(self._stderr),'stderr_limit_bytes':16384}

    def close(self):
        atexit.unregister(self.close);p=getattr(self,'process',None)
        if p is None:return
        if p.poll() is None:
            try:os.killpg(p.pid,signal.SIGTERM)
            except ProcessLookupError:pass
            try:p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                try:os.killpg(p.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                p.wait(timeout=2)
        for stream in (p.stdin,p.stdout,p.stderr):
            try:stream.close()
            except (OSError,ValueError):pass
