"""Real socket contracts: AF_UNIX on Linux, loopback TCP on Windows builds."""
import base64
import json
from pathlib import Path
import select
import socket
import struct
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import asr_stream
from asr_stream import Span,StreamingASR
from interfaces import AudioFrame


def pcm(value):return struct.pack('<h',value)*320


class ASRServer:
    def __init__(self,script,capability=None):
        self.folder=tempfile.TemporaryDirectory(prefix='dvasr-');self.path=Path(self.folder.name)/'asr.sock'
        self.unix=hasattr(socket,'AF_UNIX');family=socket.AF_UNIX if self.unix else socket.AF_INET
        self.listener=socket.socket(family,socket.SOCK_STREAM)
        self.listener.bind(str(self.path) if self.unix else ('127.0.0.1',0));self.listener.listen(1)
        self.path=str(self.path) if self.unix else self.listener.getsockname()
        self.transport=None
        if not self.unix:
            # Only the family/address adapt on this Windows Python. All bytes,
            # blocking receives, buffering, ordering and closes use real TCP.
            self.transport=patch.object(asr_stream,'socket',SimpleNamespace(AF_UNIX=socket.AF_INET,
                SOCK_STREAM=socket.SOCK_STREAM,socket=socket.socket,timeout=socket.timeout))
        self.listener.settimeout(2);self.script=script;self.capability=capability;self.errors=[];self.requests=[];self.connection=None
        self.thread=threading.Thread(target=self.run,daemon=True);self.thread.start()
    def run(self):
        try:
            with self.listener.accept()[0] as connection:
                self.connection=connection;connection.settimeout(2)
                self.stream=connection.makefile('rb')
                try:
                    self.send({'type':'queued'});ready={'type':'ready_session'}
                    if self.capability is not None:ready['manual_endpoint_supported']=self.capability
                    self.send(ready);self.script(self)
                finally:self.stream.close()
        except BaseException as error:self.errors.append(error)
    def send(self,value):self.connection.sendall((json.dumps(value,ensure_ascii=False)+'\n').encode('utf8'))
    def receive(self):
        line=self.stream.readline()
        if not line:return None
        value=json.loads(line);self.requests.append(value);return value
    def reply(self,request,kind,text):self.send({'id':request['id'],'type':kind,'text':text})
    def client(self):return StreamingASR(self.path)
    def __enter__(self):
        if self.transport:self.transport.start()
        return self
    def __exit__(self,*args):
        self.thread.join(2);self.listener.close()
        if self.connection:
            try:self.connection.close()
            except OSError:pass
        self.folder.cleanup()
        if self.transport:self.transport.stop()
        if self.thread.is_alive():raise AssertionError('fake socket server did not stop')
        if self.errors:raise self.errors[0]


