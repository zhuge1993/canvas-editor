"""Read-only local status socket; never accepts text or administrative actions."""
import json
import os
from pathlib import Path
import socket
import stat
import threading
import time

class StatusServer:
    def __init__(self,snapshot,path='/run/dior-voice/control.sock',group='dior-voice'):
        self.snapshot=snapshot;self.path=Path(path);self.group=group
        self.stopping=threading.Event();self.slots=threading.BoundedSemaphore(4)
        self.lock=threading.Lock();self.connections=set();self.handlers=set();self.listener=None;self.thread=None
        self.bound=False
    def start(self):
        parent=self.path.parent.lstat()
        if not stat.S_ISDIR(parent.st_mode) or parent.st_uid!=os.geteuid() or stat.S_IMODE(parent.st_mode)!=0o750:
            raise ValueError('Expected service-owned0750 control directory')
        if self.path.exists():
            info=self.path.lstat()
            if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.geteuid():raise ValueError('unexpected_control_path')
            probe=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            try:probe.connect(str(self.path));raise ValueError('control_already_listening')
            except (ConnectionRefusedError,FileNotFoundError):self.path.unlink()
            finally:probe.close()
        self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.listener.bind(str(self.path))
        self.bound=True
        os.chmod(self.path,0o660)
        if self.group is not None:
            import grp
            os.chown(self.path,-1,grp.getgrnam(self.group).gr_gid)
        self.listener.listen(4);self.listener.settimeout(.2)
        self.thread=threading.Thread(target=self._serve,daemon=True);self.thread.start()
    def _send(self,connection,value):
        data=(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(data)>4096 and isinstance(value.get('status'),dict) and 'diagnostic_turns' in value['status']:
            # Optional text diagnostics never displace live readiness, model
            # errors or the numeric microphone/deadline evidence.
            snapshot=dict(value['status']);snapshot.pop('diagnostic_turns',None);snapshot.pop('diagnostic_expires_in',None)
            snapshot['diagnostic_omitted']=True
            data=(json.dumps({**value,'status':snapshot},ensure_ascii=False,separators=(',',':'))+'\n').encode()
        if len(data)>4096:data=b'{"error":"status_response_limit"}\n'
        connection.sendall(data)
    def _serve(self):
        while not self.stopping.is_set():
            try:connection,_=self.listener.accept()
            except socket.timeout:continue
            except OSError:return
            connection.settimeout(2)
            if not self.slots.acquire(False):
                try:self._send(connection,{'error':'busy'})
                except OSError:pass
                connection.close();continue
            thread=threading.Thread(target=self._handle,args=(connection,),daemon=True)
            with self.lock:self.connections.add(connection);self.handlers.add(thread)
            thread.start()
    def _handle(self,connection):
        try:
            connection.settimeout(2);buffer=bytearray();deadline=time.monotonic()+2
            while b'\n' not in buffer:
                if len(buffer)>=4096:raise ValueError('frame_limit')
                remaining=deadline-time.monotonic()
                if remaining<=0:raise ValueError('request_timeout')
                connection.settimeout(remaining)
                chunk=connection.recv(min(1024,4096-len(buffer)))
                if not chunk:return
                buffer.extend(chunk)
            raw,_,remaining=buffer.partition(b'\n')
            if remaining or len(raw)>128 or raw.count(b'{')!=1 or raw.count(b'['):raise ValueError('invalid_status_request')
            request=json.loads(raw)
            if request!={'op':'status'}:raise ValueError('status_only')
            self._send(connection,{'status':self.snapshot()})
        except (OSError,ValueError,UnicodeError):
            try:self._send(connection,{'error':'invalid_or_timeout_status_request'})
            except OSError:pass
        finally:
            connection.close()
            with self.lock:self.connections.discard(connection);self.handlers.discard(threading.current_thread())
            self.slots.release()
    def close(self):
        self.stopping.set()
        if self.listener:self.listener.close()
        with self.lock:connections=list(self.connections);handlers=list(self.handlers)
        for connection in connections:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
        if self.thread:self.thread.join(timeout=1)
        for thread in handlers:thread.join(timeout=2.5)
        if self.bound and self.path.exists() and stat.S_ISSOCK(self.path.lstat().st_mode) and self.path.lstat().st_uid==os.geteuid():self.path.unlink()
