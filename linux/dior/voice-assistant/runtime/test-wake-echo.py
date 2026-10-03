"""Wake/echo state contracts with controlled fake providers; no phone audio claim."""
import json
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest

sys.dont_write_bytecode=True
from assistant import Assistant,Config
from interfaces import AudioFrame,LanguageReply,WakeDetection
from settings import Settings
from test_contracts import Audio,ASR,TTS,Clock


class RecordedTTS(TTS):
    def __init__(self):self.texts=[]
    def synthesize(self,text,cancel):
        self.texts.append(text);return super().synthesize(text,cancel)
    def synthesize_failure(self,cancel):return self.synthesize('这次没有及时回答，请再问一次。',cancel)


class ControlledASR(ASR):
    def __init__(self,text):
        super().__init__();self.text=text;self.entered=threading.Event();self.release=threading.Event()
        self.modes=[]
    def recognize(self,span,partial):
        self.calls+=1;self.modes.append(span.origin_mode);self.entered.set()
        while not self.release.wait(.005):
            if span.cancel.is_set():return ''
        return self.text


class ControlledKeyword:
    def __init__(self,keyword='二狗',*,blocked=False):
        self.result=keyword;self.entered=threading.Event();self.release=threading.Event();self.calls=0
        if not blocked:self.release.set()
    def validate_keyword(self,name):return 'qualified fake tokens'
    def set_keyword(self,name):self.current=name
    def detect(self,span):
        self.calls+=1;self.entered.set()
        while not self.release.wait(.005):
            if span.cancel.is_set():return None
        return WakeDetection(self.result,bytes(640)) if self.result else None
    def close(self):self.release.set()


class RecordedModel:
    def __init__(self,*,blocked=False):
        self.calls=[];self.entered=threading.Event();self.release=threading.Event();self.cancel=None
        if not blocked:self.release.set()
    def generate(self,text,*,cancel,deadline,web_evidence=None):
        self.calls.append(text);self.cancel=cancel;self.entered.set()
        while not self.release.wait(.005):
            if cancel.is_set():return LanguageReply('',None)
        return LanguageReply('这是模型回答。',None)
    def close(self):self.release.set()


