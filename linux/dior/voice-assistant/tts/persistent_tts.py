"""Lazy local persistent Piper using the qualified unmodified voice/assets.

One serial child reuses the existing OfflineTTS command/assets/child guards.
Linux3.4 uses one unlinked tmpfs TemporaryFile, not memfd/O_TMPFILE or disk.
"""
import atexit
import collections
import io
import json
import math
import os
from pathlib import Path
import queue
import re
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

class PersistentTTSError(RuntimeError):pass
class PersistentTTSCancelled(PersistentTTSError):pass

def validate_max_cpus(max_cpus):
    if max_cpus is not None and (type(max_cpus) is not int or not 1<=max_cpus<=2):
        raise ValueError('piper_max_cpus_must_be_none_or_1_to_2')

def select_child_cpus(max_cpus):
    """Snapshot inherited permissions in the parent; never change its affinity."""
    validate_max_cpus(max_cpus)
    if max_cpus is None:return None
    if not callable(getattr(os,'sched_getaffinity',None)) or not callable(getattr(os,'sched_setaffinity',None)):
        raise PersistentTTSError('piper_cpu_affinity_unavailable')
    allowed=os.sched_getaffinity(0)
    if not allowed or len(allowed)>4096 or any(type(cpu) is not int or cpu<0 for cpu in allowed):
        raise PersistentTTSError('piper_inherited_cpu_set_invalid')
    return tuple(sorted(allowed)[:max_cpus])

def persistent_child_setup(module,expected_parent,max_bytes,child_cpus,affinity_setter):
    """Only child kernel operations; all CPU selection happened before fork."""
    module._unix_child_setup(expected_parent)
    resource=module._RESOURCE
    _soft,hard=resource.getrlimit(resource.RLIMIT_FSIZE)
    cap=max_bytes if hard==resource.RLIM_INFINITY else min(max_bytes,hard)
    resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap))
    if child_cpus is not None:affinity_setter(0,child_cpus)

def piper_task_ids(process):
    """Enumerate only the live child owned by this session, never global tasks."""
    if process.poll() is not None:raise PersistentTTSError('piper_affinity_child_exited')
    if type(process.pid) is not int or process.pid<=0:raise PersistentTTSError('piper_affinity_pid_invalid')
    root=Path('/proc')/str(process.pid)/'task'
    if root.stat().st_uid!=os.geteuid():raise PersistentTTSError('piper_affinity_child_owner_changed')
    tasks=[]
    for entry in root.iterdir():
        if not entry.name.isdigit():raise PersistentTTSError('piper_affinity_task_invalid')
        tasks.append(int(entry.name))
        if len(tasks)>64:raise PersistentTTSError('piper_affinity_task_limit')
    if not tasks or process.pid not in tasks:raise PersistentTTSError('piper_affinity_task_set_invalid')
    return tuple(sorted(tasks))

def enforce_piper_threads(process,child_cpus,cancel,deadline):
    """Post-ORT-init barrier: stable own-child task masks before any text input."""
    if child_cpus is None:return {'verified':False,'thread_count':0,'rounds':0}
    target=set(child_cpus);expires=min(deadline,time.monotonic()+.5);previous=None
    def guard():
        if cancel.is_set():raise PersistentTTSCancelled('cancelled_during_affinity_enforcement')
        if time.monotonic()>=expires:raise PersistentTTSError('piper_affinity_deadline')
        if process.poll() is not None:raise PersistentTTSError('piper_affinity_child_exited')
    for index in range(3):
        guard();tasks=piper_task_ids(process);valid=True
        for tid in tasks:
            guard()
            try:
                current=os.sched_getaffinity(tid)
                if current!=target:os.sched_setaffinity(tid,child_cpus)
                actual=os.sched_getaffinity(tid)
                if not actual or not actual<=target:raise PersistentTTSError('piper_affinity_thread_verification_failed')
            except ProcessLookupError:
                valid=False;break
        guard()
        after=piper_task_ids(process)
        if valid and after==tasks and previous==tasks:
            return {'verified':True,'thread_count':len(tasks),'rounds':index+1}
        previous=tasks if valid and after==tasks else None
        if cancel.wait(.005):raise PersistentTTSCancelled('cancelled_during_affinity_enforcement')
    raise PersistentTTSError('piper_affinity_tasks_not_stable')

