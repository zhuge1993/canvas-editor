#!/usr/bin/env python3
"""Actual socket-stream broker contracts with a fake native backend.

This verifies routing, bounds, isolation, recovery and backpressure only.
It does not verify native ASR, model accuracy, Linux socket permissions,
private SDK execution, thermal sensors or OpenRC startup.
"""
import base64
import importlib.util
import json
from pathlib import Path
import socket
import sys
import threading
import time
import types
import unittest

if sys.platform=='win32':
    sys.modules.setdefault('grp',types.SimpleNamespace())
    sys.modules.setdefault('resource',types.SimpleNamespace())
spec=importlib.util.spec_from_file_location('broker_under_test',Path(__file__).resolve().parent.parent/'runtime/asr-broker.py')
broker=importlib.util.module_from_spec(spec);spec.loader.exec_module(broker)

class FakeWorker:
    def __init__(self):self.text='';self.calls=[];self.stopped=False
    def rpc(self,message):
        self.calls.append(message['op'])
        op=message['op']
        if op=='reset':self.text='';return {'type':'reset'}
        if op=='ping':return {'type':'pong','max_rss_kib':1}
        if op=='feed':
            raw=base64.b64decode(message['pcm16_base64']);self.text+=chr(raw[0])
            return {'type':'partial','text':self.text,'max_rss_kib':1}
        if op=='finish':return {'type':'final','text':self.text,'reason':'explicit_eos','max_rss_kib':1}
        raise AssertionError(op)
    def summary(self):return {'worker_pid':1234,'model_load_count':1,'stderr_retained_bytes':0}
    def stop(self):self.stopped=True

class Peer:
    def __init__(self,service):
        self.socket,server=socket.socketpair();self.socket.settimeout(3);self.buffer=bytearray()
        assert service.slots.acquire(False)
        thread=threading.Thread(target=service._client,args=(server,),daemon=True)
        with service.condition:service.connections.add(server);service.threads.add(thread)
        thread.start();self.thread=thread
        assert self.read()['type']=='queued'
    def read(self):
        while b'\n' not in self.buffer:
            chunk=self.socket.recv(65536)
            if not chunk:raise EOFError
            self.buffer.extend(chunk)
        raw,_,remaining=self.buffer.partition(b'\n');self.buffer=bytearray(remaining);return json.loads(raw)
    def send(self,message):self.socket.sendall((json.dumps(message)+'\n').encode())
    def close(self):self.socket.close();self.thread.join(timeout=3)

class Contracts(unittest.TestCase):
    def setUp(self):
        self.backend=FakeWorker();self.service=broker.Broker({'model_name':'fake_backend_only','threads':4},worker=self.backend,temperature_reader=lambda:40)
        self.peers=[]
    def peer(self,ready=True):
        peer=Peer(self.service);self.peers.append(peer)
        if ready:self.assertEqual(peer.read()['type'],'ready_session')
        return peer
    def tearDown(self):
        self.service.stop()
        for peer in self.peers:peer.close()
    def feed(self,peer,marker='A',samples=1):
        raw=bytes([ord(marker),0])*samples;peer.send({'op':'feed','id':'x','pcm16_base64':base64.b64encode(raw).decode()});return peer.read()

    def test_disconnect_clears_previous_audio_for_next_client(self):
        first=self.peer();self.assertEqual(self.feed(first)['text'],'A');first.close()
        second=self.peer();self.assertEqual(self.feed(second,'B')['text'],'B')
        second.send({'op':'finish','id':'finish'});self.assertEqual(second.read()['text'],'B')

    def test_forbidden_quit_does_not_stop_global_worker(self):
        bad=self.peer();bad.send({'op':'quit','id':'q'});self.assertEqual(bad.read()['code'],'forbidden_operation');bad.close()
        self.assertFalse(self.backend.stopped)
        good=self.peer();good.send({'op':'ping','id':'p'});self.assertEqual(good.read()['type'],'pong')

    def test_bad_pcm_closes_session_then_next_session_recovers(self):
        bad=self.peer();bad.send({'op':'feed','pcm16_base64':'bad!'});self.assertEqual(bad.read()['code'],'invalid_pcm16');bad.close()
        good=self.peer();self.assertEqual(self.feed(good,'C')['text'],'C')

    def test_oversize_json_is_rejected_without_parsing(self):
        bad=self.peer()
        try:bad.socket.sendall(b'{"x":"'+b'x'*70000+b'"}\n')
        except OSError:pass
        self.assertEqual(bad.read()['code'],'frame_limit');bad.close()
        good=self.peer();self.assertEqual(self.feed(good,'D')['text'],'D')

    def test_deep_json_is_rejected_before_json_parser(self):
        bad=self.peer();bad.socket.sendall(b'['*9+b'0'+b']'*9+b'\n');self.assertEqual(bad.read()['code'],'invalid_bounded_json')

    def test_audio_budget_cannot_be_reset_by_native_endpoints(self):
        peer=self.peer()
        for _ in range(30):self.assertEqual(self.feed(peer,samples=16000)['type'],'partial')
        self.assertEqual(self.feed(peer,samples=1)['code'],'audio_limit')

    def test_idle_client_releases_queue(self):
        previous=broker.IDLE_SECONDS;broker.IDLE_SECONDS=.15
        try:
            idle=self.peer();next_peer=self.peer(False)
            self.assertEqual(idle.read()['code'],'idle_timeout')
            self.assertEqual(next_peer.read()['type'],'ready_session')
            next_peer.send({'op':'ping','id':'p'});self.assertEqual(next_peer.read()['type'],'pong')
        finally:broker.IDLE_SECONDS=previous

    def test_thermal_pause_does_not_feed_or_stop_model(self):
        self.service.temperature_reader=lambda:66
        peer=self.peer();self.assertEqual(peer.read()['code'],'thermal_pause')
        self.assertNotIn('feed',self.backend.calls);self.assertFalse(self.backend.stopped)
        peer.close();self.service.temperature_reader=lambda:40
        good=self.peer();self.assertEqual(self.feed(good,'E')['text'],'E')

    def test_fifo_only_one_client_can_feed_at_a_time(self):
        one=self.peer();two=self.peer(False)
        until=time.monotonic()+1
        while len(self.service.waiting)<1 and time.monotonic()<until:time.sleep(.01)
        three=self.peer(False)
        self.assertEqual(self.feed(one,'A')['text'],'A');one.close()
        self.assertEqual(two.read()['type'],'ready_session');self.assertEqual(self.feed(two,'B')['text'],'B');two.close()
        self.assertEqual(three.read()['type'],'ready_session');self.assertEqual(self.feed(three,'C')['text'],'C')

if __name__=='__main__':unittest.main(verbosity=2)
