"""Bounded voice controller with cancellation, typed skills and honest AEC status."""
from dataclasses import dataclass
from datetime import datetime
import collections
import json
import math
import re
import threading
import time
from asr_stream import Span
from conversation import Conversation
from interfaces import AudioClip,AudioCapabilities
from settings import validate_wake
from skills import EvidenceSearch,normalize,parse_intent,time_reply

MODEL_FAILURE_PHRASE='这次没有及时回答，请再问一次。'
ASR_NOTICE_PHRASE='我还没听清，请再说一遍。'
DIAGNOSTIC_TRACE_BYTES=1024
NOTICE_KINDS=('failure','asr_notice')

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
    diagnostic_seconds:float=0
    response_seconds:float=30

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
        self.conversation=Conversation(wake_word=settings.wake_word);self.turn_ticket=None
        self.play_token=0
        self.playback_kind=None;self.last_ack=-1e9
        self.last_response_error='none'
        self.post_ack_wait=False
        self.input_rms=0;self.input_peak=0;self.recent_peak=0;self.rms_window_at=clock()
        self.last_audio_at=None;self.last_accepted_voice_at=None;self.max_voice_run=0;self.input_voice_run=0
        self.post_ack_peak_rms=0;self.post_ack_longest_voiced_frames=0
        self.guard_voiced=collections.Counter();self.vad_starts=0;self.asr_active=None
        self.response_stage=None;self.response_stage_at=0;self.response_deadline=None;self.response_kind=None
        self.diagnostic_until=clock()+min(180,max(0,self.config.diagnostic_seconds))
        self.trace=collections.deque(maxlen=16)
        self.counters=collections.Counter();self.threads=[]

    def _trace(self,event,**fields):
        if self.clock()<self.diagnostic_until:
            self.trace.append({'event':event,'at':round(self.clock(),3),**fields})
            while self.trace and len(json.dumps(list(self.trace),ensure_ascii=False,separators=(',',':')).encode('utf8'))>DIAGNOSTIC_TRACE_BYTES:
                self.trace.popleft()

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
            conversation=self.conversation.status()
            mode=getattr(self.llm,'mode',None)
            if mode not in ('unknown','unavailable','legacy_current_turn','structured_history'):
                mode='unavailable' if self.llm is None else 'structured_history' if callable(getattr(self.llm,'generate_messages',None)) else 'legacy_current_turn'
            conversation.update(mode=mode,history_sent_to_model=mode=='structured_history')
            ready=bool(self.threads) and all(t.is_alive() for t in self.threads) and not self.stopping
            ready=ready and caps.microphone_available and caps.speaker_available and self.phase!='THERMAL_PAUSE'
            now=self.clock();span=self.asr_active or self.span
            remaining=lambda deadline:round(max(0,deadline-now),2) if deadline is not None else None
            return {'phase':self.phase,'ready':ready,'wake_word':self.settings.wake_word,'full_duplex':self.full_duplex(),
                'barge_in':bool(self.full_duplex() and self.wake_detector),'barge_in_mode':'wake_word',
                'aec_verified':self.audio.capabilities().aec_verified,
                'pending_wake_change':bool(self.pending),'recording_persisted':False,'transcript_logging':False,
                'public_listener':False,'queue_limits':{'asr':1,'response':1,'frame':Span.MAX_FRAMES,'preroll':25},
                'llm_configured':self.llm is not None,'network_enabled':self.config.network_enabled,
                'keyword_spotter_configured':self.wake_detector is not None,
                'thermal_sensor_available':self.cached_temperature is not None,
                'conversation':conversation,
                'last_response_error':self.last_response_error,
                'input':{'rms':self.input_rms,'peak':self.input_peak,'recent_peak':self.recent_peak if now-self.rms_window_at<=2 else 0,
                    'frame_age':round(max(0,now-self.last_audio_at),2) if self.last_audio_at is not None else None,
                    'voice_at':round(self.last_accepted_voice_at,3) if self.last_accepted_voice_at is not None else None,
                    'run':self.voiced_frames,'accepted_run':self.input_voice_run,'max_run':self.max_voice_run,'threshold':self.config.vad_rms,
                    'post_ack_peak_rms':self.post_ack_peak_rms,'post_ack_longest_voiced_frames':self.post_ack_longest_voiced_frames,
                    'onset':self.config.onset_frames,'starts':self.vad_starts,'guard_voiced':dict(self.guard_voiced)},
                'timing':{'dialog_left':remaining(self.dialog_until),'post_ack':self.post_ack_wait,'guard_left':remaining(self.echo_guard_until),
                    'stage':self.response_stage,'stage_age':round(max(0,now-self.response_stage_at),2) if self.response_stage else None,
                    'response_left':remaining(self.response_deadline),
                    'asr':{'mode':span.origin_mode,'age':round(max(0,now-span.created),2),'left':remaining(span.created+20),
                           'audio_s':round(span.samples/16000,2),'queued_frames':len(span.frames),'closed':span.closed,
                           'cancelled':span.cancel.is_set()} if span else None},
                'counters':dict(self.counters),
                **({'diagnostic_turns':list(self.trace),'diagnostic_expires_in':round(self.diagnostic_until-self.clock(),1)} if self.clock()<self.diagnostic_until else {})}

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

    def _cancel_response(self,guard=True):
        self.generation+=1;self.response_cancel.set();self.response_cancel=threading.Event()
        self.response_job=None
        self.response_stage=None;self.response_deadline=None;self.response_kind=None
        if self.turn_ticket is not None:self.conversation.cancel(self.turn_ticket)
        self.turn_ticket=None
        if self.playing:
            try:self.audio.interrupt()
            except Exception:self.last_response_error='speech_unavailable';self.counters['audio_interrupt_failures']+=1
        self.playing=False;self.playback_kind=None
        if guard:self.echo_guard_until=self.clock()+.5
        self.counters['interruptions']+=1

    def _begin_turn(self,text):
        # A new accepted utterance supersedes pending generation AND playback.
        # In-memory session methods never call the inference socket.
        if self.turn_ticket is not None or self.playing or self.response_job is not None or self.phase=='THINKING':
            self._cancel_response(guard=self.playing)
        self.last_response_error='none'
        self.post_ack_wait=False
        try:self.turn_ticket=self.conversation.begin_user(text)
        except ValueError:
            self.counters['conversation_input_rejected']+=1
            self._say('这句话太长，请简短说一遍。');return False
        return True

    def _clear_conversation(self):
        self.conversation.clear();self.turn_ticket=None
        self.history_clear.set();self.condition.notify_all()

    def _queue_notice(self,kind,error):
        """One local fixed notice closes this failed turn; it never opens another."""
        if self.response_kind in NOTICE_KINDS or self.response_job and self.response_job[1] in NOTICE_KINDS:return
        if self.span:self.span.abort();self.span=None
        if self.asr_job:self.asr_job.abort();self.asr_job=None
        if self.asr_active:self.asr_active.abort()
        self._cancel_response(guard=self.playing);self.pending=None;self.post_ack_wait=False;self.dialog_until=0
        self._clear_conversation();self.last_response_error=error
        if self.stopping or self._too_hot():self.phase='THERMAL_PAUSE' if self._too_hot() else 'IDLE';return
        text=ASR_NOTICE_PHRASE if kind=='asr_notice' else MODEL_FAILURE_PHRASE
        self.response_job=(self.generation,kind,text,self.response_cancel,None);self.phase='THINKING'
        self.counters['hearing_notices' if kind=='asr_notice' else 'model_failure_notices']+=1
        self.condition.notify_all()

    def _stage(self,name):
        self.response_stage=name;self.response_stage_at=self.clock()

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
            self.input_rms=min(32768,int(rms));self.input_peak=max(self.input_peak,self.input_rms);self.last_audio_at=now
            if now-self.rms_window_at>2:self.rms_window_at=now;self.recent_peak=0
            self.recent_peak=max(self.recent_peak,self.input_rms)
            self.counters['audio_frames']+=1
            if self.capture_gap.is_set():
                self.capture_gap.clear()
                if self.span:self.span.abort();self.span=None
                self.preroll.clear();self.voiced_frames=0;self.input_voice_run=0;self.counters['capture_gap_resets']+=1
            self._expire(now)
            if self._too_hot():
                self.input_voice_run=0
                if voiced:self.guard_voiced['thermal']+=1
                if self.span:self.span.abort();self.span=None
                if self.phase!='THERMAL_PAUSE':self._cancel_response()
                self.phase='THERMAL_PAUSE';self.preroll.clear();return
            if self.phase=='THERMAL_PAUSE':self.phase='IDLE'
            # Fixed ACK/cue/confirmation speech is not a user command stream.
            # Keep hardware capture running but do not transcribe its echo.
            if self.playing and (self.playback_kind in ('ack','cue','say_confirm','failure','asr_notice') or normalize(self.settings.wake_word) in normalize(self.last_spoken)):
                self.input_voice_run=0
                if voiced:self.guard_voiced['prompt']+=1
                self.preroll.clear();self.voiced_frames=0;self.counters['prompt_guard_frames']+=1;return
            if (self.playing or frame.reference_active) and not (self.full_duplex() and frame.aec_clean):
                self.input_voice_run=0
                if voiced:self.guard_voiced['aec']+=1
                self.preroll.clear();self.voiced_frames=0;self.counters['aec_degraded_frames']+=1;return
            if now<self.echo_guard_until:
                if self.span and self.span.origin_mode=='kws_dialog' and frame.aec_clean:
                    # A confirmed user keyword has already authorized this
                    # ongoing utterance. Preserve its command suffix while
                    # preventing a new VAD decision on the speaker tail.
                    accepted=self.span.push(frame,voiced)
                    if accepted and voiced:self.last_accepted_voice_at=now
                    if now-self.span.last_voice>=self.config.silence_seconds:self.span.finish()
                    return
                if voiced:self.guard_voiced['tail']+=1
                self.input_voice_run=0
                self.preroll.clear();self.voiced_frames=0;self.counters['echo_tail_guard_frames']+=1;return
            self.preroll.append(frame.pcm16)
            self.voiced_frames=min(self.voiced_frames+1,self.config.onset_frames+1) if voiced else 0
            self.input_voice_run=min(2**31-1,self.input_voice_run+1) if voiced else 0
            self.max_voice_run=max(self.max_voice_run,self.input_voice_run)
            if self.post_ack_wait:
                self.post_ack_peak_rms=max(self.post_ack_peak_rms,self.input_rms)
                self.post_ack_longest_voiced_frames=max(self.post_ack_longest_voiced_frames,self.input_voice_run)
            if self.span:
                accepted=self.span.push(frame,voiced)
                if accepted and voiced:self.last_accepted_voice_at=now
                if not accepted:
                    if self.span.overflow:self.counters['frame_overflow']+=1
                if now-self.span.last_voice>=self.config.silence_seconds:self.span.finish()
                return
            if voiced:self.last_accepted_voice_at=now
            # One candidate per VAD rising edge. Continuous TV/noise cannot
            # rotate an unlimited chain of wake leases without a new pause.
            if self.voiced_frames!=self.config.onset_frames:return
            active=bool(self.pending) or now<self.dialog_until or self.phase in ('SPEAKING','THINKING')
            if not active and now<self.next_wake:return
            if self.phase in ('SPEAKING','THINKING'):
                # A VAD rise is not proof of a new speaker. Require the actual
                # current acoustic keyword before cancelling model/playback.
                if not self.full_duplex() or self.wake_detector is None:
                    self.preroll.clear();self.voiced_frames=0;return
                span=Span(self.generation,'barge_wake',now,list(self.preroll),self.config.wake_audio_seconds)
                self.span=span;self.asr_job=span;self.voiced_frames=0
                self.vad_starts+=1
                self.counters['barge_candidates']+=1;self.condition.notify_all();return
            mode='confirm' if self.pending else 'dialog' if active else 'wake'
            limit=self.config.wake_audio_seconds if mode=='wake' else self.config.dialog_audio_seconds
            span=Span(self.generation,mode,now,list(self.preroll),limit)
            self.span=span;self.asr_job=span;self.phase='WAKE_CHECK' if mode=='wake' else 'LISTENING'
            self.vad_starts+=1
            self.next_wake=now+self.config.wake_cooldown_seconds;self.voiced_frames=0
            self.counters['asr_spans']+=1;self.condition.notify_all()

    def _expire(self,now):
        if self.pending and ((self.pending.expires is not None and now>self.pending.expires)
                or now>self.pending.prompt_deadline):
            self.pending=None;self.counters['confirmation_expired']+=1
            if not self.playing:self.phase='IDLE'
        if self.response_deadline is not None and now>self.response_deadline:
            self.counters['response_deadlines']+=1
            if self.response_kind in NOTICE_KINDS:
                self._cancel_response();self.phase='IDLE';self.post_ack_wait=False;self.dialog_until=0
                self.last_response_error='fallback_unavailable'
            else:self._queue_notice('failure','response_deadline')
        if self.span and now-self.span.created>20:
            mode=self.span.origin_mode
            if mode in ('dialog','confirm'):self._queue_notice('asr_notice','asr_deadline')
            else:self.span.abort();self.span=None
        if self.phase=='LISTENING' and not self.span and not self.pending and now>self.dialog_until:
            if self.post_ack_wait:self._queue_notice('asr_notice','no_speech')
            else:self.phase='IDLE';self._clear_conversation()

    def tick(self):
        now=self.clock()
        if now-self.temperature_checked>=1:
            try:self.cached_temperature=self.temperature()
            except OSError:self.cached_temperature=None
            self.temperature_checked=now
        with self.lock:
            if now>=self.diagnostic_until and self.trace:self.trace.clear()
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
                span=self.asr_job;self.asr_job=None;self.asr_active=span
            asr_error=False
            try:
                if span.origin_mode in ('wake','barge_wake') and self.wake_detector is not None:
                    detection=self.wake_detector.detect(span)
                    with self.lock:
                        if self.span is span:self.span=None
                        if span.cancel.is_set() or span.generation!=self.generation or self.stopping:continue
                        if detection and normalize(detection.keyword)==normalize(self.settings.wake_word):
                            if span.origin_mode=='barge_wake':
                                self._cancel_response();self.counters['barge_in_events']+=1
                            with span.condition:
                                tail=detection.remaining_pcm16+b''.join(span.frames);span.frames.clear();span.closed=True
                            frames=[tail[i:i+640] for i in range(0,len(tail),640)]
                            if len(frames)>Span.MAX_FRAMES or any(len(frame)!=640 for frame in frames):
                                self.counters['wake_replay_overflow']+=1;self._ack();continue
                            follow=Span(self.generation,'kws_dialog',self.clock(),frames[:50],self.config.dialog_audio_seconds)
                            from interfaces import AudioFrame
                            for frame in frames[50:]:follow.push(AudioFrame(frame,True,self.clock()),True)
                            self.span=follow;self.asr_job=follow;self.dialog_until=self.clock()+self.config.dialog_wait_seconds
                            self.phase='LISTENING';self.counters['acoustic_keyword_hits']+=1
                            # Finish the same utterance before speaking: an
                            # early ACK otherwise overlaps the user's command.
                            self._trace('keyword',word=detection.keyword);self.condition.notify_all()
                        elif span.origin_mode=='wake':self.phase='IDLE'
                    continue
                text=self.asr.recognize(span,lambda text:self._partial(span,text))
            except Exception:
                text='';asr_error=True;self.counters['asr_failures']+=1
            finally:
                with self.lock:
                    if self.asr_active is span:self.asr_active=None
            with self.lock:
                if self.span is span:self.span=None
                if span.cancel.is_set() or span.generation!=self.generation or self.stopping:
                    if span.generation==self.generation and not self.stopping and not self._too_hot():
                        self.phase='CONFIRMING' if self.pending else 'LISTENING' if self.clock()<self.dialog_until else 'IDLE'
                    continue
                if not text:
                    if span.origin_mode=='kws_dialog':self._ack()
                    elif span.origin_mode in ('dialog','confirm'):self._queue_notice('asr_notice','asr_error' if asr_error else 'asr_empty')
                    else:self.phase='CONFIRMING' if self.pending else 'LISTENING' if self.clock()<self.dialog_until else 'IDLE'
                    continue
                try:self.handle_text(text,mode=span.origin_mode)
                except Exception:
                    # A mixer/settings I/O failure must not kill recognition.
                    self.counters['dispatch_failures']+=1;self._queue_notice('failure','skill_unavailable')

    def handle_text(self,text,*,mode='wake'):
        """Internal recognized text entry; tests may inject a fake ASR result."""
        with self.lock:
            if self.stopping or self._too_hot() or not isinstance(text,str) or len(text)>512:return
            s=normalize(text)
            if not s:return
            self._trace('recognized',mode=mode,text=text[:160])
            if self.clock()<self.last_spoken_until and s==normalize(self.last_spoken):
                self.counters['self_voice_rejected']+=1;return
            wake=normalize(self.settings.wake_word)
            acoustic_follow=mode=='kws_dialog'
            verified_prefix=s.startswith(wake)
            if re.fullmatch('(?:'+re.escape(wake)+'){1,8}',s):
                self.counters['wake_only_utterances']+=1;self._ack();return
            if s.startswith(wake):
                while s.startswith(wake):s=s[len(wake):]
                text=s;mode='dialog'
            elif mode=='wake':self.phase='IDLE';return
            if self.pending:
                if s in ('不','不要','取消','算了','不改','不要改','取消修改'):
                    if not self._begin_turn(text):return
                    self.pending=None;self._say('好的，保持原来的唤醒词。');return
                if self.pending.expires is None:return # Prompt has not drained yet.
                if self.clock()>self.pending.expires:self.pending=None;return
                if s in ('是','是的','好','好的','确认','确定','改吧','同意','可以'):
                    if not self._begin_turn(text):return
                    candidate=self.pending.candidate
                    if self.wake_detector is not None:
                        self.pending.expires=None;self.pending.prompt_deadline=self.clock()+5
                        self.response_job=(self.generation,'commit_wake',candidate,self.response_cancel,self.turn_ticket)
                        self.phase='THINKING';self.condition.notify_all();return
                    self.settings.save_wake(candidate);self.pending=None
                    self.conversation.set_wake_word(candidate);self._clear_conversation()
                    self.turn_ticket=self.conversation.begin_user(text)
                    self._say('好的，唤醒词已经更新。');return
                if not self._begin_turn(text):return
                self._say('请说确认，或者取消。',confirmation=True);return
            self.dialog_until=self.clock()+self.config.dialog_wait_seconds
            if not s:self._ack();return
            own=normalize(self.last_spoken)
            if self.clock()<self.last_spoken_until and not self.pending and len(s)>=2 and s in own:
                self.counters['self_voice_fragment_rejected']+=1;self._trace('self_fragment');return
            intent=parse_intent(text)
            if acoustic_follow and intent.kind=='chat':
                # Only after acoustic KWS authority: a bounded leading fragment
                # may be the ASR's wrong transcription of the proven keyword.
                # No homophone list or single-character generic wake is used.
                for offset in range(1,min(len(s),9)):
                    candidate_intent=parse_intent(s[offset:])
                    if candidate_intent.kind not in ('chat','unsupported'):
                        intent=candidate_intent;break
                if intent.kind=='chat' and not verified_prefix:
                    # Initial KWS replay with an unverified free-text prefix is
                    # not a complete question. Ask for a fresh post-ACK turn.
                    self.counters['uncertain_wake_replay']+=1;self._ack();return
            self._trace('intent',kind=intent.kind)
            if intent.kind=='cancel':
                self._cancel_response();self.phase='IDLE';self.dialog_until=0;self.post_ack_wait=False
                self._clear_conversation();return
            if not self._begin_turn(text):return
            if intent.kind=='change_wake_word':self._propose_wake(intent.value);return
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
            self.response_job=(self.generation,'query' if intent.kind=='query' else 'chat',str(intent.value or text)[:512],self.response_cancel,self.turn_ticket)
            self.phase='THINKING';self.condition.notify_all()

    def _ack(self):
        self.dialog_until=self.clock()+self.config.dialog_wait_seconds
        if self.playing and self.playback_kind=='ack' or self.response_job and self.response_job[1]=='ack' or self.clock()-self.last_ack<2:
            self.counters['duplicate_ack_suppressed']+=1;return
        if self.turn_ticket is not None or self.playing or self.response_job is not None:self._cancel_response()
        self.last_ack=self.clock();self.response_job=(self.generation,'ack','我在，请说。',self.response_cancel,None)
        self.phase='THINKING';self.condition.notify_all()

    def _propose_wake(self,candidate):
        try:candidate=validate_wake(candidate)
        except ValueError:self._say('唤醒词格式不符合范围。');return
        if self.wake_detector is not None:
            self.response_job=(self.generation,'prepare_wake',candidate,self.response_cancel,self.turn_ticket)
            self.phase='THINKING';self.condition.notify_all();return
        self.pending=PendingChange(candidate,self.generation,None,self.clock()+25)
        self._say('你想把唤醒词改为%s，请说确认或者取消。'%candidate,confirmation=True)

    def _say(self,text,confirmation=False):
        self.response_job=(self.generation,'say_confirm' if confirmation else 'say',str(text)[:120],self.response_cancel,self.turn_ticket)
        self.phase='THINKING';self.condition.notify_all()

    def _response_loop(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda:self.stopping or self.response_job is not None or self.history_clear.is_set())
                if self.stopping:return
                clear=self.history_clear.is_set();self.history_clear.clear()
                job=self.response_job;self.response_job=None
                if job is not None and job[0]==self.generation and not job[3].is_set():
                    self.response_kind=job[1];self.response_deadline=self.clock()+(6 if job[1] in NOTICE_KINDS else max(1,min(30,self.config.response_seconds)))
                    self._stage('notice' if job[1] in NOTICE_KINDS else 'preparing')
            if clear and self.llm is not None and hasattr(self.llm,'clear_history'):
                try:self.llm.clear_history()
                except Exception:self.counters['history_clear_failures']+=1
            if job is None:continue
            generation,kind,text,cancel,ticket=job
            stage='prepare'
            try:
                with self.lock:
                    if generation!=self.generation or cancel.is_set() or self.stopping:continue
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
                            confirmed_text=self.conversation.simple_chat_messages(ticket)[-1]['content']
                            self.settings.save_wake(text);self.pending=None
                            self.conversation.set_wake_word(text);self._clear_conversation()
                            self.turn_ticket=self.conversation.begin_user(confirmed_text)
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
                    with self.lock:self._stage('cue_tts')
                    cue=self.tts.synthesize('请稍等。',cancel)
                    if not isinstance(cue,AudioClip):cue=AudioClip(cue.pcm16,cue.sample_rate)
                    with self.lock:
                        if cancel.is_set() or generation!=self.generation or self.stopping:continue
                        self.play_token+=1;token=self.play_token
                        self.playing=True;self.phase='THINKING';self.last_spoken='请稍等。';self.last_spoken_until=self.clock()+25
                        self.playback_kind='cue'
                        self.audio.play(cue.pcm16,cue.sample_rate,generation=generation,
                            on_done=lambda g,ok,t=token:self._cue_done(g,ok,t))
                if kind=='query':
                    with self.lock:self._stage('query')
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
                        stage='model'
                        with self.lock:
                            if generation!=self.generation or cancel.is_set() or self.stopping:continue
                            self._stage('model')
                            messages=self.conversation.simple_chat_messages(ticket)
                        if callable(getattr(self.llm,'generate_messages',None)):
                            reply=self.llm.generate_messages(messages,cancel=cancel,deadline=self.clock()+self.config.llm_seconds)
                        else:
                            # Legacy adapters remain usable for rollback. Only
                            # the structured provider receives session history.
                            reply=self.llm.generate(text,cancel=cancel,deadline=self.clock()+self.config.llm_seconds,web_evidence=None)
                        with self.lock:
                            if generation!=self.generation or cancel.is_set():continue
                            if reply.intent and reply.intent.kind=='change_wake_word':self._propose_wake(reply.intent.value);continue
                        if not isinstance(reply.text,str) or not reply.text.strip():raise RuntimeError('empty_model_reply')
                        text=reply.text
                if cancel.is_set() or self._too_hot():continue
                stage='speech'
                with self.lock:
                    if generation!=self.generation or cancel.is_set() or self.stopping:continue
                    self._stage('notice' if kind in NOTICE_KINDS else 'tts')
                if kind=='asr_notice':clip=self.tts.synthesize_notice(text,cancel)
                elif kind=='failure':clip=self.tts.synthesize_failure(cancel)
                else:clip=self.tts.synthesize(str(text)[:120],cancel)
                if not isinstance(clip,AudioClip):clip=AudioClip(clip.pcm16,clip.sample_rate)
                with self.lock:
                    if cancel.is_set() or generation!=self.generation or self.stopping or self._too_hot():continue
                    self.last_spoken=str(text)[:120];self.last_spoken_until=self.clock()+25
                    if ticket is not None:self.conversation.model_completed(ticket,self.last_spoken)
                    self.playback_kind=kind;self._trace('reply',text=str(text)[:160],kind=kind)
                    prior_playing=self.playing
                    self.playing=True;self.phase='SPEAKING';self.counters['spoken_replies']+=1
                    self._stage('playing');self.response_deadline=self.clock()+min(22,len(clip.pcm16)/(clip.sample_rate*2)+2)
                    self.play_token+=1;token=self.play_token
                    if prior_playing:self.audio.interrupt()
                    self.audio.play(clip.pcm16,clip.sample_rate,generation=generation,
                        on_done=lambda g,complete,t=token,c=(kind=='say_confirm'),turn=ticket,f=(kind in NOTICE_KINDS):self._play_done(g,complete,c,t,turn,f))
            except Exception:
                with self.lock:
                    if generation==self.generation:
                        if ticket is not None:self.conversation.cancel(ticket)
                        if self.turn_ticket==ticket:self.turn_ticket=None
                        self.play_token+=1
                        if self.playing:
                            try:self.audio.interrupt()
                            except Exception:self.counters['audio_interrupt_failures']+=1
                        self.playing=False;self.playback_kind=None;self.counters['response_failures']+=1
                        error='model_unavailable' if stage=='model' else 'speech_unavailable'
                        if kind in NOTICE_KINDS:
                            self.response_stage=None;self.response_deadline=None;self.response_kind=None
                            self.phase='IDLE';self.dialog_until=0;self.post_ack_wait=False;self.last_response_error='fallback_unavailable'
                        elif not cancel.is_set() and not self.stopping:
                            self._queue_notice('failure',error)

    def _cue_done(self,generation,completed,token):
        with self.lock:
            if generation!=self.generation or token!=self.play_token or self.stopping:return
            self.play_token+=1 # Consume completion; duplicate drains are stale.
            self.playing=False;self.echo_guard_until=self.clock()+.5
            self.playback_kind=None
            self.preroll.clear();self.voiced_frames=0;self.input_voice_run=0
            # Cue drain is not a conversational final reply. Keep THINKING.
            if not completed:self._queue_notice('failure','speech_unavailable')

    def _play_done(self,generation,completed,confirmation=False,token=None,ticket=None,failure=False):
        with self.lock:
            if generation!=self.generation or self.stopping or token is not None and token!=self.play_token:return
            self.play_token+=1 # A completed transport callback is single-use.
            completed_kind=self.playback_kind
            if not completed:self.last_response_error='fallback_unavailable' if failure else 'speech_unavailable'
            if ticket is not None:
                self.conversation.playback_completed(ticket,succeeded=bool(completed))
                if self.turn_ticket==ticket:self.turn_ticket=None
            self.playing=False;self.echo_guard_until=self.clock()+.5
            self.playback_kind=None
            self.response_stage=None;self.response_deadline=None;self.response_kind=None
            if failure:
                self.phase='IDLE';self.dialog_until=0;self.post_ack_wait=False;self.pending=None;self._clear_conversation()
            elif not completed:
                self._queue_notice('failure','speech_unavailable')
            elif confirmation and self.pending:
                if completed:
                    self.pending.expires=self.clock()+self.config.confirmation_seconds
                    self.pending.prompt_deadline=self.pending.expires;self.phase='CONFIRMING'
                else:self.pending=None;self.phase='LISTENING'
            else:
                self.dialog_until=self.clock()+self.config.dialog_wait_seconds;self.phase='LISTENING'
                self.post_ack_wait=completed_kind=='ack'
                if self.post_ack_wait:self.post_ack_peak_rms=0;self.post_ack_longest_voiced_frames=0
            self.preroll.clear();self.voiced_frames=0;self.input_voice_run=0

    def close(self):
        with self.condition:
            if self.stopping:return
            self.stopping=True;self.response_cancel.set()
            self.conversation.clear();self.turn_ticket=None
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
