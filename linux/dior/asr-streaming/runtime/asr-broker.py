#!/usr/bin/env python3
"""Local AF_UNIX serialized CPU ASR broker. It never records audio or text.

Native inference stays in a separate bounded Bionic process. The protocol is
PCM16 mono16k JSON lines; clients must obtain ready_session before sending.
"""
import argparse
import atexit
import base64
import collections
import grp
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import resource
import selectors
import signal
import socket
import stat
import subprocess
import sys
import threading
import time

sys.dont_write_bytecode=True
LINE_LIMIT=65536
CONNECTION_LIMIT=8
SEGMENT_SAMPLES=480000
CHUNK_BYTES=32000
IDLE_SECONDS=20
QUEUE_SECONDS=90
SESSION_SECONDS=60
WORKER_TIMEOUT=10
THERMAL_LIMIT=65.0
SOCKET_PATH='/run/dior-asr/recognize.sock'
MODEL_NAMES=('encoder_jit_trace-pnnx.ncnn.param','encoder_jit_trace-pnnx.ncnn.bin',
 'decoder_jit_trace-pnnx.ncnn.param','decoder_jit_trace-pnnx.ncnn.bin',
 'joiner_jit_trace-pnnx.ncnn.param','joiner_jit_trace-pnnx.ncnn.bin','tokens.txt')

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def trusted(path,directory=False):
    path=Path(path)
    info=path.lstat()
    correct=stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not correct or info.st_uid!=0 or info.st_mode&0o022:
        raise ValueError('Expected root-owned immutable installation path: '+str(path))
    return path.resolve(strict=True)

def validate_config(path):
    path=trusted(path)
    if path.stat().st_size>16384:raise ValueError('Config is too large')
    config=json.loads(path.read_text(encoding='utf8'))
    if config.get('version')!=1 or config.get('socket')!=SOCKET_PATH or config.get('socket_group')!='dior-asr':
        raise ValueError('Invalid fixed local socket config')
    if type(config.get('threads')) is not int or config.get('threads') not in (1,2,3,4) or config.get('decoder') not in ('greedy_search','modified_beam_search') or type(config.get('beam')) is not int or config.get('beam') not in range(1,9) or config.get('endpoint')!=1:
        raise ValueError('Invalid bounded CPU profile')
    base=trusted('/opt/dior-asr',directory=True)
    worker=trusted(config['worker'])
    if worker!=base/'stream-worker' or not os.access(worker,os.X_OK) or worker.stat().st_size>8*1024*1024 or digest(worker)!=config['worker_sha256']:
        raise ValueError('Worker qualification hash mismatch')
    model=trusted(config['model_dir'],directory=True)
    if model!=base/'models/bilingual32':raise ValueError('Unexpected model directory')
    entries=config.get('model_files')
    if not isinstance(entries,list) or len(entries)!=7 or {e.get('path') for e in entries}!=set(MODEL_NAMES):
        raise ValueError('Expected seven qualified inference files')
    for entry in entries:
        filename=trusted(model/entry['path'])
        if filename.parent!=model or filename.stat().st_size!=entry['bytes'] or digest(filename)!=entry['sha256']:
            raise ValueError('Model qualification hash mismatch: '+entry['path'])
    return config

def temperature_c():
    values=[]
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            value=float(path.read_text().strip())
            if abs(value)>200:value/=1000
            if -20<=value<=150:values.append(value)
        except (OSError,ValueError):pass
    return max(values) if values else None

def json_depth_ok(blob):
    depth=0;quoted=False;escaped=False
    for ch in blob:
        if quoted:
            if escaped:escaped=False
            elif ch==92:escaped=True
            elif ch==34:quoted=False
        elif ch==34:quoted=True
        elif ch in (123,91):
            depth+=1
            if depth>8:return False
        elif ch in (125,93):
            depth-=1
            if depth<0:return False
    return depth==0 and not quoted

class FrameError(Exception):pass
class WorkerError(Exception):pass