def cumulative_inference_metrics(values,index):
    """Piper SynthesisResult is reused across lines: its stderr times accumulate."""
    current=next((value for value in values if value[0]==index),None)
    previous=(0,0.,0.,0.) if index==1 else next((value for value in values if value[0]==index-1),None)
    def number(value):return type(value) in (int,float) and math.isfinite(value) and 0<=value<=10**9
    infer=current[1] if current and number(current[1]) else None
    audio=current[2] if current and number(current[2]) else None
    factor=current[3] if current and number(current[3]) else None
    infer_delta=audio_delta=None
    if current and previous:
        if number(current[1]) and number(previous[1]) and current[1]>=previous[1]:infer_delta=current[1]-previous[1]
        if number(current[2]) and number(previous[2]) and current[2]>=previous[2]:audio_delta=current[2]-previous[2]
    return {'onnx_infer_cumulative_seconds_reported':infer,'onnx_audio_cumulative_seconds_reported':audio,
            'onnx_cumulative_real_time_factor_reported':factor,
            'onnx_infer_seconds_delta':infer_delta,'onnx_audio_seconds_delta':audio_delta,
            'onnx_delta_from_adjacent_reported_counters':infer_delta is not None}

def read_complete_wav(file,max_bytes,rate=16000):
    """Return PCM only when the complete bounded WAV is flushed; None if short."""
    file.seek(0,os.SEEK_END);available=file.tell();file.seek(0)
    if available>max_bytes:raise PersistentTTSError('wav_size_limit')
    if available<12:return None
    header=file.read(12)
    if header[:4]!=b'RIFF' or header[8:12]!=b'WAVE':raise PersistentTTSError('wav_header_invalid')
    expected=struct.unpack('<I',header[4:8])[0]+8
    if expected<44 or expected>max_bytes:raise PersistentTTSError('wav_declared_size_limit')
    if available<expected:return None
    if available!=expected:raise PersistentTTSError('wav_trailing_bytes')
    file.seek(0);raw=file.read(expected)
    if len(raw)!=expected:return None
    try:
        with wave.open(io.BytesIO(raw),'rb') as wav:
            if (wav.getnchannels(),wav.getsampwidth(),wav.getframerate())!=(1,2,rate):raise PersistentTTSError('wav_format_invalid')
            frames=wav.getnframes();pcm=wav.readframes(frames)
    except (wave.Error,EOFError) as error:raise PersistentTTSError('wav_parse_failed') from error
    if not pcm or len(pcm)!=frames*2:raise PersistentTTSError('wav_pcm_incomplete')
    return pcm

def tmpfs_directory(path):
    root=Path(path).resolve(strict=True)
    if not root.is_dir():raise PersistentTTSError('ram_directory_invalid')
    mounts=Path('/proc/mounts').read_text(encoding='utf8')
    if len(mounts)>262144:raise PersistentTTSError('mount_table_limit')
    selected=None
    for line in mounts.splitlines():
        fields=line.split()
        if len(fields)<3:continue
        target=fields[1].replace('\\040',' ').replace('\\011','\t').replace('\\134','\\')
        try:
            mount=Path(target)
            if root==mount or mount in root.parents:
                if selected is None or len(target)>len(selected[0]):selected=(target,fields[2])
        except ValueError:continue
    if selected is None or selected[1]!='tmpfs':raise PersistentTTSError('anonymous_audio_requires_tmpfs_no_disk_fallback')
    return root

