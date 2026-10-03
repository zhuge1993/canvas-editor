"""Short leased streaming ASR client, not an unlimited always-connected monitor."""
import base64
import collections
import json
import math
import socket
import threading
import time

class Span:
    FRAME_BYTES=640
    FRAME_SAMPLES=320
    MAX_PREROLL_FRAMES=50
    MAX_FRAMES=250
    def __init__(self,generation,mode,now,preroll,max_seconds=4):
        if type(max_seconds) not in (int,float) or not 0<max_seconds<=30 or not math.isfinite(max_seconds):
            raise ValueError('span_audio_budget')
        self.generation=generation;self.mode=mode;self.origin_mode=mode;self.created=now;self.max_seconds=max_seconds
        self.cancel=threading.Event();self.closed=False;self.overflow=False
        # Leave four seconds of bounded headroom after a one-second KWS
        # replay while lease/ready handshakes run on the recognition thread.
        # Explicit checks prevent deque's silent oldest-frame eviction.
        self.frames=collections.deque();self.condition=threading.Condition()
        for pcm in preroll:
            if len(self.frames)>=self.MAX_PREROLL_FRAMES:raise ValueError('span_preroll_limit')
            if not isinstance(pcm,bytes) or len(pcm)!=self.FRAME_BYTES:raise ValueError('span_pcm_frame')
            self.frames.append(pcm)
        self.samples=len(self.frames)*self.FRAME_SAMPLES;self.last_voice=now
        if self.samples>int(self.max_seconds*16000):raise ValueError('span_audio_budget')
    def push(self,frame,voiced):
        with self.condition:
            if self.closed or self.cancel.is_set():return False
            if not isinstance(frame.pcm16,bytes) or len(frame.pcm16)!=self.FRAME_BYTES:
                self.cancel.set();self.closed=True;self.condition.notify_all();return False
            if len(self.frames)>=self.MAX_FRAMES:self.overflow=True;self.cancel.set();self.condition.notify_all();return False
            if self.samples+self.FRAME_SAMPLES>int(self.max_seconds*16000):self.closed=True;self.condition.notify_all();return False
            self.frames.append(frame.pcm16);self.samples+=self.FRAME_SAMPLES
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
    MAX_TEXT_CHARS=512
    def __init__(self,path='/run/dior-asr/recognize.sock',lease_hooks=None):self.path=path;self.lease_hooks=lease_hooks
    def recognize(self,span,on_partial):
        if self.lease_hooks is not None:self.lease_hooks.begin()
        try:return self._recognize(span,on_partial)
        finally:
            if self.lease_hooks is not None:self.lease_hooks.end()
    def _recognize(self,span,on_partial):
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);connection.settimeout(2)
        buffer=bytearray();serial=0;finals=[];pending_audio=False
        def text_value(reply):
            value=reply.get('text','')
            if not isinstance(value,str):raise ValueError('asr_text_type')
            return value.strip()
        def combined(extra=''):
            value=' '.join(finals+([extra] if extra else []))
            # Never return a truncated command after an excessive transcript.
            if len(value)>self.MAX_TEXT_CHARS:raise ValueError('asr_text_limit')
            return value
        def append_final(value):
            if value:combined(value);finals.append(value)
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
            # Only an explicitly advertised worker capability enables this.
            # Legacy brokers/workers keep the bounded segment coalescing path.
            if reply.get('manual_endpoint_supported') is True:
                configured=request('reset',manual_endpoint=True)
                if configured.get('type')!='reset' or configured.get('manual_endpoint') is not True:
                    raise RuntimeError('asr_manual_endpoint_not_enabled')
            while not span.cancel.is_set():
                if time.monotonic()-span.created>20:raise TimeoutError('asr_lease_limit')
                raw,done=span.take()
                if span.cancel.is_set():raise TimeoutError('asr_cancelled')
                if raw:
                    pending_audio=True
                    reply=request('feed',pcm16_base64=base64.b64encode(raw).decode())
                    kind=reply.get('type');last=text_value(reply)
                    if kind not in ('partial','final'):raise ValueError('asr_reply_type')
                    if kind=='final':
                        # Native endpoints finish ONE segment and reset its
                        # decoder. The broker connection and this controller
                        # utterance remain open: more voiced frames can follow.
                        append_final(last);pending_audio=False
                        if last:on_partial(combined())
                    elif last:on_partial(combined(last))
                if done:
                    if span.cancel.is_set():raise TimeoutError('asr_cancelled')
                    reply=request('finish');last=text_value(reply)
                    if reply.get('type')!='final':raise ValueError('asr_finish_type')
                    if span.cancel.is_set():raise TimeoutError('asr_cancelled')
                    # A terminal snapshot can repeat the last endpoint when
                    # no new audio followed it. Repeated real speech with new
                    # frames is retained as a separate segment.
                    if last and (pending_audio or not finals or last!=finals[-1]):append_final(last)
                    return combined()
            raise TimeoutError('asr_cancelled')
        finally:connection.close()