class NativeWorker:
    def __init__(self,config):
        self.config=config
        self.process=None
        self.responses=queue.Queue(maxsize=4)
        self.fault=threading.Event()
        self.stderr_bytes=0
        self.stderr_ring=bytearray()
        self.stderr_lock=threading.Lock()
        self.ready=None
        self.serial=0
        self.load_count=0
        self.lifecycle=threading.RLock()
        atexit.register(self.stop)
        self.start()

    def start(self):
        with self.lifecycle:return self._start_locked()

    def _start_locked(self):
        sdk=Path('/opt/dior-android')
        loader=trusted(sdk/'run-native.py')
        spec=importlib.util.spec_from_file_location('dior_readonly_property_transport',loader)
        transport=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(transport)
        _unused_gpu_program,sdk_env,fd=transport.runtime_environment('opencl',[])
        env={k:sdk_env[k] for k in ('LD_LIBRARY_PATH','ANDROID_PROPERTY_WORKSPACE')}
        env.update(PATH='/usr/bin:/bin',LANG='C.UTF-8',OMP_WAIT_POLICY='PASSIVE',
                   KMP_BLOCKTIME='0',OMP_THREAD_LIMIT='4',OMP_NUM_THREADS=str(self.config['threads']))
        def limits():
            resource.setrlimit(resource.RLIMIT_CORE,(0,0))
            resource.setrlimit(resource.RLIMIT_AS,(768*1024*1024,)*2)
            resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
            # No total RLIMIT_CPU: this process is deliberately long lived.
        command=[self.config['worker'],self.config['model_dir'],str(self.config['threads']),
                 self.config['decoder'],str(self.config['beam']),'1']
        try:
            self.process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,env=env,pass_fds=(fd,),close_fds=True,
                start_new_session=True,preexec_fn=limits,bufsize=0)
        finally:os.close(fd)
        self.responses=queue.Queue(maxsize=4)
        self.fault=threading.Event()
        threading.Thread(target=self._read_stdout,args=(self.process,self.responses,self.fault),daemon=True).start()
        threading.Thread(target=self._read_stderr,args=(self.process,),daemon=True).start()
        try:
            self.ready=self._response(20)
            if self.ready.get('type')!='ready' or self.ready.get('gpu_used') is not False:
                raise WorkerError('invalid_cpu_worker_readiness')
        except Exception:
            self.stop();raise
        self.load_count+=1

    def _read_stdout(self,process,responses,fault):
        try:
            while True:
                line=process.stdout.readline(LINE_LIMIT+1)
                if not line:break
                if len(line)>LINE_LIMIT or not line.endswith(b'\n'):raise WorkerError('worker_output_limit')
                reply=json.loads(line)
                if not isinstance(reply,dict):raise WorkerError('worker_output_type')
                try:responses.put_nowait(reply)
                except queue.Full:raise WorkerError('worker_output_backlog')
        except Exception:fault.set()
        finally:fault.set()

    def _read_stderr(self,process):
        try:
            while True:
                chunk=process.stderr.read(1024)
                if not chunk:break
                with self.stderr_lock:
                    self.stderr_bytes+=len(chunk)
                    self.stderr_ring.extend(chunk)
                    if len(self.stderr_ring)>16384:del self.stderr_ring[:-16384]
        except (OSError,ValueError):pass

    def _response(self,timeout):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:return self.responses.get(timeout=min(.1,max(.001,deadline-time.monotonic())))
            except queue.Empty:
                if self.fault.is_set() or self.process.poll() is not None:raise WorkerError('worker_exited')
        raise WorkerError('worker_request_timeout')

    def rpc(self,request):
        if self.fault.is_set() or self.process.poll() is not None:raise WorkerError('worker_unavailable')
        self.serial+=1
        message=dict(request);message['id']='broker_'+str(self.serial)
        encoded=(json.dumps(message,separators=(',',':'))+'\n').encode()
        if len(encoded)>LINE_LIMIT:raise WorkerError('worker_request_limit')
        try:
            sent=0
            while sent<len(encoded):
                written=self.process.stdin.write(encoded[sent:])
                if not written:raise WorkerError('worker_pipe_closed')
                sent+=written
            self.process.stdin.flush()
            response=self._response(WORKER_TIMEOUT)
        except (OSError,ValueError) as error:raise WorkerError('worker_pipe_error') from error
        if response.get('id')!=message['id']:raise WorkerError('worker_response_order')
        return response

    def summary(self):
        with self.stderr_lock:
            return {'worker_pid':self.process.pid if self.process else None,
                'model_load_count':self.load_count,'stderr_received_bytes':self.stderr_bytes,
                'stderr_retained_bytes':len(self.stderr_ring),'stderr_limit_bytes':16384}

    def stop(self):
        with self.lifecycle:return self._stop_locked()

    def _stop_locked(self):
        p=self.process
        if not p:return
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