class PosixPiperSession:
    """One unmodified Piper child, fixed FD path, bounded readers and WAV inode."""
    def __init__(self,delegate,ram_directory='/dev/shm',*,max_cpus=None):
        if sys.platform!='linux':raise PersistentTTSError('persistent_transport_requires_linux')
        # Resolve the inherited set and native setter before opening/forking.
        self.child_cpus=select_child_cpus(max_cpus);self.max_cpus=max_cpus
        affinity_setter=getattr(os,'sched_setaffinity',None)
        module=sys.modules[type(delegate).__module__]
        if not getattr(module,'_LINUX_CHILD_GUARDS',False):raise PersistentTTSError('existing_linux_child_guards_required')
        self.delegate=delegate;self.module=module;self.max_bytes=int(delegate.max_seconds*16000*2)+4096
        self.file=tempfile.TemporaryFile(mode='w+b',buffering=0,dir=tmpfs_directory(ram_directory))
        self.fd=self.file.fileno();self.path='/proc/self/fd/'+str(self.fd)
        if os.fstat(self.fd).st_nlink!=0:self.file.close();raise PersistentTTSError('audio_inode_must_be_unlinked')
        if self.fd>=module.CHILD_FD_LIMIT:self.file.close();raise PersistentTTSError('anonymous_fd_exceeds_existing_limit')
        self.queue=queue.Queue(maxsize=2);self.fault=threading.Event();self.initialized=threading.Event();self.lock=threading.Lock()
        self.stderr=bytearray();self.stats=collections.deque(maxlen=4);self.voice_load=None;self.stat_count=0;self.request_count=0
        self.process=None;self.readers=[];self.closed=False;self.spawn_at=time.monotonic();self.initialized_wall=None
        self.affinity_lock=threading.Lock();self.affinity_verified=threading.Event();self.synthesis_active=threading.Event()
        self.affinity_checks=0;self.affinity_thread_count=0
        command,environment,rate=delegate._command()
        if rate!=16000:self.file.close();raise PersistentTTSError('existing_voice_rate_changed')
        command=[item for item in command if item not in ('--output-raw','--output_raw')]
        command+=['--json-input','--output_file',self.path]
        expected_parent=os.getpid()
        def setup():
            persistent_child_setup(module,expected_parent,self.max_bytes,self.child_cpus,affinity_setter)
        try:
            self.process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                env=environment,pass_fds=(self.fd,),start_new_session=True,preexec_fn=setup,bufsize=0)
            self.readers=[threading.Thread(target=self._stdout,daemon=True),threading.Thread(target=self._stderr,daemon=True)]
            for reader in self.readers:reader.start()
        except BaseException:self.close();raise
    def _stdout(self):
        try:
            while True:
                line=self.process.stdout.readline(1025)
                if not line:break
                if len(line)>1024 or not line.endswith(b'\n'):self.fault.set();break
                try:self.queue.put_nowait(line.rstrip(b'\r\n'))
                except queue.Full:self.fault.set();break
        except (OSError,ValueError):self.fault.set()
        finally:self.process.stdout.close();self.fault.set()
    def _stderr(self):
        buffered=bytearray()
        try:
            while True:
                chunk=self.process.stderr.read(4096)
                if not chunk:break
                with self.lock:
                    self.stderr.extend(chunk);del self.stderr[:-8192]
                buffered.extend(chunk)
                while b'\n' in buffered:
                    line,_,tail=buffered.partition(b'\n');buffered=bytearray(tail)
                    text=line.decode('utf8','replace')
                    loaded=re.search(r'Loaded voice in ([0-9.eE+-]+) second',text)
                    factor=re.search(r'Real-time factor: ([0-9.eE+-]+) \(infer=([0-9.eE+-]+) sec, audio=([0-9.eE+-]+) sec\)',text)
                    with self.lock:
                        if loaded:self.voice_load=float(loaded[1])
                        if 'Initialized piper' in text:
                            self.initialized_wall=time.monotonic()-self.spawn_at;self.initialized.set()
                        if factor:
                            self.stat_count+=1;self.stats.append((self.stat_count,float(factor[2]),float(factor[3]),float(factor[1])))
                if len(buffered)>4096:del buffered[:-4096]
        except (OSError,ValueError):pass
        finally:self.process.stderr.close()
    def request(self,text,cancel,deadline):
        if self.closed or self.fault.is_set() or self.process.poll() is not None:raise PersistentTTSError('piper_session_unavailable')
        if not self.queue.empty():raise PersistentTTSError('unexpected_stale_completion')
        self.file.seek(0);self.file.truncate(0);self.request_count+=1;index=self.request_count
        payload=(json.dumps({'text':text,'output_file':self.path},ensure_ascii=False,separators=(',',':'))+'\n').encode('utf8')
        if len(payload)>2048:raise PersistentTTSError('piper_request_limit')
        begin=time.monotonic()
        try:
            while not self.initialized.wait(.02):
                if cancel.is_set():raise PersistentTTSCancelled('cancelled_during_initialization')
                if time.monotonic()>=deadline:raise PersistentTTSError('piper_initialization_deadline')
                if self.fault.is_set() or self.process.poll() is not None:raise PersistentTTSError('piper_initialization_failed')
            # ORT 1.14 may expand its worker affinities during initialization.
            # No synthesis JSON is written until every current task is verified.
            self._enforce_affinity(cancel,deadline)
            self.synthesis_active.set()
            self.process.stdin.write(payload)
            while True:
                if cancel.is_set():raise PersistentTTSCancelled('cancelled_stale_audio_discarded')
                if time.monotonic()>=deadline:raise PersistentTTSError('synthesis_deadline')
                if self.fault.is_set() or self.process.poll() is not None:raise PersistentTTSError('piper_session_failed')
                try:line=self.queue.get(timeout=min(.02,max(.001,deadline-time.monotonic())))
                except queue.Empty:continue
                if line!=self.path.encode('utf8'):raise PersistentTTSError('unexpected_completion_path')
                ack=time.monotonic();break
            # Native stdout ACK precedes the ofstream destructor/flush.
            while True:
                if cancel.is_set():raise PersistentTTSCancelled('cancelled_stale_audio_discarded')
                if time.monotonic()>=deadline:raise PersistentTTSError('wav_flush_deadline')
                pcm=read_complete_wav(self.file,self.max_bytes)
                if pcm is not None:break
                if self.process.poll() is not None:raise PersistentTTSError('piper_exited_before_wav_flush')
                time.sleep(.005)
            if len(pcm)>int(self.delegate.max_seconds*16000*2):raise PersistentTTSError('pcm_duration_limit')
            self._enforce_affinity(cancel,deadline)
            # Stats are indexed independently of ACK arrival, so a late stderr
            # metric from the previous request can never label this request.
            with self.lock:
                metrics=cumulative_inference_metrics(self.stats,index);loaded=self.voice_load
            elapsed=time.monotonic()-begin
            return pcm,16000,{'request_wall_seconds':elapsed,'completion_ack_seconds':ack-begin,
                'voice_load_seconds_reported':loaded,**metrics,
                'piper_initialized_wall_seconds_observed':self.initialized_wall,
                'model_load_this_call':index==1,'model_load_count_this_process':1,'process_pid':self.process.pid,
                # These attest preexec setup only, not later ORT thread masks.
                'cpu_affinity_preexec_applied':self.child_cpus is not None,
                'cpu_affinity_requested_max':self.max_cpus or 0,'cpu_affinity_preexec_count':len(self.child_cpus) if self.child_cpus else 0,
                'cpu_affinity_threads_verified':self.affinity_verified.is_set(),
                'cpu_affinity_verified_thread_count':self.affinity_thread_count,'cpu_affinity_checks':self.affinity_checks,
                'audio_file_kind':'single_unlinked_tmpfs_inode','audio_file_persisted':False,'cloud_used':False}
        except BaseException:
            self.close();raise
        finally:
            self.synthesis_active.clear()
            if not self.closed:self.file.seek(0);self.file.truncate(0)
    def _enforce_affinity(self,cancel,deadline):
        if self.child_cpus is None:return
        with self.affinity_lock:
            self.affinity_verified.clear()
            if self.closed:raise PersistentTTSError('piper_session_closed')
            result=enforce_piper_threads(self.process,self.child_cpus,cancel,deadline)
            self.affinity_checks+=1;self.affinity_thread_count=result['thread_count'];self.affinity_verified.set()
    def close(self):
        if self.closed:return
        self.closed=True
        self.synthesis_active.clear();self.affinity_verified.clear()
        with self.affinity_lock:
            if self.process is not None:
                self.module._stop_process(self.process)
                for stream in (self.process.stdin,self.process.stdout,self.process.stderr):
                    if stream and not stream.closed:stream.close()
                for reader in self.readers:reader.join(timeout=1)
        self.file.close()
    def status(self):
        try:audio_bytes=0 if self.closed else os.fstat(self.fd).st_size
        except OSError:audio_bytes=0
        with self.lock:stderr_bytes=len(self.stderr);statistics=len(self.stats)
        return {'alive':bool(not self.closed and self.process and self.process.poll() is None and not self.fault.is_set()),
            'initialized':self.initialized.is_set(),'process_pid':self.process.pid if self.process else None,
            'request_count':self.request_count,'anonymous_audio_bytes':audio_bytes,
            'cpu_affinity_preexec_applied':self.child_cpus is not None,
            'cpu_affinity_requested_max':self.max_cpus or 0,'cpu_affinity_preexec_count':len(self.child_cpus) if self.child_cpus else 0,
            'cpu_affinity_threads_verified':self.affinity_verified.is_set(),
            'cpu_affinity_verified_thread_count':self.affinity_thread_count,'cpu_affinity_checks':self.affinity_checks,
            'synthesis_active':self.synthesis_active.is_set(),
            'reader_threads':sum(reader.is_alive() for reader in self.readers),
            'stderr_buffer_bytes':stderr_bytes,'statistics_entries':statistics}

