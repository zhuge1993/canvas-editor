"""Short leased streaming ASR client, not an unlimited always-connected monitor."""
import base64
import collections
import json
import socket
import threading
import time

class Span:
    def __init__(self,generation,mode,now,preroll,max_seconds=4):
        self.generation=generation;self.mode=mode;self.origin_mode=mode;self.created=now;self.max_seconds=max_seconds
        self.cancel=threading.Event();self.closed=False;self.overflow=False
        self.frames=collections.deque(preroll,maxlen=50);self.condition=threading.Condition()
        self.samples=len(preroll)*320;self.last_voice=now
    def push(self,frame,voiced):
        with self.condition:
            if self.closed or self.cancel.is_set():return False
            if len(self.frames)>=50:self.overflow=True;self.cancel.set();self.condition.notify_all();return False
            if self.samples+320>int(self.max_seconds*16000):self.closed=True;self.condition.notify_all();return False
            self.frames.append(frame.pcm16);self.samples+=320
            if voiced:self.last_voice=frame.at_monotonic
            self.condition.notify_all();return True
    def finish(self):
        with self.condition:self.closed=True;self.condition.notify_all()
    def abort(self):self.cancel.set();self.finish()
    def take(self,timeout=.05):
        with self.condition:
            if not self.frames and not self.closed and not self.cancel.is_set():self.condition.wait(timeout)
            data=b''.join(self.frames.popleft() for _ in range(min(10,len(self.frames))))
            return data,self.closed and not self.frames

class StreamingASR:
    def __init__(self,path='/run/dior-asr/recognize.sock',lease_hooks=None):self.path=path;self.lease_hooks=lease_hooks
    def recognize(self,span,on_partial):
        if self.lease_hooks is not None:self.lease_hooks.begin()
        try:return self._recognize(span,on_partial)
        finally:
            if self.lease_hooks is not None:self.lease_hooks.end()
    def _recognize(self,span,on_partial):
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);connection.settimeout(2)
        buffer=bytearray();serial=0;finals=[];last=''
        def receive():
            while True:
                if span.cancel.is_set():raise TimeoutError('asr_cancelled')
                end=buffer.find(b'\n')
                if end>=0:
                    raw=bytes(buffer[:end]);del buffer[:end+1];return json.loads(raw)
                if len(buffer)>=65536:raise ValueError('asr_output_limit')
                chunk=connection.recv(min(4096,65536-len(buffer)))
                if not chunk:raise ConnectionError('asr_disconnected')
                buffer.extend(chunk)
        def request(op,**payload):
            nonlocal serial
            serial+=1;ident='voice_'+str(serial)
            connection.sendall((json.dumps({'op':op,'id':ident,**payload},separators=(',',':'))+'\n').encode())
            reply=receive()
            if reply.get('id')!=ident or reply.get('type')=='error':raise RuntimeError('asr_request_failed')
            return reply
        try:
            connection.connect(self.path)
            while True:
                reply=receive()
                if reply.get('type')=='ready_session':break
                if reply.get('type')!='queued':raise RuntimeError('asr_not_ready')
            connection.settimeout(2)
            while not span.cancel.is_set():
                if time.monotonic()-span.created>20:raise TimeoutError('asr_lease_limit')
                raw,done=span.take()
                if raw:
                    reply=request('feed',pcm16_base64=base64.b64encode(raw).decode())
                    last=str(reply.get('text',''))[:512]
                    if last:on_partial(last)
                    if reply.get('type')=='final':
                        if last:finals.append(last)
                        # Return actual endpoint promptly and release the lease.
                        request('finish');return ' '.join(finals)
                if done:
                    reply=request('finish');last=str(reply.get('text',''))[:512]
                    if last:finals.append(last)
                    return ' '.join(finals)
            raise TimeoutError('asr_cancelled')
        finally:connection.close()
