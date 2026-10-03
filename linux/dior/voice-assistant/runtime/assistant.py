"""Bounded voice controller with cancellation, typed skills and honest AEC status."""
from dataclasses import dataclass
from datetime import datetime
import collections
import math
import threading
import time
from asr_stream import Span
from interfaces import AudioClip,AudioCapabilities
from settings import validate_wake
from skills import EvidenceSearch,normalize,parse_intent,time_reply

@dataclass(frozen=True)
class Config:
    vad_rms:int=300
    onset_frames:int=8
    silence_seconds:float=.6
    wake_audio_seconds:float=4
    dialog_audio_seconds:float=15
    dialog_wait_seconds:float=15
    confirmation_seconds:float=10
    wake_cooldown_seconds:float=2
    llm_seconds:float=15
    network_enabled:bool=False
    temperature_limit:float=65
    initial_volume:int=50
    progress_cue:bool=False

@dataclass
class PendingChange:
    candidate:str
    generation:int
    expires:float=None
    prompt_deadline:float=0

class Assistant:
    def __init__(self,audio,asr,tts,settings,*,llm=None,search=None,config=None,clock=time.monotonic,
                 temperature=lambda:None,wall_clock=None,wake_detector=None):
        self.audio=audio;self.asr=asr;self.tts=tts;self.settings=settings;self.llm=llm
        self.search=search or EvidenceSearch();self.config=config or Config();self.clock=clock
        self.wake_detector=wake_detector
        self.temperature=temperature;self.wall_clock=wall_clock
        self.lock=threading.RLock();self.condition=threading.Condition(self.lock)
        self.phase='IDLE';self.generation=0;self.stopping=False;self.playing=False
        self.span=None;self.asr_job=None;self.response_job=None;self.response_cancel=threading.Event()
        self.preroll=collections.deque(maxlen=25);self.voiced_frames=0;self.dialog_until=0
        self.next_wake=0;self.echo_guard_until=0;self.pending=None;self.volume=self.config.initial_volume
        self.last_spoken='';self.last_spoken_until=0
        self.cached_temperature=None;self.temperature_checked=-1e9
        self.capture_gap=threading.Event()
        self.history_clear=threading.Event()
        self.play_token=0
        self.counters=collections.Counter();self.threads=[]

    def full_duplex(self):
        cap=self.audio.capabilities()
        return bool(cap.microphone_available and cap.speaker_available and cap.simultaneous_capture_playback
                    and cap.aec_available and cap.aec_verified)

    def status(self):
        if not self.lock.acquire(timeout=.05):return {'phase':'BUSY','status_busy':True}
        try:return self._status_locked()
        finally:self.lock.release()

    def _status_locked(self):
        with self.lock:
            caps=self.audio.capabilities()
            ready=bool(self.threads) and all(t.is_alive() for t in self.threads) and not self.stopping
            ready=ready and caps.microphone_available and caps.speaker_available and self.phase!='THERMAL_PAUSE'
            return {'phase':self.phase,'ready':ready,'wake_word':self.settings.wake_word,'full_duplex':self.full_duplex(),
                'barge_in':self.full_duplex(),'aec_verified':self.audio.capabilities().aec_verified,
                'pending_wake_change':bool(self.pending),'recording_persisted':False,'transcript_logging':False,
                'public_listener':False,'queue_limits':{'asr':1,'response':1,'frame':50,'preroll':25},
                'llm_configured':self.llm is not None,'network_enabled':self.config.network_enabled,
                'keyword_spotter_configured':self.wake_detector is not None,
                'thermal_sensor_available':self.cached_temperature is not None,
                'counters':dict(self.counters)}

    def start(self):
        self.tick()
        if self.wake_detector is not None:
            self.wake_detector.validate_keyword(self.settings.wake_word)
            self.wake_detector.set_keyword(self.settings.wake_word)
        with self.lock:
            if self.threads:raise RuntimeError('already_started')
            self.threads=[threading.Thread(target=self._asr_loop,daemon=True),
                          threading.Thread(target=self._response_loop,daemon=True),
                          threading.Thread(target=self._maintenance_loop,daemon=True)]
            for thread in self.threads:thread.start()
        self.audio.start(self.on_audio)

    def _too_hot(self):
        value=self.cached_temperature
        return value is not None and value>self.config.temperature_limit

    def _cancel_response(self):
        self.generation+=1;self.response_cancel.set();self.response_cancel=threading.Event()
        self.response_job=None
        if self.playing:self.audio.interrupt()
        self.playing=False;self.counters['interruptions']+=1

    def on_audio(self,frame):
        # Never let a slow mixer/provider/settings operation back up capture.
        # A missed controller frame invalidates the current ASR span rather
        # than allowing a truncated command to execute silently.
        if not self.lock.acquire(blocking=False):
            self.capture_gap.set();self.counters['capture_lock_drops']+=1;return
        try:self._on_audio_locked(frame)
        finally:self.lock.release()

    def _on_audio_locked(self,frame):
        # Capture callback does no network, model inference or filesystem I/O.
        samples=memoryview(frame.pcm16).cast('h');rms=math.sqrt(sum(x*x for x in samples)/len(samples))
        voiced=rms>=self.config.vad_rms;now=frame.at_monotonic
        with self.lock:
            if self.stopping:return
            self.counters['audio_frames']+=1
            if self.capture_gap.is_set():
                self.capture_gap.clear()
                if self.span:self.span.abort();self.span=None
                self.preroll.clear();self.voiced_frames=0;self.counters['capture_gap_resets']+=1
            self._expire(now)
            if self._too_hot():
                if self.span:self.span.abort();self.span=None
                if self.phase!='THERMAL_PAUSE':self._cancel_response()
                self.phase='THERMAL_PAUSE';self.preroll.clear();return
            if self.phase=='THERMAL_PAUSE':self.phase='IDLE'
            if (self.playing or frame.reference_active) and not (self.full_duplex() and frame.aec_clean):
                self.preroll.clear();self.voiced_frames=0;self.counters['aec_degraded_frames']+=1;return
            if now<self.echo_guard_until and not self.full_duplex():return
            self.preroll.append(frame.pcm16)
            self.voiced_frames=min(self.voiced_frames+1,self.config.onset_frames+1) if voiced else 0
            if self.span:
                if not self.span.push(frame,voiced):
                    if self.span.overflow:self.counters['frame_overflow']+=1
                if now-self.span.last_voice>=self.config.silence_seconds:self.span.finish()
                return
            # One candidate per VAD rising edge. Continuous TV/noise cannot
            # rotate an unlimited chain of wake leases without a new pause.
            if self.voiced_frames!=self.config.onset_frames:return
            active=bool(self.pending) or now<self.dialog_until or self.phase in ('SPEAKING','THINKING')
            if not active and now<self.next_wake:return
            if self.phase in ('SPEAKING','THINKING'):
                self._cancel_response();self.counters['barge_in_events']+=1
            mode='confirm' if self.pending else 'dialog' if active else 'wake'
            limit=self.config.wake_audio_seconds if mode=='wake' else self.config.dialog_audio_seconds
            span=Span(self.generation,mode,now,list(self.preroll),limit)
            self.span=span;self.asr_job=span;self.phase='WAKE_CHECK' if mode=='wake' else 'LISTENING'
            self.next_wake=now+self.config.wake_cooldown_seconds;self.voiced_frames=0
            self.counters['asr_spans']+=1;self.condition.notify_all()

    def _expire(self,now):
        if self.pending and ((self.pending.expires is not None and now>self.pending.expires)
                or now>self.pending.prompt_deadline):
            self.pending=None;self.counters['confirmation_expired']+=1
            if not self.playing:self.phase='IDLE'
        if self.span and now-self.span.created>20:self.span.abort();self.span=None
        if self.phase=='LISTENING' and not self.span and not self.pending and now>self.dialog_until:
            self.phase='IDLE';self.history_clear.set();self.condition.notify_all()

    def tick(self):
        now=self.clock()
        if now-self.temperature_checked>=1:
            try:self.cached_temperature=self.temperature()
            except OSError:self.cached_temperature=None
            self.temperature_checked=now
        with self.lock:
            self._expire(now)
            if self._too_hot() and self.phase!='THERMAL_PAUSE':
                if self.span:self.span.abort();self.span=None
                self._cancel_response();self.pending=None;self.phase='THERMAL_PAUSE'

    def _maintenance_loop(self):
        while True:
            with self.condition:
                if self.stopping:return
                self.condition.wait(timeout=.5)
                if self.stopping:return
            self.tick()

    def _partial(self,span,text):
        with self.lock:
            if span is not self.span or span.generation!=self.generation:return
            if span.mode=='wake' and normalize(text).startswith(normalize(self.settings.wake_word)):
                span.mode='dialog';span.max_seconds=self.config.dialog_audio_seconds
                self.dialog_until=self.clock()+self.config.dialog_wait_seconds;self.phase='LISTENING'

    def _asr_loop(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda:self.stopping or self.asr_job is not None)
                if self.stopping:return
                span=self.asr_job;self.asr_job=None
            try:
                if span.origin_mode=='wake' and self.wake_detector is not None:
                    detection=self.wake_detector.detect(span)
                    with self.lock:
                        if self.span is span:self.span=None
                        if span.cancel.is_set() or span.generation!=self.generation or self.stopping:continue
                        if detection and normalize(detection.keyword)==normalize(self.settings.wake_word):
                            with span.condition:
                                tail=detection.remaining_pcm16+b''.join(span.frames);span.frames.clear();span.closed=True
                            frames=[tail[i:i+640] for i in range(0,len(tail),640)][-50:]
                            follow=Span(self.generation,'kws_dialog',self.clock(),frames,self.config.dialog_audio_seconds)
                            self.span=follow;self.asr_job=follow;self.dialog_until=self.clock()+self.config.dialog_wait_seconds
                            self.counters['acoustic_keyword_hits']+=1;self._say('我在，请说。');self.condition.notify_all()
                        else:self.phase='IDLE'
                    continue
                text=self.asr.recognize(span,lambda text:self._partial(span,text))
            except Exception:
                text='';self.counters['asr_failures']+=1
            with self.lock:
                if self.span is span:self.span=None
                if span.cancel.is_set() or span.generation!=self.generation or self.stopping:
                    if span.generation==self.generation and not self.stopping and not self._too_hot():
                        self.phase='CONFIRMING' if self.pending else 'LISTENING' if self.clock()<self.dialog_until else 'IDLE'
                    continue
                if not text:
                    self.phase='CONFIRMING' if self.pending else 'LISTENING' if self.clock()<self.dialog_until else 'IDLE'
                    continue
                self.handle_text(text,mode=span.origin_mode)

    def handle_text(self,text,*,mode='wake'):
        """Internal recognized text entry; tests may inject a fake ASR result."""
        with self.lock:
            if self.stopping or self._too_hot() or not isinstance(text,str) or len(text)>512:return
            s=normalize(text)
            if not s:return
            if self.clock()<self.last_spoken_until and s==normalize(self.last_spoken):
                self.counters['self_voice_rejected']+=1;return
            wake=normalize(self.settings.wake_word)
            if s.startswith(wake):text=s[len(wake):];s=normalize(text);mode='dialog'
            elif mode=='wake':self.phase='IDLE';return
            if self.pending:
                if s in ('不','不要','取消','算了','不改','不要改','取消修改'):
                    self.pending=None;self._say('好的，保持原来的唤醒词。');return
                if self.pending.expires is None:return # Prompt has not drained yet.
                if self.clock()>self.pending.expires:self.pending=None;return
                if s in ('是','是的','好','好的','确认','确定','改吧','同意','可以'):
                    candidate=self.pending.candidate
                    if self.wake_detector is not None:
                        self.pending.expires=None;self.pending.prompt_deadline=self.clock()+5
                        self.response_job=(self.generation,'commit_wake',candidate,self.response_cancel)
                        self.phase='THINKING';self.condition.notify_all();return
                    self.settings.save_wake(candidate);self.pending=None
                    self.history_clear.set()
                    self._say('好的，唤醒词已经更新。');return
                self._say('请说确认，或者取消。',confirmation=True);return
            self.dialog_until=self.clock()+self.config.dialog_wait_seconds
            if not s:self._say('我在，请说。');return
            intent=parse_intent(text)
            if mode=='kws_dialog' and intent.kind=='chat':
                # Only after acoustic KWS authority: a bounded leading fragment
                # may be the ASR's wrong transcription of the proven keyword.
                # No homophone list or single-character generic wake is used.
                for offset in range(1,min(len(s),9)):
                    candidate_intent=parse_intent(s[offset:])
                    if candidate_intent.kind not in ('chat','unsupported'):
                        intent=candidate_intent;break
            if intent.kind=='change_wake_word':self._propose_wake(intent.value);return
            if intent.kind=='cancel':
                self._cancel_response();self.phase='IDLE';self.dialog_until=0
                self.history_clear.set();self.condition.notify_all();return
            if intent.kind=='identity':self._say('我叫%s。'%self.settings.wake_word);return
            if intent.kind=='time':self._say(time_reply(self.wall_clock));return
            if intent.kind=='status':
                self._say('本机离线识别可用。'+('回声消除已验证，可打断。' if self.full_duplex() else '回声消除未验证，播报时暂不处理语音。'));return
            if intent.kind in ('volume','volume_delta'):
                value=int(intent.value) if intent.kind=='volume' else max(0,min(100,self.volume+int(intent.value)))
                if not self._too_hot():self.audio.set_volume(value);self.volume=value;self._say('音量已设为百分之%d。'%value)
                return
            if intent.kind in ('invalid_wake_word','invalid_volume'):
                self._say('这个设置不符合范围，请重新说。');return
            self.response_job=(self.generation,'query' if intent.kind=='query' else 'chat',str(intent.value or text)[:512],self.response_cancel)
            self.phase='THINKING';self.condition.notify_all()

    def _propose_wake(self,candidate):
        try:candidate=validate_wake(candidate)
        except ValueError:self._say('唤醒词格式不符合范围。');return
        if self.wake_detector is not None:
            self.response_job=(self.generation,'prepare_wake',candidate,self.response_cancel)
            self.phase='THINKING';self.condition.notify_all();return
        self.pending=PendingChange(candidate,self.generation,None,self.clock()+25)
        self._say('你想把唤醒词改为%s，请说确认或者取消。'%candidate,confirmation=True)

    def _say(self,text,confirmation=False):
        self.response_job=(self.generation,'say_confirm' if confirmation else 'say',str(text)[:120],self.response_cancel)
        self.phase='THINKING';self.condition.notify_all()

    def _response_loop(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda:self.stopping or self.response_job is not None or self.history_clear.is_set())
                if self.stopping:return
                clear=self.history_clear.is_set();self.history_clear.clear()
                job=self.response_job;self.response_job=None
            if clear and self.llm is not None and hasattr(self.llm,'clear_history'):
                try:self.llm.clear_history()
                except Exception:self.counters['history_clear_failures']+=1
            if job is None:continue
            generation,kind,text,cancel=job
            try:
                evidence=None
                if kind=='prepare_wake':
                    try:
                        compiled=self.wake_detector.validate_keyword(text)
                        if not compiled:raise ValueError('empty_keyword_compile')
                    except Exception:
                        with self.lock:
                            if generation==self.generation and not cancel.is_set():self._say('这个词的模型不支持，请换一个中文名称。')
                        continue
                    with self.lock:
                        if generation!=self.generation or cancel.is_set() or self.stopping:continue
                        self.pending=PendingChange(text,generation,None,self.clock()+25)
                        self._say('你想把唤醒词改为%s，请说确认或者取消。'%text,confirmation=True)
                    continue
                if kind=='commit_wake':
                    old=self.settings.wake_word;changed=False
                    try:
                        self.wake_detector.validate_keyword(text);self.wake_detector.set_keyword(text);changed=True
                        with self.lock:
                            if generation!=self.generation or cancel.is_set() or self.stopping or not self.pending or self.pending.candidate!=text:
                                raise RuntimeError('keyword_commit_cancelled')
                            self.settings.save_wake(text);self.pending=None;self.history_clear.set()
                            self._say('好的，唤醒词已经更新。')
                    except Exception:
                        # A lost RPC acknowledgement can leave native state
                        # uncertain even when the Python call raised.
                        try:self.wake_detector.set_keyword(old)
                        except Exception:self.counters['keyword_rollback_failed']+=1
                        with self.lock:
                            if generation==self.generation and not self.stopping:
                                self.pending=None;self._say('唤醒词更新没有成功，保持原设置。')
                    continue
                if kind in ('chat','query') and self.config.progress_cue:
                    cue=self.tts.synthesize('请稍等。',cancel)
                    if not isinstance(cue,AudioClip):cue=AudioClip(cue.pcm16,cue.sample_rate)
                    with self.lock:
                        if cancel.is_set() or generation!=self.generation or self.stopping:continue
                        self.play_token+=1;token=self.play_token
                        self.playing=True;self.phase='THINKING';self.last_spoken='请稍等。';self.last_spoken_until=self.clock()+25
                        self.audio.play(cue.pcm16,cue.sample_rate,generation=generation,
                            on_done=lambda g,ok,t=token:self._cue_done(g,ok,t))
                if kind=='query':
                    if not self.config.network_enabled:text='联网查询没有启用。'
                    else:
                        try:evidence=self.search.lookup(text,cancel,self.clock()+4)
                        except Exception:evidence=None;self.counters['query_failures']+=1
                        label='维基百科' if evidence and evidence.get('engine')=='wikipedia' else '搜索来源'
                        if evidence:
                            from urllib.parse import urlparse
                            source=urlparse(evidence['source_url']).hostname or ''
                            text='%s%s，来源%s：%s'%(label,evidence['title'],source,evidence['excerpt'])
                        else:text='没有查到可核对的来源。'
                elif kind=='chat':
                    if not self.llm:text='本机对话模型暂时不可用，可以问时间、状态或音量。'
                    else:
                        reply=self.llm.generate(text,cancel=cancel,deadline=self.clock()+self.config.llm_seconds,web_evidence=None)
                        with self.lock:
                            if generation!=self.generation or cancel.is_set():continue
                            if reply.intent and reply.intent.kind=='change_wake_word':self._propose_wake(reply.intent.value);continue
                        text=reply.text or '这次本机模型没有及时回答，请再问一次。'
                if cancel.is_set() or self._too_hot():continue
                clip=self.tts.synthesize(str(text)[:120],cancel)
                if not isinstance(clip,AudioClip):clip=AudioClip(clip.pcm16,clip.sample_rate)
                with self.lock:
                    if cancel.is_set() or generation!=self.generation or self.stopping:continue
                    self.last_spoken=str(text)[:120];self.last_spoken_until=self.clock()+25
                    prior_playing=self.playing
                    self.playing=True;self.phase='SPEAKING';self.counters['spoken_replies']+=1
                    self.play_token+=1;token=self.play_token
                    if prior_playing:self.audio.interrupt()
                    self.audio.play(clip.pcm16,clip.sample_rate,generation=generation,
                        on_done=lambda g,complete,t=token,c=(kind=='say_confirm'):self._play_done(g,complete,c,t))
            except Exception:
                with self.lock:
                    if generation==self.generation:
                        self.playing=False;self.phase='LISTENING';self.counters['response_failures']+=1

    def _cue_done(self,generation,completed,token):
        with self.lock:
            if generation!=self.generation or token!=self.play_token or self.stopping:return
            self.playing=False;self.echo_guard_until=self.clock()+.5
            self.preroll.clear();self.voiced_frames=0
            # Cue drain is not a conversational final reply. Keep THINKING.

    def _play_done(self,generation,completed,confirmation=False,token=None):
        with self.lock:
            if generation!=self.generation or self.stopping or token is not None and token!=self.play_token:return
            self.playing=False;self.echo_guard_until=self.clock()+.5
            if confirmation and self.pending:
                if completed:
                    self.pending.expires=self.clock()+self.config.confirmation_seconds
                    self.pending.prompt_deadline=self.pending.expires;self.phase='CONFIRMING'
                else:self.pending=None;self.phase='LISTENING'
            else:
                self.dialog_until=self.clock()+self.config.dialog_wait_seconds;self.phase='LISTENING'
            self.preroll.clear();self.voiced_frames=0

    def close(self):
        with self.condition:
            if self.stopping:return
            self.stopping=True;self.response_cancel.set()
            if self.span:self.span.abort()
            if self.asr_job:self.asr_job.abort()
            self.asr_job=None;self.response_job=None;self.preroll.clear();self.pending=None
            self.condition.notify_all()
        self.audio.interrupt();self.audio.close()
        for thread in self.threads:thread.join(timeout=3)
        for provider in (self.llm,self.tts,self.wake_detector):
            if provider is not None:
                if hasattr(provider,'clear_history'):provider.clear_history()
                if hasattr(provider,'close'):provider.close()
