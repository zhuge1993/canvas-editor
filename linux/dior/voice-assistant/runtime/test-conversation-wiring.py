"""Real controller threads with fake hardware: only drained replies become history."""
import copy
import json
from pathlib import Path
import tempfile
import sys
import threading
import time
import unittest
from assistant import Assistant,Config,MODEL_FAILURE_PHRASE,DIAGNOSTIC_TRACE_BYTES
from asr_stream import Span
from interfaces import LanguageReply,AudioClip
from settings import Settings
from test_contracts import Audio,ASR,TTS,Clock,wait


class Model:
    def __init__(self):self.calls=[];self.clear_threads=[]
    def generate_messages(self,messages,*,cancel,deadline):
        self.calls.append(copy.deepcopy(messages));return LanguageReply('收到你的问题。')
    def clear_history(self):self.clear_threads.append(threading.current_thread().name)


class RecoveryTTS(TTS):
    def __init__(self,missing=False):self.fallback_calls=0;self.synthesis_calls=0;self.missing=missing
    def synthesize(self,text,cancel):self.synthesis_calls+=1;return super().synthesize(text,cancel)
    def synthesize_failure(self,cancel):
        self.fallback_calls+=1
        if self.missing:raise RuntimeError('missing qualified cache')
        return AudioClip(bytes(640),16000)


