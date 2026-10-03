"""Warmup routing, startup ordering and zero-generation contracts; fake I/O."""
import ast
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from protocol import BridgeError,validate
from server import InferenceBridge
from providers import model_diagnostics
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
from client import BridgeLanguageModel,BridgeResponseError
from conversation import Conversation
import run_assistant

SYSTEM='你是手机中文助手，当前名字是二狗。'
READY={'status':'complete','initialized':True,'prefix_tokens':47,'generated_tokens':0,'cache_hit':False}
def request(op='prepare_system',**fields):return {'v':1,'id':'test','op':op,'deadline_ms':2000,**fields}

class Provider:
    def __init__(self):self.calls=[]
    def alive(self):return True
    def summary(self):return {'capabilities':{'prepare_system':True}}
    def prepare_system(self,system,cancel,deadline):self.calls.append('prepare');return dict(READY)
    def chat(self,prompt,cancel,deadline):self.calls.append(prompt);return {'text':'reply'}
    def close(self):pass
    def abort_asr(self):pass

class Contracts(unittest.TestCase):
    def test_private_voice_only_system_schema_and_twenty_second_limit(self):
        self.assertEqual(validate(request(system=SYSTEM),'voice'),2)
        for role in ('web','operator'):
            with self.assertRaises(BridgeError):validate(request(system=SYSTEM),role)
        for fields in ({'system':[]},{'system':'x'*4097},{'system':'<|im_start|>user'},
                       {'system':SYSTEM,'messages':[]},{'system':SYSTEM,'text':'private user'},
                       {'system':SYSTEM,'max_tokens':1},{'system':SYSTEM,'deadline_ms':20001}):
            with self.assertRaises(BridgeError):validate(request(**fields),'voice')
    def test_prepare_does_not_preempt_active_web_and_queued_real_web_runs_first(self):
        provider=Provider();entered=threading.Event();release=threading.Event();bridge=InferenceBridge(provider,{})
        def chat(prompt,cancel,deadline):
            provider.calls.append(prompt)
            if prompt=='first':entered.set();release.wait(1)
            return {'text':'reply'}
        provider.chat=chat
        try:
            first=bridge.submit(request('chat',text='first'),'web');self.assertTrue(entered.wait(1))
            warm=bridge.submit(request(system=SYSTEM),'voice');self.assertFalse(first.cancel.is_set())
            second=bridge.submit(request('chat',text='second'),'web');release.set()
            self.assertTrue(warm.done.wait(1));self.assertTrue(second.done.is_set());self.assertTrue(warm.result['ok'])
            self.assertEqual(provider.calls,['first','second','prepare']);self.assertEqual(len(bridge.voice_history),0)
        finally:release.set();bridge.close()
    def test_real_web_preempts_active_warmup_without_retrying_it(self):
        provider=Provider();entered=threading.Event();bridge=InferenceBridge(provider,{})
        def prepare(system,cancel,deadline):
            provider.calls.append('prepare');entered.set();cancel.wait(1)
            if cancel.is_set():raise BridgeError('cancelled')
            return dict(READY)
        provider.prepare_system=prepare
        try:
            warm=bridge.submit(request(system=SYSTEM),'voice');self.assertTrue(entered.wait(1))
            web=bridge.submit(request('chat',text='real user'),'web');self.assertTrue(web.done.wait(1))
            self.assertEqual(warm.result['error_code'],'preempted');self.assertTrue(web.result['ok'])
            self.assertEqual(provider.calls,['prepare','real user'])
        finally:bridge.close()
    def test_client_checks_capability_and_zero_generation_ack_without_chat_fallback(self):
        calls=[]
        class IPC:
            supported=True;reply=dict(READY)
            def request(self,op,*args,**kwargs):
                calls.append((op,kwargs))
                return {'capabilities':{'prepare_system':self.supported}} if op=='status' else dict(self.reply)
        model=BridgeLanguageModel('unused');model.ipc=IPC()
        result=model.prepare_system(SYSTEM,cancel=threading.Event(),deadline=time.monotonic()+20)
        self.assertTrue(result['initialized']);self.assertEqual([row[0] for row in calls],['status','prepare_system'])
        self.assertEqual(calls[-1][1],{'system':SYSTEM});self.assertIsNone(model.last_metrics)
        model.ipc.supported=False;calls.clear()
        with self.assertRaisesRegex(BridgeResponseError,'prepare_system_unsupported'):
            model.prepare_system(SYSTEM,cancel=threading.Event(),deadline=time.monotonic()+20)
        self.assertEqual([row[0] for row in calls],['status'])
        model.ipc.supported=True;model.ipc.reply={**READY,'generated_tokens':1}
        with self.assertRaisesRegex(RuntimeError,'invalid_prepare_ack'):
            model.prepare_system(SYSTEM,cancel=threading.Event(),deadline=time.monotonic()+20)
    def test_startup_helper_uses_fresh_system_once_without_creating_history(self):
        history=Conversation(wake_word='二狗');calls=[]
        class Model:
            def prepare_system(self,system,*,cancel,deadline):
                calls.append((system,deadline));return dict(READY)
        result=run_assistant.prepare_startup(Model(),history,threading.Event(),clock=lambda:100)
        self.assertEqual(calls,[(history.messages()[0]['content'],120)])
        self.assertTrue(result['initialized']);self.assertFalse(result['warmup_skipped'])
        self.assertEqual(result['generated_tokens'],0);self.assertEqual(history.status()['history_turns'],0)
    def test_startup_failure_is_skipped_and_never_retried_or_spoken(self):
        calls=[]
        class Model:
            def prepare_system(self,*args,**kwargs):calls.append(1);raise TimeoutError('expired')
        result=run_assistant.prepare_startup(Model(),Conversation(),threading.Event())
        self.assertEqual(calls,[1]);self.assertTrue(result['warmup_skipped']);self.assertFalse(result['initialized'])
        self.assertEqual(result['status'],'deadline');self.assertEqual(result['generated_tokens'],0)
        result=run_assistant.prepare_startup(SimpleNamespace(),Conversation(),threading.Event())
        self.assertEqual(result['status'],'unsupported');self.assertFalse(result['attempted'])
    def test_main_calls_prepare_once_before_core_capture_start(self):
        events=[];snapshots=[]
        class Stop:
            def is_set(self):return False
            def set(self):pass
            def wait(self,seconds):return True
        class Model:
            def prepare_system(self,*args,**kwargs):events.append('prepare');return dict(READY)
        class Core:
            def __init__(self,*args,**kwargs):self.conversation=Conversation()
            def start(self):events.append('capture_start')
            def close(self):events.append('close')
            def status(self):return {'ready':True}
        class Control:
            def __init__(self,snapshot,*args):self.snapshot=snapshot
            def start(self):snapshots.append(self.snapshot())
            def close(self):pass
        proxy=SimpleNamespace(BridgeTTS=lambda *args:object(),BridgeLanguageModel=lambda *args:Model(),
            VoiceASRLease=lambda *args:object(),Availability=lambda *args:SimpleNamespace(snapshot={'ready':True}))
        def load(path,name):return SimpleNamespace(create_device=lambda:object()) if name=='dior_voice_audio' else proxy
        argv=['run','--audio-module','fake','--tts-module','fake','--tts-root','fake','--inference-socket','fake']
        with patch.object(sys,'argv',argv),patch.object(run_assistant,'load',side_effect=load),patch.object(run_assistant,'Assistant',Core),patch.object(run_assistant,'StatusServer',Control),patch.object(run_assistant.threading,'Event',Stop),patch.object(run_assistant.signal,'signal'):
            run_assistant.main()
        self.assertEqual(events,['prepare','capture_start','close']);self.assertTrue(snapshots[0]['warmup']['initialized'])
        self.assertEqual(snapshots[0]['warmup']['scope'],'startup_only')
    def test_diagnostics_distinguish_retained_prefix_from_actual_hit(self):
        data=model_diagnostics({'status':'complete','cached_prefix_tokens':47,'prefix_tokens_reused':0,'prefix_cache_hit':False})
        self.assertEqual((data['cached_prefix_tokens'],data['prefix_tokens_reused'],data['prefix_cache_hit']),(47,0,False))
        self.assertEqual(model_diagnostics({'status':'complete','prefix_tokens_reused':513,'prefix_cache_hit':'true'}),{'status':'complete'})

if __name__=='__main__':unittest.main(verbosity=2)