class PersistentPiperTTS:
    """Lazy persistent child; fixed cache bypass; one call; cancel kills/restarts."""
    def __init__(self,delegate,*,session_factory=None,max_cpus=None):
        if delegate.engine!='piper':raise ValueError('existing_piper_voice_required')
        validate_max_cpus(max_cpus);self.max_cpus=max_cpus
        self.delegate=delegate;self.factory=session_factory or (lambda:PosixPiperSession(delegate,max_cpus=max_cpus))
        self.session=None;self.last_report=None;self.lock=threading.Lock();self.closed=threading.Event()
        self.starts=0;self.last_error='none';atexit.register(self.close)
    @property
    def _fixed_cache(self):return self.delegate._fixed_cache
    @property
    def fixed_cache_error(self):return self.delegate.fixed_cache_error
    @property
    def engine(self):return self.delegate.engine
    def status(self):
        details=self.session.status() if self.session and callable(getattr(self.session,'status',None)) else {}
        state='closed' if self.closed.is_set() else 'active' if self.lock.locked() else 'idle' if details.get('alive') else 'unavailable' if self.session else 'not_started'
        return {**details,'persistent':True,'lazy_started':self.starts>0,'state':state,'closed':self.closed.is_set(),
                'worker_start_count':self.starts,'last_error':self.last_error,
                'cpu_affinity_requested_max':self.max_cpus or 0,
                'cloud_used':False,'audio_file_persisted':False}
    def synthesize(self,text,cancel):
        if not isinstance(text,str) or not text.strip() or len(text)>120 or '\0' in text:raise PersistentTTSError('bounded_text_required')
        if self.closed.is_set() or cancel.is_set():raise PersistentTTSCancelled('closed_or_cancelled')
        if not self.lock.acquire(False):raise PersistentTTSError('one_tts_request_at_a_time')
        begin=time.monotonic()
        try:
            self.last_error='none'
            if text.strip() in self.delegate._fixed_cache:
                clip=self.delegate.synthesize(text,cancel);self.last_report=dict(self.delegate.last_report);return clip
            if self.session is None:self.session=self.factory();self.starts+=1
            pcm,rate,metrics=self.session.request(text.strip(),cancel,begin+self.delegate.timeout)
            if self.closed.is_set() or cancel.is_set():raise PersistentTTSCancelled('late_cancel_discarded')
            if time.monotonic()>=begin+self.delegate.timeout:raise PersistentTTSError('late_deadline_audio_discarded')
            if rate!=16000 or not isinstance(pcm,bytes) or not pcm or len(pcm)%2 or len(pcm)>int(self.delegate.max_seconds*rate*2):raise PersistentTTSError('bounded_pcm_required')
            module=sys.modules[type(self.delegate).__module__]
            clip=module.TTSAudio(pcm,rate)
            self.last_report={**metrics,'synthesis_wall_seconds':time.monotonic()-begin,
                'audio_seconds':len(pcm)/(2*rate),'model_inference_this_call':True,'cache_hit':False,
                'worker_start_count':self.starts,'same_voice_assets':True}
            return clip
        except BaseException as error:
            self.last_error='cancelled' if isinstance(error,PersistentTTSCancelled) else 'deadline' if isinstance(error,PersistentTTSError) and 'deadline' in str(error) else 'unavailable'
            if self.session:self.session.close();self.session=None
            raise
        finally:self.lock.release()
    def close(self):
        self.closed.set()
        if self.session:self.session.close();self.session=None
        atexit.unregister(self.close)