class Wiring(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.clock=Clock();self.audio=Audio();self.model=Model()
        self.core=Assistant(self.audio,ASR(),TTS(),Settings(Path(self.temp.name)/'settings.json'),
            llm=self.model,clock=self.clock,temperature=lambda:40)
        self.core.start()
    def tearDown(self):self.core.close();self.temp.cleanup()
    def ask(self,text):
        self.core.handle_text(text,mode='dialog');wait(self,lambda:self.core.playing)
    def snapshot(self):return self.core.conversation.messages()
    def test_structured_roles_use_current_identity_and_only_complete_playback(self):
        self.ask('你好呀')
        self.assertEqual([m['role'] for m in self.model.calls[0]],['system','user'])
        self.assertIn('二狗',self.model.calls[0][0]['content'])
        self.assertNotIn('assistant',[m['role'] for m in self.snapshot()])
        self.audio.drain();self.ask('还有呢')
        self.assertEqual([m['role'] for m in self.model.calls[-1]],['system','user','assistant','user'])
        self.assertEqual(self.model.calls[-1][2]['content'],'收到你的问题。')
    def test_failed_playback_does_not_become_remembered_answer(self):
        self.ask('第一句话');generation,done=self.audio.done;done(generation,False)
        self.ask('第二句话')
        self.assertEqual([m['role'] for m in self.model.calls[-1]],['system','user'])
        self.assertEqual(self.model.calls[-1][-1]['content'],'第二句话')
    def test_synthesis_failure_discards_turn_without_stopping_worker(self):
        class FailedTTS:
            def synthesize(self,*args):raise OSError('synthetic hardware failure')
        self.core.tts=FailedTTS();self.core.handle_text('第一个问题',mode='dialog')
        wait(self,lambda:self.core.counters['response_failures']==1)
        self.assertEqual(len(self.snapshot()),1);self.assertTrue(all(t.is_alive() for t in self.core.threads))
        self.core.tts=TTS();self.ask('第二个问题');self.assertEqual(len(self.model.calls[-1]),2)
    def test_new_turn_cancels_inflight_model_and_never_commits_late_result(self):
        entered=threading.Event();release=threading.Event();calls=[]
        def slow(messages,*,cancel,deadline):
            calls.append(copy.deepcopy(messages))
            if len(calls)==1:entered.set();release.wait(1);return LanguageReply('过时的回答')
            return LanguageReply('新回答')
        self.model.generate_messages=slow
        self.core.handle_text('旧问题',mode='dialog');self.assertTrue(entered.wait(1))
        self.core.handle_text('新问题',mode='dialog');release.set();wait(self,lambda:self.core.playing)
        self.assertEqual(self.core.last_spoken,'新回答');self.assertEqual(len(calls[-1]),2)
        self.audio.drain();self.assertNotIn('过时的回答',str(self.snapshot()))
    def test_late_playback_callback_cannot_commit_or_stop_new_turn(self):
        self.ask('旧问题');old_generation,old_done=self.audio.done
        self.ask('新问题');new_generation,new_done=self.audio.done
        old_done(old_generation,True)
        self.assertTrue(self.core.playing);self.assertNotIn('旧问题',str(self.snapshot()))
        new_done(new_generation,True);self.assertIn('新问题',str(self.snapshot()))
        self.assertEqual(sum(m['role']=='assistant' for m in self.snapshot()),1)
    def test_duplicate_old_drain_cannot_change_new_thinking_before_its_playback(self):
        self.ask('第一轮');old_generation,old_done=self.audio.done;self.audio.drain()
        entered=threading.Event();release=threading.Event()
        def slow(messages,**kwargs):entered.set();release.wait(1);return LanguageReply('第二轮回答')
        self.model.generate_messages=slow;self.core.handle_text('第二轮',mode='dialog')
        self.assertTrue(entered.wait(1));self.assertEqual(self.core.phase,'THINKING')
        old_done(old_generation,True)
        self.assertEqual(self.core.phase,'THINKING');self.assertEqual(self.snapshot()[-1]['content'],'第二轮')
        release.set();wait(self,lambda:self.core.playing)
    def test_skill_result_enters_context_only_after_actual_playback(self):
        self.ask('音量调到60');self.assertIn(('volume',60),self.audio.calls)
        self.assertNotIn('assistant',[m['role'] for m in self.snapshot()])
        self.audio.drain();self.ask('刚才做了什么')
        self.assertEqual(self.model.calls[-1][2],{'role':'assistant','content':'音量已设为百分之60。'})
    def test_ack_and_progress_cue_are_not_conversational_answers(self):
        self.ask('二狗');self.audio.drain();self.assertEqual(len(self.snapshot()),1)
        entered=threading.Event();release=threading.Event()
        def slow(messages,**kwargs):entered.set();release.wait(1);return LanguageReply('真正回答')
        self.model.generate_messages=slow;self.core.config=Config(progress_cue=True)
        self.core.handle_text('为什么天会黑',mode='dialog');self.assertTrue(entered.wait(1))
        self.audio.drain();self.assertNotIn('assistant',[m['role'] for m in self.snapshot()])
        release.set();wait(self,lambda:self.core.phase=='SPEAKING');self.audio.drain()
        self.assertEqual(self.snapshot()[-1]['content'],'真正回答');self.assertNotIn('请稍等',str(self.snapshot()))
    def test_cancel_clears_session_and_legacy_ipc_runs_outside_capture_thread(self):
        self.ask('记住这句');self.audio.drain();self.core.handle_text('取消',mode='dialog')
        self.assertEqual(len(self.snapshot()),1);wait(self,lambda:bool(self.model.clear_threads))
        self.assertNotEqual(self.model.clear_threads[0],threading.current_thread().name)
    def test_session_expiry_clears_previous_conversation(self):
        self.ask('第一句');self.audio.drain();self.clock.now+=16;self.core.tick()
        self.assertEqual(len(self.snapshot()),1)
    def test_confirmed_rename_updates_system_and_invalidates_prior_identity(self):
        self.ask('把唤醒词改成小猪哥');self.audio.drain();self.ask('确认');self.audio.drain()
        self.ask('怎么称呼你好呢')
        self.assertIn('小猪哥',self.model.calls[-1][0]['content']);self.assertNotIn('二狗',str(self.model.calls[-1]))
        self.assertEqual(self.model.calls[-1][1]['content'],'确认')
    def test_oversized_turn_returns_bounded_prompt_without_killing_controller(self):
        self.ask('问题'*240)
        self.assertEqual(self.core.last_spoken,'这句话太长，请简短说一遍。')
        self.assertFalse(self.model.calls);self.audio.drain();self.assertEqual(len(self.snapshot()),1)
        self.assertTrue(all(t.is_alive() for t in self.core.threads))
    def test_model_call_does_not_hold_controller_lock(self):
        entered=threading.Event();release=threading.Event()
        def slow(messages,**kwargs):entered.set();release.wait(1);return LanguageReply('好')
        self.model.generate_messages=slow;self.core.handle_text('问个问题',mode='dialog')
        self.assertTrue(entered.wait(1));acquired=self.core.lock.acquire(timeout=.02)
        self.assertTrue(acquired)
        if acquired:self.core.lock.release()
        release.set()
    def test_model_exception_plays_one_local_cached_notice_without_history(self):
        tts=RecoveryTTS();self.core.tts=tts;self.core.config=Config(progress_cue=True)
        def failed(*args,**kwargs):raise TimeoutError('bounded model timeout')
        self.model.generate_messages=failed;self.ask('请回答这个问题')
        wait(self,lambda:self.core.playback_kind=='failure')
        self.assertEqual(self.core.last_spoken,MODEL_FAILURE_PHRASE)
        self.assertEqual(tts.fallback_calls,1);self.assertEqual(tts.synthesis_calls,1)
        self.assertEqual(self.core.status()['last_response_error'],'model_unavailable')
        self.audio.drain();self.assertEqual(len(self.snapshot()),1)
        time.sleep(.02);self.assertEqual(tts.fallback_calls,1)
    def test_missing_failure_cache_is_visible_and_never_retries_or_calls_heavy_tts(self):
        tts=RecoveryTTS(missing=True);self.core.tts=tts
        def failed(*args,**kwargs):raise RuntimeError('offline model failed')
        self.model.generate_messages=failed;self.core.handle_text('普通问题',mode='dialog')
        wait(self,lambda:self.core.last_response_error=='fallback_unavailable')
        self.assertEqual(tts.fallback_calls,1);self.assertEqual(tts.synthesis_calls,0)
        time.sleep(.02);self.assertEqual(tts.fallback_calls,1);self.assertFalse(self.core.playing)
        self.assertTrue(all(t.is_alive() for t in self.core.threads));self.assertEqual(len(self.snapshot()),1)
    def test_empty_model_output_is_error_notice_not_a_successful_history_answer(self):
        tts=RecoveryTTS();self.core.tts=tts
        self.model.generate_messages=lambda *args,**kwargs:LanguageReply('')
        self.ask('问一个问题');self.audio.drain()
        self.assertEqual(tts.fallback_calls,1);self.assertEqual(len(self.snapshot()),1)
    def test_cancelled_model_error_never_speaks_failure_notice(self):
        entered=threading.Event();release=threading.Event();tts=RecoveryTTS();self.core.tts=tts
        def late(*args,**kwargs):entered.set();release.wait(1);raise RuntimeError('cancelled')
        self.model.generate_messages=late;self.core.handle_text('普通问题',mode='dialog')
        self.assertTrue(entered.wait(1));self.core.handle_text('取消',mode='dialog');release.set();time.sleep(.02)
        self.assertFalse(tts.fallback_calls);self.assertFalse(self.core.playing)
    def test_hot_model_error_does_not_bypass_thermal_safety_with_notice(self):
        entered=threading.Event();release=threading.Event();tts=RecoveryTTS();self.core.tts=tts
        def late(*args,**kwargs):entered.set();release.wait(1);raise RuntimeError('hot')
        self.model.generate_messages=late;self.core.handle_text('普通问题',mode='dialog')
        self.assertTrue(entered.wait(1));self.core.cached_temperature=66;release.set();time.sleep(.02)
        self.assertFalse(tts.fallback_calls);self.assertFalse(self.core.playing)
    def test_recovery_playback_failure_is_visible_without_retry(self):
        tts=RecoveryTTS();self.core.tts=tts
        self.model.generate_messages=lambda *args,**kwargs:LanguageReply('')
        self.ask('普通问题');generation,done=self.audio.done;done(generation,False)
        self.assertEqual(self.core.last_response_error,'fallback_unavailable')
        self.assertEqual(len(self.snapshot()),1);time.sleep(.02);self.assertEqual(tts.fallback_calls,1)
    def test_temperature_rise_during_cache_read_is_checked_again_before_playback(self):
        owner=self.core
        class HeatingTTS(RecoveryTTS):
            def synthesize_failure(self,cancel):
                clip=super().synthesize_failure(cancel);owner.cached_temperature=66;return clip
        tts=HeatingTTS();self.core.tts=tts
        self.model.generate_messages=lambda *args,**kwargs:LanguageReply('')
        self.core.handle_text('普通问题',mode='dialog');wait(self,lambda:tts.fallback_calls==1)
        self.assertFalse(any(row[0]=='play' for row in self.audio.calls));self.assertEqual(len(self.snapshot()),1)
    def test_recognized_skill_io_failure_keeps_asr_thread_alive(self):
        class Recognized:
            def recognize(self,*args):return '音量调到60'
        def broken_volume(value):raise OSError('mixer unavailable')
        self.core.asr=Recognized();self.audio.set_volume=broken_volume
        with self.core.condition:
            span=Span(self.core.generation,'dialog',self.clock(),[],5)
            self.core.span=span;self.core.asr_job=span;self.core.condition.notify_all()
        wait(self,lambda:self.core.counters['dispatch_failures']==1)
        self.assertTrue(all(t.is_alive() for t in self.core.threads))
        self.assertEqual(self.core.last_response_error,'skill_unavailable');self.assertEqual(len(self.snapshot()),1)
    def test_status_labels_legacy_current_turn_then_negotiated_structured_history(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'bridge'))
        from client import BridgeLanguageModel
        class CapabilitiesIPC:
            supported=False
            def request(self,op,*args,**kwargs):
                if op=='status':return {'capabilities':{'chat_messages':self.supported}}
                if op=='clear_history':return {'ok':True}
                return {'text':'新回答。' if 'messages' in kwargs else '旧回答。'}
        proxy=BridgeLanguageModel('unused');proxy.ipc=CapabilitiesIPC();self.core.llm=proxy
        self.ask('第一个问题');self.audio.drain();status=self.core.status()['conversation']
        self.assertEqual(status['mode'],'legacy_current_turn');self.assertFalse(status['history_sent_to_model'])
        self.assertEqual(status['history_turns'],1)
        proxy.ipc.supported=True;self.ask('第二个问题');self.audio.drain();status=self.core.status()['conversation']
        self.assertEqual(status['mode'],'structured_history');self.assertTrue(status['history_sent_to_model'])
    def test_long_chinese_diagnostic_trace_has_utf8_budget_and_status_stays_valid(self):
        from control import StatusServer
        self.core.diagnostic_until=self.clock()+180
        for index in range(40):self.core._trace('recognized',mode='dialog',text='中文长句'*40+str(index))
        trace=json.dumps(list(self.core.trace),ensure_ascii=False,separators=(',',':')).encode('utf8')
        self.assertLessEqual(len(trace),DIAGNOSTIC_TRACE_BYTES);self.assertLessEqual(len(self.core.trace),16)
        self.assertTrue(self.core.trace[-1]['text'].endswith('39'))
        sent=[]
        class Capture:
            def sendall(self,data):sent.append(data)
        server=StatusServer(self.core.status,Path(self.temp.name)/'unused',group=None)
        server._send(Capture(),{'status':self.core.status()})
        self.assertLessEqual(len(sent[0]),4096);self.assertIn('status',json.loads(sent[0]));self.assertNotIn('error',json.loads(sent[0]))
        self.clock.now+=181;self.core.tick();self.assertNotIn('diagnostic_turns',self.core.status());self.assertFalse(self.core.trace)
    def test_default_diagnostic_trace_remains_disabled(self):
        self.core._trace('recognized',text='不应记录的临时文字')
        self.assertFalse(self.core.trace);self.assertNotIn('diagnostic_turns',self.core.status())


if __name__=='__main__':unittest.main(verbosity=2)
