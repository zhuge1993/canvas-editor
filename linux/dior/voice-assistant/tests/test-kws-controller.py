"""Generated digital input through real ASR/core/TTS/speaker; not human voice."""
import json
import os
from pathlib import Path
import sys
import threading
import time
import wave

BASE=Path('/tmp/dior-kernel-test/voice-qa')
ROOT=Path('/opt/dior-voice')
sys.path.insert(0,str(ROOT/'runtime'));sys.path.insert(0,str(ROOT/'tts'))
from assistant import Assistant,Config
from asr_stream import StreamingASR
from settings import Settings
from interfaces import AudioFrame
from offline_tts import OfflineTTS
from dior_audio import DiorAudio
from wake_detector import KeywordWakeDetector
sys.path.insert(0,str(ROOT/'kws'))
from kws_adapter import LocalKeywordSpotter

class ControlledInput:
    def __init__(self):
        self.real=DiorAudio(volume=50,aec_verified=True,bootstrap=True)
        self.injecting=threading.Event();self.speaker_events=[];self.callback=None
    def start(self,callback):
        self.callback=callback
        self.real.start(lambda frame:None if self.injecting.is_set() else callback(frame))
    def capabilities(self):return self.real.capabilities()
    def set_volume(self,percent):self.real.set_volume(percent)
    def interrupt(self):self.real.interrupt()
    def close(self):self.real.close()
    def play(self,pcm16,rate,*,generation,on_done):
        def finished(g,done):
            self.speaker_events.append({'generation':g,'drained':done,'at':time.monotonic()})
            on_done(g,done)
        self.real.play(pcm16,rate,generation=generation,on_done=finished)
    def fixture(self,name):
        with wave.open(str(BASE/'fixtures'/(name+'.wav')),'rb') as wav:
            assert wav.getframerate()==16000
            data=wav.readframes(wav.getnframes())+bytes(32000)
        self.injecting.set();begin=time.monotonic()
        try:
            for offset in range(0,len(data),640):
                delay=begin+(offset+640)/32000-time.monotonic()
                if delay>0:time.sleep(delay)
                self.callback(AudioFrame(data[offset:offset+640].ljust(640,b'\0'),True,time.monotonic(),False))
        finally:self.injecting.clear()

report={'status':'RUNNING','input':'generated_piper_pcm_injected','real_microphone_and_speaker_open':True,
        'human_wake_or_double_talk_tested':False,'checks':{}}
device=None;core=None
try:
    path=BASE/'controller-test-settings.json'
    if path.exists():path.unlink()
    settings=Settings(path);device=ControlledInput();tts=OfflineTTS(ROOT/'tts','piper')
    assert len(tts._fixed_cache)==10
    core=Assistant(device,StreamingASR(),tts,settings,config=Config(vad_rms=180),temperature=lambda:40,wake_detector=KeywordWakeDetector(LocalKeywordSpotter(ROOT/'kws',ROOT/'tts',keyword=settings.wake_word,threads=2)))
    core.start()
    def wait_for(predicate,timeout=15):
        end=time.monotonic()+timeout
        while time.monotonic()<end:
            if predicate():return
            if device.real.last_error:raise RuntimeError(device.real.last_error)
            time.sleep(.05)
        raise AssertionError('controller_wait_timeout '+str(core.status()))
    device.fixture('derived-prefix-550')
    wait_for(lambda:core.counters['acoustic_keyword_hits']>=1)
    report['checks']['short_clear_keyword_real_model_wakes']=True
    wait_for(lambda:not core.playing and core.phase!='THINKING')
    device.fixture('max')
    wait_for(lambda:core.volume==100)
    report['checks']['max_voice_asr_real_mixer']=True
    wait_for(lambda:not core.playing and core.phase!='THINKING')
    device.fixture('min')
    wait_for(lambda:core.volume==0)
    report['checks']['min_voice_asr_real_mixer']=True
    wait_for(lambda:not core.playing and core.phase!='THINKING')
    # Setting persistence/confirmation uses a trusted internal test entry here;
    # ASR's generated uncommon-name error is retained in separate evidence.
    core.handle_text('二狗把唤醒词改成小猪哥',mode='dialog')
    wait_for(lambda:core.pending is not None and core.pending.expires is not None,25)
    device.fixture('confirm')
    wait_for(lambda:settings.wake_word=='小猪哥')
    assert Settings(path).wake_word=='小猪哥'
    report['checks']['confirmation_real_asr_and_persistent_setting']=True
    wait_for(lambda:not core.playing and core.phase!='THINKING')
    device.fixture('identity')
    wait_for(lambda:core.counters['spoken_replies']>=6,20)
    wait_for(lambda:not core.playing and core.phase!='THINKING',20)
    report['checks']['new_name_prefix_identity_asr']=True
    report['core']=core.status();report['audio']=device.real.status()
    report['speaker_completion_count']=len(device.speaker_events)
    assert device.real.xruns==0 and not device.real.last_error
    core.close();report['status']='PASS_PARTIAL_SCOPE'
    report['short_wake_word_tested_separately']='derived-prefix positive; independent synthetic variants failed; no human validation'
except Exception as error:
    report['status']='FAIL';report['error']=repr(error)
finally:
    if device:report['device_final_status']=device.real.status()
    if core:
        try:core.close()
        except Exception as error:report['close_error']=repr(error)
    report['pcm_closed']=bool(device and not device.real._started)
    (BASE/'CONTROLLER-KWS-INTEGRATION-RESULT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps(report,ensure_ascii=False),flush=True)
if report['status']=='FAIL':raise SystemExit(1)
