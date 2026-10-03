"""Controller follow-up deadlines and numeric telemetry; fake hardware only."""
import json
from pathlib import Path
import struct
import tempfile
import threading
import time
import unittest
from assistant import Assistant,Config,ASR_NOTICE_PHRASE,MODEL_FAILURE_PHRASE
from interfaces import AudioFrame,AudioClip,LanguageReply
from settings import Settings
from test_contracts import Audio,ASR,Clock,wait


class TTS:
    def __init__(self):self.normal=[];self.notices=[];self.fail_notice=False
    def synthesize(self,text,cancel):self.normal.append(text);return AudioClip(bytes(640),16000)
    def synthesize_notice(self,text,cancel):
        self.notices.append(text)
        if self.fail_notice:raise RuntimeError('fixed cache unavailable')
        return AudioClip(bytes(640),16000)
    def synthesize_failure(self,cancel):return self.synthesize_notice(MODEL_FAILURE_PHRASE,cancel)


class FollowupContracts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.clock=Clock();self.audio=Audio(aec=True);self.tts=TTS()
        self.core=Assistant(self.audio,ASR(),self.tts,Settings(Path(self.temp.name)/'settings.json'),
                            clock=self.clock,temperature=lambda:40)
        self.core.start()
    def tearDown(self):self.core.close();self.temp.cleanup()
    def wake(self):
        self.core.handle_text('二狗二狗');wait(self,lambda:self.core.playing and self.core.playback_kind=='ack')
        self.audio.drain();self.assertTrue(self.core.post_ack_wait)
    def frames(self,value,count):
        for _ in range(count):
            self.clock.now+=.02;self.core.on_audio(AudioFrame(struct.pack('<h',value)*320,True,self.clock(),False))
    def notice(self,kind='asr_notice'):
        wait(self,lambda:self.core.playing and self.core.playback_kind==kind)
        self.audio.drain();self.assertEqual(self.core.phase,'IDLE');self.assertEqual(self.core.dialog_until,0)
        self.assertFalse(self.core.post_ack_wait);self.assertEqual(len(self.core.conversation.messages()),1)
    def test_post_ack_no_speech_produces_one_notice_then_stays_idle(self):
        self.wake();old_generation,old_done=self.audio.done
        self.clock.now+=15.1;self.core.tick();self.notice()
        self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE]);self.assertEqual(self.core.last_response_error,'no_speech')
        old_done(old_generation,True);self.assertEqual(self.core.phase,'IDLE')
        self.clock.now+=60;self.core.tick();self.frames(0,100)
        self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE]);self.assertEqual(self.core.phase,'IDLE')
    def test_empty_normal_dialog_returns_one_notice_not_silence(self):
        class Empty:
            def recognize(self,*args):return ''
        self.core.asr=Empty();self.wake();self.clock.now+=.6;self.frames(1000,8);self.notice()
        self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE]);self.assertEqual(self.core.last_response_error,'asr_empty')
    def test_failed_normal_dialog_returns_one_notice_and_asr_thread_survives(self):
        class Broken:
            def recognize(self,*args):raise TimeoutError('fake ASR finish timeout')
        self.core.asr=Broken();self.wake();self.clock.now+=.6;self.frames(1000,8);self.notice()
        self.assertEqual(self.core.counters['asr_failures'],1);self.assertEqual(self.core.last_response_error,'asr_error')
        self.assertTrue(all(thread.is_alive() for thread in self.core.threads))
    def test_asr_wall_deadline_aborts_old_span_without_duplicate_notice(self):
        entered=threading.Event()
        class Waiting:
            def recognize(self,span,partial):entered.set();span.cancel.wait(1);return '迟到的结果'
        self.core.asr=Waiting();self.wake();self.clock.now+=.6;self.frames(1000,8)
        self.assertTrue(entered.wait(1));status=self.core.status()['timing']['asr']
        self.assertEqual(status['mode'],'dialog');self.assertGreater(status['left'],0)
        self.clock.now+=20.1;self.core.tick();self.notice()
        wait(self,lambda:self.core.asr_active is None)
        self.assertEqual(self.core.last_response_error,'asr_deadline');self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE])
        self.assertNotIn('迟到的结果',str(self.core.conversation.messages()))
    def test_identity_tts_timeout_is_cancelled_and_local_notice_terminates_turn(self):
        entered=threading.Event();owner=self
        class WaitingTTS(TTS):
            def synthesize(self,text,cancel):
                self.normal.append(text);entered.set();cancel.wait(1);raise TimeoutError('fake pending synthesis')
        self.tts=WaitingTTS();self.core.tts=self.tts
        self.core.handle_text('你叫什么名字',mode='dialog');self.assertTrue(entered.wait(1))
        timing=self.core.status()['timing'];self.assertEqual(timing['stage'],'tts');self.assertLessEqual(timing['response_left'],30)
        self.clock.now+=30.1;self.core.tick();self.notice('failure')
        self.assertEqual(self.tts.notices,[MODEL_FAILURE_PHRASE]);self.assertEqual(self.core.last_response_error,'response_deadline')
    def test_model_deadline_cancels_and_discards_late_answer(self):
        entered=threading.Event()
        class WaitingModel:
            def generate(self,text,*,cancel,**kwargs):entered.set();cancel.wait(1);return LanguageReply('过期答案')
        self.core.llm=WaitingModel();self.core.handle_text('解释一个问题',mode='dialog');self.assertTrue(entered.wait(1))
        self.assertEqual(self.core.status()['timing']['stage'],'model')
        self.clock.now+=30.1;self.core.tick();self.notice('failure')
        self.assertEqual(self.tts.notices,[MODEL_FAILURE_PHRASE]);self.assertNotIn('过期答案',self.tts.normal)
    def test_identity_tts_exception_also_gets_one_local_notice(self):
        class BrokenTTS(TTS):
            def synthesize(self,*args):raise OSError('fake unavailable Piper')
        self.tts=BrokenTTS();self.core.tts=self.tts
        self.core.handle_text('你叫什么名字',mode='dialog');self.notice('failure')
        self.assertEqual(self.tts.notices,[MODEL_FAILURE_PHRASE]);self.assertEqual(self.core.last_response_error,'speech_unavailable')
    def test_failed_notice_cache_stops_without_recursive_retries(self):
        self.wake();self.tts.fail_notice=True;self.clock.now+=15.1;self.core.tick()
        wait(self,lambda:self.core.last_response_error=='fallback_unavailable')
        self.assertEqual(self.core.phase,'IDLE');self.clock.now+=60;self.core.tick()
        self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE]);self.assertFalse(self.core.playing)
    def test_failed_notice_playback_stops_without_reopening_listening(self):
        self.wake();self.clock.now+=15.1;self.core.tick();wait(self,lambda:self.core.playback_kind=='asr_notice' and self.core.playing)
        generation,done=self.audio.done;done(generation,False)
        self.assertEqual(self.core.phase,'IDLE');self.assertFalse(self.core.post_ack_wait)
        self.clock.now+=60;self.core.tick();self.assertEqual(self.tts.notices,[ASR_NOTICE_PHRASE])
    def test_missing_playback_callback_has_bounded_single_recovery_attempt(self):
        self.core.handle_text('二狗');wait(self,lambda:self.core.playing)
        self.clock.now+=2.1;self.core.tick();wait(self,lambda:self.core.playback_kind=='failure' and self.core.playing)
        self.clock.now+=2.1;self.core.tick();self.assertEqual(self.core.phase,'IDLE')
        self.clock.now+=60;self.core.tick();self.assertEqual(self.tts.notices,[MODEL_FAILURE_PHRASE])
        self.assertEqual(self.core.last_response_error,'fallback_unavailable')
    def test_post_ack_peak_and_longest_run_survive_window_end_and_reset_on_next_ack(self):
        self.wake();self.frames(5000,10) # Acoustic tail is measured separately.
        self.clock.now+=.6;self.frames(600,7);self.frames(0,1);self.frames(900,6);self.frames(0,1)
        status=self.core.status()['input']
        self.assertEqual(status['post_ack_peak_rms'],900);self.assertEqual(status['post_ack_longest_voiced_frames'],7)
        self.assertEqual(status['starts'],0);self.assertEqual(status['guard_voiced']['tail'],10)
        self.assertEqual((status['threshold'],status['onset']),(300,8));self.assertIsNotNone(status['voice_at'])
        self.clock.now+=16;self.core.tick();self.notice();self.clock.now+=5;self.core.tick()
        status=self.core.status()['input'];self.assertEqual(status['recent_peak'],0)
        self.assertEqual(status['post_ack_peak_rms'],900);self.assertEqual(status['post_ack_longest_voiced_frames'],7)
        self.wake();status=self.core.status()['input']
        self.assertEqual(status['post_ack_peak_rms'],0);self.assertEqual(status['post_ack_longest_voiced_frames'],0)
    def test_numeric_telemetry_does_not_store_audio_or_recognized_text(self):
        self.wake();self.clock.now+=.6;self.frames(250,20)
        data=self.core.status();encoded=json.dumps({'input':data['input'],'timing':data['timing']},ensure_ascii=False)
        for forbidden in ('pcm16','transcript','recognized','我在','private question'):self.assertNotIn(forbidden,encoded)
        self.assertEqual(data['input']['rms'],250);self.assertEqual(data['input']['post_ack_peak_rms'],250)
        self.assertEqual(data['input']['post_ack_longest_voiced_frames'],0);self.assertEqual(data['input']['starts'],0)
    def test_completed_user_turn_does_not_trigger_post_ack_timeout_notice(self):
        self.wake();self.clock.now+=.6;self.core.handle_text('你叫什么名字',mode='dialog')
        wait(self,lambda:self.core.playing);self.audio.drain()
        self.clock.now+=16;self.core.tick();self.assertEqual(self.core.phase,'IDLE');self.assertFalse(self.tts.notices)
    def test_full_status_preserves_numeric_fields_and_shared_provider_when_trace_is_omitted(self):
        from control import StatusServer
        self.wake();self.clock.now+=.6;self.frames(250,25);snapshot=self.core.status()
        snapshot['shared_inference']={'v':1,'id':'d'*32,'ok':True,'ready':True,'active':None,'queue_length':0,
            'active_state':None,'thermal_waiting':False,'cooling':False,'thermal_admit_c':52,'voice_asr_active':False,'thermal_c':39.0,
            'voice_cache_clear_pending':False,'voice_cache_clearing':False,'voice_cache_clear_error':False,
            'limits':{'connections':8,'jobs':4,'stt_seconds':20,'chat_model_bytes':768,'voice_messages_bytes':8192,
                      'voice_messages':12,'chat_frame_bytes':16384,'tts_chars':120},'model_load_count':1,'native_worker_pid':21895,
            'native_threads':3,'model_id':'Qwen2.5-0.5B-Instruct-Q4_0','engine_tag':'b3927','native_alive':True,
            'backend':'CPU_NEON','public_tcp':False,'web_history':False,
            'last_model_diagnostics':{'status':'complete','generated_tokens':24,'input_tokens':100,'cached_prefix_tokens':28,
                'first_token_seconds':1.1,'prefill_seconds':1.0,'total_seconds':4.2,'max_rss_kib':454804,'history_excerpt_turns':2,'gpu_used':False},
            'last_error_type':'none','capabilities':{'chat':True,'chat_messages':False,'speech':True,'transcribe':True},
            'capability_scope':'initialized provider; each call still validates runtime/availability'}
        snapshot['model_ready']=True
        for name in ('capture_lock_drops','capture_gap_resets','prompt_guard_frames','aec_degraded_frames','echo_tail_guard_frames',
                     'asr_spans','acoustic_keyword_hits','spoken_replies','wake_only_utterances','duplicate_ack_suppressed',
                     'frame_overflow','asr_failures','response_failures','barge_candidates','barge_in_events','interruptions',
                     'hearing_notices','model_failure_notices','response_deadlines','self_voice_rejected','self_voice_fragment_rejected',
                     'uncertain_wake_replay','wake_replay_overflow','keyword_rollback_failed','query_failures','history_clear_failures',
                     'conversation_input_rejected','dispatch_failures','audio_interrupt_failures','confirmation_expired'):
            snapshot['counters'][name]=123456789
        # Deliberately push a correctly bounded optional trace over the full
        # response budget, including the real-shaped ~1KiB provider snapshot.
        snapshot['diagnostic_turns']=[{'event':'recognized','text':'中文'*145}]
        snapshot['diagnostic_expires_in']=100
        self.assertLessEqual(len(json.dumps(snapshot['diagnostic_turns'],ensure_ascii=False).encode()),1024)
        self.assertGreater(len(json.dumps({'status':snapshot},ensure_ascii=False,separators=(',',':')).encode()),4096)
        captured=[]
        class Capture:
            def sendall(self,data):captured.append(data)
        server=StatusServer(lambda:snapshot,Path(self.temp.name)/'unused',group=None)
        server._send(Capture(),{'status':snapshot});result=json.loads(captured[0])
        self.assertLessEqual(len(captured[0]),4096);self.assertNotIn('error',result)
        self.assertEqual(result['status']['input']['post_ack_peak_rms'],250)
        self.assertEqual(result['status']['shared_inference']['model_id'],'Qwen2.5-0.5B-Instruct-Q4_0')
        self.assertTrue(result['status']['diagnostic_omitted']);self.assertNotIn('diagnostic_turns',result['status'])
        self.assertIn('diagnostic_turns',snapshot) # Do not mutate the live trace snapshot.


if __name__=='__main__':unittest.main(verbosity=2)