class Segments(unittest.TestCase):
    def span(self,count=1,closed=False):
        span=Span(1,'dialog',time.monotonic(),[pcm(index+1) for index in range(count)],15)
        if closed:span.finish()
        return span
    def test_voiced_early_final_does_not_send_finish_or_drop_later_question(self):
        span=self.span();partials=[]
        def script(server):
            first=server.receive();self.assertEqual(first['op'],'feed')
            server.reply(first,'final','你')
            # There is no new audio yet. An endpoint must not close the lease.
            self.assertFalse(select.select([server.connection],[],[],.03)[0])
            self.assertTrue(span.push(AudioFrame(pcm(2),True,time.monotonic()),True));span.finish()
            second=server.receive();self.assertEqual(second['op'],'feed')
            self.assertEqual(base64.b64decode(second['pcm16_base64']),pcm(2))
            server.reply(second,'partial','叫什么')
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','叫什么名字')
        with ASRServer(script) as server:
            result=server.client().recognize(span,partials.append)
        self.assertEqual(result,'你 叫什么名字');self.assertEqual(partials,['你','你 叫什么'])
        self.assertEqual([row['op'] for row in server.requests],['feed','feed','finish'])
    def test_empty_early_final_also_waits_for_remaining_same_span_audio(self):
        span=self.span()
        def script(server):
            first=server.receive();server.reply(first,'final','')
            self.assertFalse(select.select([server.connection],[],[],.03)[0])
            span.push(AudioFrame(pcm(2),True,time.monotonic()),True);span.finish()
            second=server.receive();self.assertEqual(second['op'],'feed');server.reply(second,'partial','你叫什么名字')
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','你叫什么名字')
        with ASRServer(script) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(result,'你叫什么名字')
    def test_multiple_final_segments_preserve_order_and_terminal_duplicate_is_not_added(self):
        span=self.span(21,closed=True)
        def script(server):
            for text in ('第一段','第二段','第三段'):
                feed=server.receive();self.assertEqual(feed['op'],'feed');server.reply(feed,'final',text)
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','第三段')
        with ASRServer(script) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(result,'第一段 第二段 第三段')
        self.assertEqual(sum(row['op']=='finish' for row in server.requests),1)
    def test_real_repeated_speech_with_new_frames_is_not_deduplicated(self):
        span=self.span(11,closed=True)
        def script(server):
            server.reply(server.receive(),'final','你好')
            server.reply(server.receive(),'partial','你好')
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','你好')
        with ASRServer(script) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(result,'你好 你好')
    def test_nonempty_remaining_finish_text_is_preserved_after_endpoint(self):
        span=self.span(closed=True)
        def script(server):
            server.reply(server.receive(),'final','第一段')
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','结束的剩余文字')
        with ASRServer(script) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(result,'第一段 结束的剩余文字')
    def test_cancel_after_a_segment_discards_entire_utterance_and_does_not_finish(self):
        span=self.span();partial=[]
        def cancel(text):partial.append(text);span.abort()
        def script(server):
            server.reply(server.receive(),'final','不应执行的半句')
            self.assertIsNone(server.receive())
        with ASRServer(script) as server:
            with self.assertRaisesRegex(TimeoutError,'asr_cancelled'):server.client().recognize(span,cancel)
        self.assertEqual(partial,['不应执行的半句']);self.assertEqual(len(server.requests),1)
    def test_cancel_during_terminal_reply_does_not_return_previously_accumulated_text(self):
        span=self.span(closed=True)
        def script(server):
            server.reply(server.receive(),'partial','候选文字')
            finish=server.receive();self.assertEqual(finish['op'],'finish');span.abort();server.reply(finish,'final','候选文字')
        with ASRServer(script) as server:
            with self.assertRaisesRegex(TimeoutError,'asr_cancelled'):server.client().recognize(span,lambda _:None)
    def test_aggregate_text_limit_fails_closed_without_truncated_command(self):
        span=self.span(21,closed=True)
        def script(server):
            for text in ('甲'*200,'乙'*200,'丙'*200):server.reply(server.receive(),'final',text)
            self.assertIsNone(server.receive())
        with ASRServer(script) as server:
            with self.assertRaisesRegex(ValueError,'asr_text_limit'):server.client().recognize(span,lambda _:None)
        self.assertFalse(any(row['op']=='finish' for row in server.requests))
    def test_512_character_bound_includes_separator_and_allows_exact_limit(self):
        span=self.span(closed=True)
        def script(server):
            server.reply(server.receive(),'final','甲'*255)
            server.reply(server.receive(),'final','乙'*256)
        with ASRServer(script) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(len(result),512);self.assertEqual(result,'甲'*255+' '+'乙'*256)
    def test_revised_partial_snapshot_is_not_appended_as_an_extra_final(self):
        span=self.span(21,closed=True);partials=[]
        def script(server):
            for text in ('你叫','你叫什么','你叫什么名字'):server.reply(server.receive(),'partial',text)
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','你叫什么名字')
        with ASRServer(script) as server:result=server.client().recognize(span,partials.append)
        self.assertEqual(result,'你叫什么名字');self.assertEqual(partials,['你叫','你叫什么','你叫什么名字'])
    def test_supported_worker_is_configured_before_any_audio_then_finishes_once(self):
        span=self.span(11,closed=True)
        def script(server):
            reset=server.receive();self.assertEqual(reset['op'],'reset');self.assertIs(reset['manual_endpoint'],True)
            server.send({'id':reset['id'],'type':'reset','manual_endpoint':True})
            for text in ('你','你叫什么名字'):
                feed=server.receive();self.assertEqual(feed['op'],'feed');server.reply(feed,'partial',text)
            finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','你叫什么名字')
        with ASRServer(script,capability=True) as server:result=server.client().recognize(span,lambda _:None)
        self.assertEqual(result,'你叫什么名字')
        self.assertEqual([row['op'] for row in server.requests],['reset','feed','feed','finish'])
    def test_legacy_or_unproven_capability_never_sends_new_native_option(self):
        for capability in (None,False,0,1,'true'):
            span=self.span(closed=True)
            def script(server):
                feed=server.receive();self.assertEqual(feed['op'],'feed');server.reply(feed,'partial','完整文字')
                finish=server.receive();self.assertEqual(finish['op'],'finish');server.reply(finish,'final','完整文字')
            with ASRServer(script,capability=capability) as server:result=server.client().recognize(span,lambda _:None)
            self.assertEqual(result,'完整文字');self.assertFalse(any(row['op']=='reset' for row in server.requests))
    def test_manual_reset_without_positive_ack_fails_before_feeding_audio(self):
        for acknowledgement in ({'type':'reset'}, {'type':'reset','manual_endpoint':False}, {'type':'reset','manual_endpoint':1}):
            span=self.span(closed=True)
            def script(server):
                reset=server.receive();self.assertEqual(reset['op'],'reset')
                server.send({'id':reset['id'],**acknowledgement});self.assertIsNone(server.receive())
            with ASRServer(script,capability=True) as server:
                with self.assertRaisesRegex(RuntimeError,'asr_manual_endpoint_not_enabled'):
                    server.client().recognize(span,lambda _:None)
            self.assertEqual(len(server.requests),1)


if __name__=='__main__':
    print(json.dumps({'socket_transport':'AF_UNIX' if hasattr(socket,'AF_UNIX') else 'loopback_TCP',
                      'fake_asr_server':True,'phone_or_human_audio_tested':False}))
    unittest.main(verbosity=2)
