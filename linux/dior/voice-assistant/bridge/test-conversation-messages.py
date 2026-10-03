"""Structured voice conversation isolation and native-adapter compatibility."""
import copy
import json
from pathlib import Path
import sys
import threading
import time
from types import SimpleNamespace
import unittest
from protocol import BridgeError,validate,validate_messages
from providers import Providers,model_diagnostics
from server import InferenceBridge
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))

MESSAGES=[{'role':'system','content':'当前助手叫二狗。'},
          {'role':'user','content':'记住苹果'},
          {'role':'assistant','content':'好的，苹果。'},
          {'role':'user','content':'刚才说了什么'}]

def request(**values):return {'v':1,'id':'test','op':'chat','deadline_ms':2000,**values}


class FakeProvider:
    def __init__(self):self.messages=[];self.prompts=[]
    def alive(self):return True
    def summary(self):return {'model_load_count':1}
    def chat_messages(self,messages,cancel,deadline):self.messages.append(copy.deepcopy(messages));return {'text':'苹果'}
    def chat(self,prompt,cancel,deadline):self.prompts.append(prompt);return {'text':'网页回答'}
    def close(self):pass
    def abort_asr(self):pass


class Contracts(unittest.TestCase):
    def wait(self,predicate):
        end=time.monotonic()+1
        while not predicate() and time.monotonic()<end:time.sleep(.002)
        self.assertTrue(predicate())
    def test_voice_accepts_exact_ordered_roles_without_flattening(self):
        data=request(messages=copy.deepcopy(MESSAGES));self.assertEqual(validate(data,'voice'),2)
        self.assertEqual(data['messages'],MESSAGES)
    def test_web_and_operator_cannot_supply_system_or_history(self):
        for role in ('web','operator'):
            with self.assertRaises(BridgeError):validate(request(messages=MESSAGES),'%s'%role)
        with self.assertRaises(BridgeError):validate(request(text='web',system='secret'),'web')
        with self.assertRaises(BridgeError):validate(request(text='web',history=MESSAGES),'web')
    def test_mixed_payload_and_malformed_roles_are_rejected(self):
        malformed=[[],MESSAGES[1:],MESSAGES[:-1],
            [MESSAGES[0],{'role':'tool','content':'result'}],
            [MESSAGES[0],MESSAGES[1],MESSAGES[-1]],
            [MESSAGES[0],{'role':'user','content':'x','tool_calls':[]}],
            [MESSAGES[0],{'role':'user','content':''}],
            [MESSAGES[0],{'role':'user','content':'a\x00b'}]]
        for messages in malformed:
            with self.subTest(messages=messages):
                with self.assertRaises(BridgeError):validate(request(messages=messages),'voice')
        for extra in ({'text':'same'},{'context':'secret'}):
            with self.assertRaises(BridgeError):validate(request(messages=MESSAGES,**extra),'voice')
    def test_message_count_utf8_bytes_and_chat_frame_are_bounded(self):
        too_many=[MESSAGES[0]]+[{'role':'user' if n%2==0 else 'assistant','content':'x'} for n in range(13)]
        with self.assertRaises(BridgeError):validate(request(messages=too_many),'voice')
        with self.assertRaises(BridgeError):validate(request(messages=[MESSAGES[0],{'role':'user','content':'中'*2800}]),'voice')
        # JSON escaping can exceed frame size while content bytes stay <8KiB.
        with self.assertRaises(BridgeError):validate(request(messages=[MESSAGES[0],{'role':'user','content':'\x01'*4000}]),'voice')
        self.assertLessEqual(validate_messages(MESSAGES),8192)
    def test_scheduler_never_adds_unplayed_messages_to_legacy_history(self):
        fake=FakeProvider();bridge=InferenceBridge(fake,{})
        try:
            bridge.voice_history.append(('legacy-private','legacy-answer'))
            job=bridge.submit(request(messages=MESSAGES),'voice');self.assertTrue(job.done.wait(1));self.assertTrue(job.result['ok'])
            self.assertEqual(fake.messages,[MESSAGES]);self.assertEqual(list(bridge.voice_history),[('legacy-private','legacy-answer')])
            job=bridge.submit(request(text='web question',context='allowed web data'),'web');self.assertTrue(job.done.wait(1));self.assertTrue(job.result['ok'])
            self.assertNotIn('苹果',fake.prompts[-1]);self.assertNotIn('legacy-private',fake.prompts[-1])
            with self.assertRaises(BridgeError):bridge.submit(request(messages=MESSAGES),'web')
        finally:bridge.close()
    def provider(self):
        provider=Providers.__new__(Providers);provider.diagnostics_lock=threading.Lock()
        provider.last_model_diagnostics={'status':'not_run'};provider.last_error_type='none'
        provider.model=SimpleNamespace(last_metrics=None,clear_history=lambda:None)
        return provider
    def test_modern_adapter_gets_roles_and_full_bounded_metrics(self):
        provider=self.provider();seen=[]
        def generate(messages,*,cancel,deadline):
            seen.append(copy.deepcopy(messages));provider.model.last_metrics={'status':'complete','input_tokens':900,'generated_tokens':128}
            return SimpleNamespace(text='苹果')
        provider.model.generate_messages=generate
        result=provider.chat_messages(MESSAGES,threading.Event(),time.monotonic()+2)
        self.assertEqual(seen,[MESSAGES]);self.assertEqual(result['text'],'苹果')
        self.assertEqual(result['metrics']['generated_tokens'],128);self.assertEqual(result['metrics']['input_tokens'],900)
    def test_legacy_adapter_is_explicitly_unsupported_for_messages_but_text_still_works(self):
        provider=self.provider();seen=[]
        def legacy(prompt,**kwargs):seen.append(prompt);return SimpleNamespace(text='旧网页回答')
        provider.model.generate=legacy
        with self.assertRaisesRegex(BridgeError,'messages_unsupported'):
            provider.chat_messages(MESSAGES,threading.Event(),time.monotonic()+2)
        self.assertFalse(seen)
        self.assertEqual(provider.chat('网页问题',threading.Event(),time.monotonic()+2)['text'],'旧网页回答')
        self.assertEqual(seen,['网页问题'])
    def test_native_cancellation_never_becomes_success(self):
        provider=self.provider();cancel=threading.Event()
        def cancelled(*args,**kwargs):cancel.set();return SimpleNamespace(text='late')
        provider.model.generate_messages=cancelled
        with self.assertRaisesRegex(BridgeError,'cancelled'):provider.chat_messages(MESSAGES,cancel,time.monotonic()+2)
    def test_client_keeps_explicit_roles_and_does_not_send_extra_text(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
        from client import BridgeLanguageModel
        model=BridgeLanguageModel('unused');seen=[]
        class FakeIPC:
            def request(self,op,*args,**kwargs):
                seen.append((op,kwargs))
                return {'capabilities':{'chat_messages':True}} if op=='status' else {'text':'你好','metrics':{'status':'complete'}}
        model.ipc=FakeIPC();reply=model.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
        self.assertEqual(seen,[('status',{}),('chat',{'messages':MESSAGES})]);self.assertEqual(reply.text,'你好')
        self.assertEqual(model.mode,'structured_history')
    def test_native_diagnostics_remain_numeric_and_private(self):
        self.assertEqual(model_diagnostics({'status':'complete','input_tokens':1025,'generated_tokens':129,'prompt':'secret'}),{'status':'complete'})
    def test_failure_speech_uses_only_qualified_local_cache_without_any_ipc(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
        from client import BridgeTTS
        phrase='这次没有及时回答，请再问一次。';clip=SimpleNamespace(pcm16=bytes(640),sample_rate=16000)
        class NoIPC:
            def request(self,*args,**kwargs):raise AssertionError('fallback must not call shared service')
        tts=BridgeTTS.__new__(BridgeTTS);tts.ipc=NoIPC();tts.fixed=SimpleNamespace(audio={phrase:clip})
        self.assertIs(tts.synthesize_failure(threading.Event()),clip)
        cancel=threading.Event();cancel.set()
        with self.assertRaises(TimeoutError):tts.synthesize_failure(cancel)
        tts.fixed=None
        with self.assertRaisesRegex(RuntimeError,'failure_cache_unavailable'):tts.synthesize_failure(threading.Event())
    def test_explicit_message_adapter_keeps_checkpoint_across_voice_and_web_calls(self):
        provider=self.provider();clears=[];calls=[];provider.model.explicit_messages=True
        provider.model.clear_history=lambda:clears.append(threading.current_thread().name)
        provider.model.generate_messages=lambda *args,**kwargs:(calls.append('voice') or SimpleNamespace(text='voice'))
        provider.model.generate=lambda *args,**kwargs:(calls.append('web') or SimpleNamespace(text='web'))
        provider.chat_messages(MESSAGES,threading.Event(),time.monotonic()+1)
        provider.chat('web',threading.Event(),time.monotonic()+1)
        self.assertEqual(calls,['voice','web']);self.assertFalse(clears)
        provider.clear_history();self.assertEqual(len(clears),1)
    def test_clear_during_active_web_runs_later_on_worker_before_new_voice(self):
        fake=FakeProvider();entered=threading.Event();release=threading.Event()
        clear_entered=threading.Event();clear_release=threading.Event();events=[]
        def web(prompt,cancel,deadline):
            events.append(('web_begin',threading.current_thread().name));entered.set();release.wait(1)
            events.append(('web_end',threading.current_thread().name));return {'text':'web'}
        def clear():
            events.append(('clear_begin',threading.current_thread().name));clear_entered.set();clear_release.wait(1)
            events.append(('clear_end',threading.current_thread().name))
        def voice(messages,cancel,deadline):events.append(('voice',threading.current_thread().name));return {'text':'voice'}
        fake.chat=web;fake.clear_history=clear;fake.chat_messages=voice;bridge=InferenceBridge(fake,{})
        try:
            web_job=bridge.submit(request(text='web'),'web');self.assertTrue(entered.wait(1))
            begin=time.monotonic();bridge.control(request(op='clear_history'),'voice')
            self.assertLess(time.monotonic()-begin,.05);self.assertFalse(clear_entered.is_set())
            self.assertFalse(web_job.cancel.is_set()) # Clear alone never preempts web.
            voice_job=bridge.submit(request(messages=MESSAGES),'voice');release.set();self.assertTrue(clear_entered.wait(1))
            self.assertFalse(voice_job.done.is_set())
            acquired=bridge.condition.acquire(timeout=.02);self.assertTrue(acquired)
            if acquired:bridge.condition.release()
            clear_release.set();self.assertTrue(voice_job.done.wait(1));self.assertTrue(voice_job.result['ok'])
            self.assertEqual([event[0] for event in events],['web_begin','web_end','clear_begin','clear_end','voice'])
            self.assertTrue(all(event[1]=='inference-worker' for event in events))
        finally:release.set();clear_release.set();bridge.close()
    def test_idle_clear_wakes_worker_and_multiple_clear_epochs_are_not_lost(self):
        fake=FakeProvider();entered=threading.Event();release=threading.Event();clears=[]
        def clear():
            clears.append(threading.current_thread().name)
            if len(clears)==1:entered.set();release.wait(1)
        fake.clear_history=clear;bridge=InferenceBridge(fake,{})
        try:
            bridge.control(request(op='clear_history'),'voice');self.assertTrue(entered.wait(1))
            bridge.control(request(op='clear_history'),'voice');release.set()
            self.wait(lambda:bridge.cleared_epoch==2)
            self.assertEqual(clears,['inference-worker','inference-worker'])
            self.assertFalse(bridge.cache_clearing);self.assertFalse(bridge.cache_clear_error)
        finally:release.set();bridge.close()
    def test_clear_cancels_old_active_and_queued_voice_before_new_checkpoint(self):
        fake=FakeProvider();entered=threading.Event();events=[]
        def voice(messages,cancel,deadline):
            if not events:
                events.append('old');entered.set()
                if not cancel.wait(1):raise AssertionError('clear did not cancel old voice')
                raise BridgeError('cancelled')
            events.append('new');return {'text':'new'}
        fake.chat_messages=voice;fake.clear_history=lambda:events.append('clear');bridge=InferenceBridge(fake,{})
        try:
            old=bridge.submit(request(messages=MESSAGES),'voice');self.assertTrue(entered.wait(1))
            queued=bridge.submit(request(messages=MESSAGES),'voice')
            bridge.control(request(op='clear_history'),'voice')
            current=bridge.submit(request(messages=MESSAGES),'voice')
            self.assertTrue(current.done.wait(1));self.assertTrue(current.result['ok'])
            self.assertEqual(old.result['error_code'],'cancelled');self.assertEqual(queued.result['error_code'],'cancelled')
            self.assertEqual(events,['old','clear','new']);self.assertEqual(len(bridge.voice_history),0)
        finally:bridge.close()
    def test_failed_native_clear_does_not_spin_or_run_new_voice_until_retry(self):
        fake=FakeProvider();attempts=[]
        def clear():
            attempts.append(1)
            if len(attempts)==1:raise OSError('private clear failure')
        fake.clear_history=clear;bridge=InferenceBridge(fake,{})
        try:
            bridge.control(request(op='clear_history'),'voice');self.wait(lambda:bridge.cleared_epoch==1)
            self.assertTrue(bridge.cache_clear_error)
            failed=bridge.submit(request(messages=MESSAGES),'voice');self.assertTrue(failed.done.wait(1))
            self.assertEqual(failed.result['error_code'],'unavailable');self.assertFalse(fake.messages)
            time.sleep(.02);self.assertEqual(len(attempts),1)
            bridge.control(request(op='clear_history'),'voice');current=bridge.submit(request(messages=MESSAGES),'voice')
            self.assertTrue(current.done.wait(1));self.assertTrue(current.result['ok']);self.assertFalse(bridge.cache_clear_error)
            self.assertEqual(len(attempts),2)
        finally:bridge.close()
    def local_client(self,provider):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
        from client import BridgeLanguageModel,BridgeResponseError
        bridge=InferenceBridge(provider,{})
        class LocalIPC:
            def request(self,op,cancel=None,deadline=None,**payload):
                data=request(op=op,**payload);validate(data,'voice')
                if op in ('status','clear_history'):result=bridge.control(data,'voice')
                else:
                    job=bridge.submit(data,'voice')
                    if not job.done.wait(1):raise TimeoutError('contract worker timeout')
                    result=job.result
                if not result.get('ok'):raise BridgeResponseError(result.get('error_code'))
                return result
        client=BridgeLanguageModel('unused');client.ipc=LocalIPC()
        return client,bridge
    def legacy_provider(self):
        provider=self.provider();provider.asr_lock=threading.Lock();provider.asr_connection=None
        provider.asr_path='nonexistent-contract-asr.sock';provider.tts=SimpleNamespace();seen=[]
        provider.model.ready={'threads':3,'model_load_count':1};provider.model.process=SimpleNamespace(pid=123,poll=lambda:None)
        provider.model.close=lambda:None
        def generate(prompt,**kwargs):seen.append(prompt);return SimpleNamespace(text='旧模型回答')
        provider.model.generate=generate
        return provider,seen
    def test_new_shared_client_and_legacy_adapter_use_current_turn_without_false_history_claim(self):
        provider,seen=self.legacy_provider();client,bridge=self.local_client(provider)
        try:
            bridge.voice_history.append(('unheard-private','unheard-answer'))
            reply=client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertEqual(reply.text,'旧模型回答');self.assertEqual(client.mode,'legacy_current_turn')
            self.assertEqual(len(seen),1);self.assertIn(MESSAGES[-1]['content'],seen[0])
            self.assertNotIn('unheard-private',seen[0]);self.assertNotIn('苹果',seen[0]);self.assertNotIn('二狗',seen[0])
            self.assertEqual(bridge.cleared_epoch,1)
        finally:bridge.close()
    def test_service_recovery_rechecks_capability_and_upgrades_from_legacy_to_structured(self):
        provider,legacy_calls=self.legacy_provider();client,bridge=self.local_client(provider)
        try:
            real_ipc=client.ipc
            class Cold:
                def request(self,*args,**kwargs):raise FileNotFoundError('cold service')
            client.ipc=Cold()
            with self.assertRaises(FileNotFoundError):client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertEqual(client.mode,'unavailable');self.assertFalse(legacy_calls)
            client.ipc=real_ipc;client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertEqual(client.mode,'legacy_current_turn')
            modern_calls=[]
            provider.model.generate_messages=lambda messages,**kwargs:(modern_calls.append(copy.deepcopy(messages)) or SimpleNamespace(text='新模型回答'))
            provider.model.explicit_messages=True
            reply=client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertEqual(reply.text,'新模型回答');self.assertEqual(client.mode,'structured_history')
            self.assertEqual(modern_calls,[MESSAGES]);self.assertEqual(len(legacy_calls),1)
        finally:bridge.close()
    def test_modern_adapter_failure_is_not_hidden_by_a_legacy_retry(self):
        from client import BridgeResponseError
        provider,legacy_calls=self.legacy_provider();client,bridge=self.local_client(provider)
        try:
            def failed(*args,**kwargs):raise RuntimeError('real model transport failure')
            provider.model.generate_messages=failed
            with self.assertRaisesRegex(BridgeResponseError,'unavailable'):
                client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertFalse(legacy_calls);self.assertEqual(client.mode,'structured_history')
        finally:bridge.close()
    def test_only_typed_explicit_unsupported_response_permits_race_fallback(self):
        from client import BridgeLanguageModel,BridgeResponseError
        seen=[]
        class ChangingIPC:
            def request(self,op,*args,**kwargs):
                seen.append((op,kwargs))
                if op=='status':return {'capabilities':{'chat_messages':True}}
                if op=='chat' and 'messages' in kwargs:raise BridgeResponseError('messages_unsupported')
                return {'text':'旧模型回答'}
        client=BridgeLanguageModel('unused');client.ipc=ChangingIPC()
        client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
        self.assertEqual([item[0] for item in seen],['status','chat','clear_history','chat'])
        self.assertEqual(seen[-1][1],{'text':MESSAGES[-1]['content']});self.assertEqual(client.mode,'legacy_current_turn')
    def test_status_failure_or_unrelated_chat_error_never_triggers_legacy(self):
        from client import BridgeLanguageModel,BridgeResponseError
        for failure in (BridgeResponseError('unavailable'),BridgeResponseError('deadline'),
                        RuntimeError('messages_unsupported'),TimeoutError('timeout'),OSError('socket')):
            seen=[]
            class BrokenIPC:
                def request(self,op,*args,**kwargs):
                    seen.append((op,kwargs))
                    if op=='status':return {'capabilities':{'chat_messages':True}}
                    raise failure
            client=BridgeLanguageModel('unused');client.ipc=BrokenIPC()
            with self.subTest(failure=type(failure).__name__+str(failure)):
                with self.assertRaises(type(failure)):client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
                self.assertEqual([item[0] for item in seen],['status','chat']);self.assertIn('messages',seen[-1][1])
    def test_only_boolean_false_capability_allows_legacy_and_failed_clear_is_not_ignored(self):
        from client import BridgeLanguageModel
        for supported in (0,'false',None):
            seen=[]
            class UnknownIPC:
                def request(self,op,*args,**kwargs):
                    seen.append((op,kwargs))
                    return {'capabilities':{'chat_messages':supported}} if op=='status' else {'text':'reply'}
            client=BridgeLanguageModel('unused');client.ipc=UnknownIPC()
            client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
            self.assertEqual([item[0] for item in seen],['status','chat']);self.assertIn('messages',seen[-1][1])
        seen=[]
        class ClearFailed:
            def request(self,op,*args,**kwargs):
                seen.append(op)
                if op=='status':return {'capabilities':{'chat_messages':False}}
                raise OSError('clear failed')
        client=BridgeLanguageModel('unused');client.ipc=ClearFailed()
        with self.assertRaises(OSError):client.generate_messages(MESSAGES,cancel=threading.Event(),deadline=time.monotonic()+2)
        self.assertEqual(seen,['status','clear_history'])


if __name__=='__main__':unittest.main(verbosity=2)