class Broker:
    def __init__(self,config,worker=None,temperature_reader=temperature_c):
        self.config=config;self.worker=worker or NativeWorker(config);self.temperature_reader=temperature_reader
        self.condition=threading.Condition();self.waiting=collections.deque();self.active=None
        self.slots=threading.BoundedSemaphore(CONNECTION_LIMIT);self.stopping=threading.Event()
        self.listener=None;self.connections=set();self.threads=set();self.last_restart=0
        self.completed=0;self.rejected=0;self.thermal_pauses=0

    def _send(self,connection,reply):
        encoded=(json.dumps(reply,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(encoded)>LINE_LIMIT:raise FrameError('response_limit')
        connection.sendall(encoded)

    def _alive(self,connection):
        if not select_readable(connection):return True
        try:return bool(connection.recv(1,socket.MSG_PEEK))
        except OSError:return False

    def _acquire(self,connection,ticket):
        with self.condition:self.waiting.append(ticket);self.condition.notify_all()
        deadline=time.monotonic()+QUEUE_SECONDS
        try:
            while not self.stopping.is_set():
                if not self._alive(connection):return False
                with self.condition:
                    if self.active is None and self.waiting and self.waiting[0] is ticket:
                        self.waiting.popleft();self.active=ticket;return True
                    remaining=deadline-time.monotonic()
                    if remaining<=0:return False
                    self.condition.wait(timeout=min(.25,remaining))
            return False
        finally:
            with self.condition:
                if ticket in self.waiting:self.waiting.remove(ticket)
                self.condition.notify_all()

    def _frame(self,connection,buffer,deadline):
        while True:
            index=buffer.find(b'\n')
            if index>=0:
                line=bytes(buffer[:index]);del buffer[:index+1]
                if len(line)+1>LINE_LIMIT or not line or b'\0' in line or not json_depth_ok(line):raise FrameError('invalid_bounded_json')
                try:frame=json.loads(line.decode('utf8'))
                except (UnicodeError,ValueError):raise FrameError('invalid_json')
                if not isinstance(frame,dict):raise FrameError('expected_object')
                return frame
            if len(buffer)>=LINE_LIMIT:raise FrameError('frame_limit')
            remaining=deadline-time.monotonic()
            if remaining<=0:raise FrameError('idle_timeout')
            connection.settimeout(min(IDLE_SECONDS,remaining))
            try:chunk=connection.recv(min(4096,LINE_LIMIT-len(buffer)))
            except socket.timeout:raise FrameError('idle_timeout')
            if not chunk:raise EOFError
            buffer.extend(chunk)

    def _temperature(self):
        value=self.temperature_reader()
        if value is None:raise FrameError('thermal_sensor_unavailable')
        if value>THERMAL_LIMIT:
            self.thermal_pauses+=1;raise FrameError('thermal_pause')
        return value

    def _reset(self):
        try:
            response=self.worker.rpc({'op':'reset'})
            if response.get('type')!='reset':raise WorkerError('worker_reset_failed')
        except WorkerError:
            self.worker.stop()
            if self.stopping.is_set():return
            remaining=5-(time.monotonic()-self.last_restart)
            if remaining>0:self.stopping.wait(remaining)
            if self.stopping.is_set():return
            self.last_restart=time.monotonic();self.worker.start()

    def _client(self,connection):
        ticket=object();acquired=False;client_id=None;total_samples=0;buffer=bytearray()
        try:
            connection.settimeout(IDLE_SECONDS)
            self._send(connection,{'type':'queued','protocol_version':1,'max_connections':CONNECTION_LIMIT,'queue_wait_seconds':QUEUE_SECONDS})
            acquired=self._acquire(connection,ticket)
            if not acquired:
                self._send(connection,{'type':'error','code':'queue_timeout'});return
            self._reset()
            started=time.monotonic();session_deadline=started+SESSION_SECONDS
            self._send(connection,{'type':'ready_session','model_name':self.config['model_name'],
                'backend':'CPU_NEON_OPENMP','gpu_used':False,'threads':self.config['threads'],
                'max_audio_seconds':30,'max_chunk_samples':16000,'idle_seconds':IDLE_SECONDS,
                'session_wall_limit_seconds':SESSION_SECONDS,'temperature_c':self.temperature_reader(),
                **self.worker.summary()})
            while not self.stopping.is_set():
                self._temperature()
                request=self._frame(connection,buffer,min(session_deadline,time.monotonic()+IDLE_SECONDS))
                if time.monotonic()>=session_deadline:raise FrameError('session_wall_limit')
                candidate_id=request.get('id')
                client_id=None
                try:
                    if candidate_id is not None and (not isinstance(candidate_id,str) or len(candidate_id.encode('utf8'))>64):raise FrameError('invalid_id')
                except UnicodeError:raise FrameError('invalid_id')
                client_id=candidate_id
                op=request.get('op')
                if op not in ('feed','finish','reset','ping'):raise FrameError('forbidden_operation')
                allowed={'op','id','pcm16_base64'} if op=='feed' else {'op','id'}
                if set(request)-allowed:raise FrameError('unexpected_fields')
                command={'op':op}
                if op=='feed':
                    data=request.get('pcm16_base64')
                    if not isinstance(data,str) or not 0<len(data)<=42668:raise FrameError('invalid_pcm16')
                    try:decoded=base64.b64decode(data,validate=True)
                    except (ValueError,base64.binascii.Error):raise FrameError('invalid_pcm16')
                    if not decoded or len(decoded)%2 or len(decoded)>CHUNK_BYTES or base64.b64encode(decoded).decode()!=data:raise FrameError('invalid_pcm16')
                    if total_samples+len(decoded)//2>SEGMENT_SAMPLES:raise FrameError('audio_limit')
                    total_samples+=len(decoded)//2;command['pcm16_base64']=data
                self._temperature()
                reply=self.worker.rpc(command)
                self._temperature()
                if reply.get('type')=='error':raise FrameError('native_request_rejected')
                reply['id']=client_id;reply['session_audio_seconds']=total_samples/16000.
                reply.update(self.worker.summary())
                self._send(connection,reply)
                if op=='finish':self.completed+=1;return
        except EOFError:pass
        except FrameError as error:
            self.rejected+=1
            try:self._send(connection,{'type':'error','id':client_id,'code':str(error)})
            except OSError:pass
        except (WorkerError,OSError):
            try:self._send(connection,{'type':'error','id':client_id,'code':'worker_or_connection_unavailable'})
            except OSError:pass
        finally:
            if acquired:
                try:self._reset()
                except Exception:self.stopping.set()
                with self.condition:self.active=None;self.condition.notify_all()
            connection.close()
            with self.condition:self.connections.discard(connection);self.threads.discard(threading.current_thread())
            self.slots.release()

    def serve(self,socket_path=SOCKET_PATH,group_name='dior-asr'):
        path=Path(socket_path)
        if path.exists():
            info=path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.geteuid():raise RuntimeError('Unexpected existing socket path')
            probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            try:probe.connect(str(path));raise RuntimeError('ASR broker is already listening')
            except (ConnectionRefusedError,FileNotFoundError):path.unlink()
            finally:probe.close()
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.listener=listener
        listener.bind(str(path));os.chmod(path,0o660)
        if group_name is not None:os.chown(path,-1,grp.getgrnam(group_name).gr_gid)
        listener.listen(CONNECTION_LIMIT);listener.settimeout(.5)
        try:
            while not self.stopping.is_set():
                try:connection,_address=listener.accept()
                except socket.timeout:continue
                except OSError:
                    if self.stopping.is_set():break
                    raise
                connection.setsockopt(socket.SOL_SOCKET,socket.SO_RCVBUF,65536)
                if not self.slots.acquire(blocking=False):
                    connection.settimeout(1)
                    try:self._send(connection,{'type':'error','code':'busy','max_connections':CONNECTION_LIMIT})
                    except OSError:pass
                    connection.close();continue
                thread=threading.Thread(target=self._client,args=(connection,),daemon=True)
                with self.condition:self.connections.add(connection);self.threads.add(thread)
                thread.start()
        finally:
            self.stop()
            listener.close()
            if path.exists() and stat.S_ISSOCK(path.lstat().st_mode) and path.lstat().st_uid==os.geteuid():path.unlink()

    def stop(self):
        self.stopping.set()
        with self.condition:
            self.condition.notify_all();connections=list(self.connections)
        for connection in connections:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        self.worker.stop()

def select_readable(connection):
    import select
    return bool(select.select([connection],[],[],0)[0])

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',default='/etc/dior-asr.json')
    parser.add_argument('--check-config',action='store_true')
    args=parser.parse_args()
    def early_stop(_signum,_frame):raise SystemExit(0)
    signal.signal(signal.SIGTERM,early_stop);signal.signal(signal.SIGINT,early_stop)
    config=validate_config(args.config)
    if args.check_config:
        print(json.dumps({'status':'CONFIG_HASHES_PASS','model_name':config['model_name'],
                          'worker_sha256':config['worker_sha256'],'model_files':7,'gpu_used':False}))
        return
    path=Path(SOCKET_PATH)
    parent=path.parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.geteuid() or stat.S_IMODE(parent.st_mode)!=0o750:
        raise ValueError('Expected private service-owned 0750 /run/dior-asr')
    broker=Broker(config)
    def stop(_signum,_frame):broker.stop()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    broker.serve()

if __name__=='__main__':main()