class WakeEchoContracts(unittest.TestCase):
    def setUp(self):self.cores=[];self.temps=[]
    def tearDown(self):
        for core in self.cores:core.close()
        for folder in self.temps:folder.cleanup()
    def fixture(self,*,text='二狗',keyword='二狗',blocked_keyword=False,blocked_model=False,progress=False):
        folder=tempfile.TemporaryDirectory();self.temps.append(folder)
        clock=Clock();audio=Audio(aec=True);tts=RecordedTTS();asr=ControlledASR(text)
        detector=ControlledKeyword(keyword,blocked=blocked_keyword);model=RecordedModel(blocked=blocked_model)
        core=Assistant(audio,asr,tts,Settings(Path(folder.name)/'settings.json'),clock=clock,
                       temperature=lambda:40,wake_detector=detector,llm=model,
                       config=Config(progress_cue=progress))
        self.cores.append(core);core.start()
        return core,clock,audio,tts,asr,detector,model
    def wait_for(self,predicate):
        end=time.monotonic()+1.5
        while not predicate() and time.monotonic()<end:time.sleep(.002)
        self.assertTrue(predicate())
    def voice(self,core,clock,count=8,*,reference=False):
        for _ in range(count):
            clock.now+=.02
            core.on_audio(AudioFrame(struct.pack('<h',3000)*320,True,clock.now,reference))

    def test_repeated_exact_wake_produces_one_deferred_ack_without_model(self):
        core,clock,audio,tts,asr,detector,model=self.fixture(text='二狗二狗')
        self.voice(core,clock);self.assertTrue(asr.entered.wait(1))
        self.assertEqual(tts.texts,[]);self.assertEqual(model.calls,[])
        asr.release.set();self.wait_for(lambda:core.playback_kind=='ack' and core.playing)
        core.handle_text('二狗二狗',mode='kws_dialog')
        time.sleep(.01)
        self.assertEqual(tts.texts,['我在，请说。'])
        self.assertEqual(model.calls,[]);self.assertEqual(asr.modes,['kws_dialog'])
        self.assertEqual(core.counters['duplicate_ack_suppressed'],1)

    def test_initial_wrong_short_wake_asks_fresh_turn_without_model(self):
        for text in ('耳钩','二过','二'):
            with self.subTest(text=text):
                core,clock,audio,tts,asr,detector,model=self.fixture(text=text)
                self.voice(core,clock);self.assertTrue(asr.entered.wait(1))
                asr.release.set();self.wait_for(lambda:core.playback_kind=='ack' and core.playing)
                self.assertEqual(model.calls,[])
                self.assertEqual(tts.texts,['我在，请说。'])
                self.assertEqual(core.counters['uncertain_wake_replay'],1)

    def test_ack_playback_never_uses_raw_vad_as_barge_authority(self):
        core,clock,audio,tts,asr,detector,model=self.fixture()
        core.handle_text('二狗');self.wait_for(lambda:core.playback_kind=='ack' and core.playing)
        generation=core.generation
        self.voice(core,clock,40,reference=True)
        self.assertEqual(core.generation,generation);self.assertEqual(detector.calls,0)
        self.assertEqual(asr.calls,0);self.assertEqual(core.counters['barge_candidates'],0)
        self.assertEqual(core.counters['prompt_guard_frames'],40)

    def test_cue_and_confirmation_playback_do_not_create_barge_candidates(self):
        core,clock,audio,tts,asr,detector,model=self.fixture(blocked_model=True,progress=True)
        core.handle_text('二狗解释一下太阳');self.assertTrue(model.entered.wait(1))
        self.assertEqual(core.playback_kind,'cue');generation=core.generation
        self.voice(core,clock,16,reference=True)
        self.assertEqual(core.generation,generation);self.assertFalse(model.cancel.is_set())
        self.assertEqual(detector.calls,0)
        other,clock2,audio2,tts2,asr2,detector2,model2=self.fixture()
        other.handle_text('二狗把唤醒词改成小白')
        self.wait_for(lambda:other.playback_kind=='say_confirm' and other.playing)
        self.voice(other,clock2,16,reference=True)
        self.assertEqual(detector2.calls,0);self.assertEqual(asr2.calls,0)
        self.assertFalse(other.settings.path.exists())

    def test_full_duplex_still_guards_post_playback_tail_then_resumes(self):
        core,clock,audio,tts,asr,detector,model=self.fixture()
        core.handle_text('二狗现在几点');self.wait_for(lambda:core.playing)
        audio.drain();self.assertTrue(core.full_duplex())
        generation=core.generation;self.voice(core,clock,20)
        self.assertEqual(core.generation,generation);self.assertEqual(asr.calls,0)
        self.assertEqual(core.counters['echo_tail_guard_frames'],20)
        clock.now+=.2;self.voice(core,clock)
        self.assertTrue(asr.entered.wait(1));self.assertEqual(asr.modes,['dialog'])

    def test_generation_changes_only_after_current_keyword_is_confirmed(self):
        core,clock,audio,tts,asr,detector,model=self.fixture(blocked_keyword=True,blocked_model=True)
        core.handle_text('二狗解释一下太阳');self.assertTrue(model.entered.wait(1))
        old_generation=core.generation;old_cancel=model.cancel
        self.voice(core,clock,reference=True);self.assertTrue(detector.entered.wait(1))
        self.assertEqual(core.generation,old_generation);self.assertFalse(old_cancel.is_set())
        self.assertEqual(asr.calls,0);self.assertEqual(core.counters['barge_candidates'],1)
        detector.release.set();self.assertTrue(asr.entered.wait(1))
        self.assertEqual(core.generation,old_generation+1);self.assertTrue(old_cancel.is_set())
        self.assertEqual(core.counters['barge_in_events'],1)

    def test_negative_or_old_keyword_keeps_current_model_job_running(self):
        for keyword in ('','小猪哥'):
            with self.subTest(keyword=keyword):
                core,clock,audio,tts,asr,detector,model=self.fixture(keyword=keyword,blocked_keyword=True,blocked_model=True)
                core.handle_text('二狗解释一下太阳');self.assertTrue(model.entered.wait(1))
                old_generation=core.generation;old_cancel=model.cancel
                self.voice(core,clock,reference=True);self.assertTrue(detector.entered.wait(1))
                detector.release.set();self.wait_for(lambda:core.span is None)
                self.assertEqual(core.generation,old_generation);self.assertFalse(old_cancel.is_set())
                self.assertEqual(core.phase,'THINKING');self.assertEqual(asr.calls,0)
                self.assertEqual(core.counters['barge_in_events'],0)
                model.release.set();self.wait_for(lambda:core.playing)
                self.assertEqual(tts.texts,['这是模型回答。'])

    def test_canonical_same_utterance_command_avoids_ack_and_executes(self):
        for text in ('二狗把手机音量给调到最大','耳钩把手机音量给调到最大'):
            with self.subTest(text=text):
                core,clock,audio,tts,asr,detector,model=self.fixture(text=text)
                self.voice(core,clock);self.assertTrue(asr.entered.wait(1))
                self.assertEqual(tts.texts,[]);asr.release.set()
                self.wait_for(lambda:('volume',100) in audio.calls and core.playing)
                self.assertEqual(tts.texts,['音量已设为百分之100。'])
                self.assertEqual(model.calls,[]);self.assertEqual(core.counters['acoustic_keyword_hits'],1)

    def test_failed_ack_playback_does_not_permanently_suppress_new_wake(self):
        core,clock,audio,tts,asr,detector,model=self.fixture()
        original_play=audio.play;attempts=[]
        def fail_once(*args,**kwargs):
            attempts.append(kwargs['generation'])
            if len(attempts)==1:raise RuntimeError('injected playback failure')
            return original_play(*args,**kwargs)
        audio.play=fail_once
        core.handle_text('二狗');self.wait_for(lambda:core.playback_kind=='failure' and core.playing)
        self.assertEqual(core.counters['response_failures'],1);audio.drain()
        self.assertFalse(core.playing);self.assertEqual(core.phase,'IDLE')
        clock.now+=2.1;core.handle_text('二狗')
        self.wait_for(lambda:core.playing and core.playback_kind=='ack')
        self.assertEqual(len(attempts),3)
        self.assertEqual(tts.texts,['我在，请说。','这次没有及时回答，请再问一次。','我在，请说。'])
        self.assertEqual(len([call for call in audio.calls if call[0]=='play']),2)
        self.assertEqual(model.calls,[])

    def test_confirmed_barge_preserves_ordered_command_suffix_during_tail_guard(self):
        core,clock,audio,tts,old_asr,detector,model=self.fixture(blocked_keyword=True,blocked_model=True)
        suffix=[struct.pack('<h',value)*320 for value in range(3101,3107)]
        class OrderedASR(ASR):
            def __init__(self):
                super().__init__();self.entered=threading.Event();self.frames=[];self.generation=None
            def recognize(self,span,partial):
                self.calls+=1;self.generation=span.generation;self.entered.set()
                while not span.cancel.is_set():
                    raw,done=span.take(.01)
                    self.frames.extend(raw[i:i+640] for i in range(0,len(raw),640))
                    if done:
                        # This deterministic provider produces a command only
                        # after every marked input frame arrived in order.
                        return '二狗音量最大' if self.frames[-len(suffix):]==suffix else ''
                return ''
        asr=OrderedASR();core.asr=asr
        core.handle_text('二狗解释一下太阳');self.assertTrue(model.entered.wait(1))
        generation=core.generation;old_cancel=model.cancel
        self.voice(core,clock,reference=True);self.assertTrue(detector.entered.wait(1))
        self.assertEqual(core.generation,generation);self.assertFalse(old_cancel.is_set())
        detector.release.set();self.assertTrue(asr.entered.wait(1))
        self.assertEqual(core.generation,generation+1);self.assertTrue(old_cancel.is_set())
        self.assertEqual(asr.generation,generation+1)
        for pcm in suffix:
            clock.now+=.02
            self.assertLess(clock.now,core.echo_guard_until)
            core.on_audio(AudioFrame(pcm,True,clock.now,True))
        with core.lock:
            self.assertIsNotNone(core.span);core.span.finish()
        self.wait_for(lambda:('volume',100) in audio.calls and core.playing)
        expected=[bytes(640)]+[struct.pack('<h',3000)*320]*8+suffix
        self.assertEqual(asr.frames,expected)
        self.assertEqual(core.generation,generation+1)
        self.assertEqual(core.counters['barge_candidates'],1)
        self.assertEqual(core.counters['barge_in_events'],1)
        self.assertEqual(tts.texts,['音量已设为百分之100。'])


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(WakeEchoContracts))
    print(json.dumps({'status':'PASS_HOST_WAKE_ECHO_CONTRACTS' if result.wasSuccessful() else 'FAIL',
                      'test_count':result.testsRun,'fake_io':True,'phone_or_human_audio_tested':False}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
