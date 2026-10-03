#!/usr/bin/env python3
"""Bounded, simultaneous Dior PCM capture/playback and Speex acoustic AEC.

The one I/O thread writes the actual speaker reference before reading the same
card's microphone. No audio is written to disk. Mixer values are restored on
close. Completed means the hardware pointer passed the last voice frame.
"""
import array
import collections
import ctypes as C
import dataclasses
import math
from pathlib import Path
import re
import random
import threading
import time

from audio_controls import Alsa, COMMON, FULL, SPEAKER_END, MIC, preflight
from interfaces import AudioFrame, AudioCapabilities

RATE = 16000
FRAME = 640
VOICE_RATE = 16000
VOICE_FRAME = 320

def rms(raw):
    values = array.array('h', raw)
    if not values: return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))

class Speex:
    def __init__(self):
        self.lib = C.CDLL('libspeexdsp.so.1')
        P, I, U, S = C.c_void_p, C.c_int, C.c_uint, C.POINTER(C.c_int16)
        signatures = {
            'speex_resampler_init': (P, [U,U,U,I,C.POINTER(I)]),
            'speex_resampler_process_int': (I, [P,U,S,C.POINTER(U),S,C.POINTER(U)]),
            'speex_resampler_destroy': (None, [P]),
            'speex_echo_state_init': (P, [I,I]),
            'speex_echo_cancellation': (None, [P,S,S,S]),
            'speex_echo_ctl': (I, [P,I,P]),
            'speex_echo_state_reset': (None, [P]),
            'speex_echo_state_destroy': (None, [P]),
            'speex_preprocess_state_init': (P, [I,I]),
            'speex_preprocess_run': (I, [P,S]),
            'speex_preprocess_ctl': (I, [P,I,P]),
            'speex_preprocess_state_destroy': (None, [P]),
        }
        for name, (result,args) in signatures.items():
            fn = getattr(self.lib,name); fn.restype=result; fn.argtypes=args
    def resampler(self, source, target): return Resampler(self, source, target)

class Resampler:
    def __init__(self, dsp, source, target):
        self.dsp, self.source, self.target = dsp, source, target
        error=C.c_int(); self.state=dsp.lib.speex_resampler_init(1,source,target,3,C.byref(error))
        if not self.state or error.value: raise RuntimeError('resampler_init_failed')
    def process(self, raw):
        count=len(raw)//2
        if not count: return b''
        source=(C.c_int16*count).from_buffer_copy(raw)
        bound=math.ceil(count*self.target/self.source)+128
        target=(C.c_int16*bound)(); used=C.c_uint(count); produced=C.c_uint(bound)
        result=self.dsp.lib.speex_resampler_process_int(self.state,0,source,C.byref(used),target,C.byref(produced))
        if result or used.value!=count: raise RuntimeError('resampler_transfer_failed')
        return C.string_at(target,produced.value*2)
    def close(self):
        if self.state: self.dsp.lib.speex_resampler_destroy(self.state); self.state=None

class Echo:
    def __init__(self,dsp,preprocess=True,reference_delay_samples=0):
        self.dsp=dsp; self.echo=dsp.lib.speex_echo_state_init(VOICE_FRAME,2560)
        if reference_delay_samples%320:raise ValueError('echo_delay_frame_alignment')
        self.reference_delay=collections.deque([bytes(640)]*(reference_delay_samples//320))
        if not self.echo: raise RuntimeError('echo_init_failed')
        rate=C.c_int(VOICE_RATE)
        if dsp.lib.speex_echo_ctl(self.echo,24,C.byref(rate)): raise RuntimeError('echo_rate_failed')
        self.pre=dsp.lib.speex_preprocess_state_init(VOICE_FRAME,VOICE_RATE) if preprocess else None
        if preprocess and not self.pre: raise RuntimeError('preprocessor_init_failed')
        if self.pre:
            self.ctl(0,1); self.ctl(2,0)
            self.ctl(18,-12); self.ctl(20,-35); self.ctl(22,-10)
            if dsp.lib.speex_preprocess_ctl(self.pre,24,self.echo): raise RuntimeError('residual_echo_setup_failed')
    def ctl(self,key,value):
        value=C.c_int(value)
        if self.dsp.lib.speex_preprocess_ctl(self.pre,key,C.byref(value)): raise RuntimeError('preprocessor_control_failed')
    def process(self,near,far):
        if len(near)!=640 or len(far)!=640: raise ValueError('echo_frame_size')
        if self.reference_delay:
            self.reference_delay.append(far);far=self.reference_delay.popleft()
        inp=(C.c_int16*VOICE_FRAME).from_buffer_copy(near)
        ref=(C.c_int16*VOICE_FRAME).from_buffer_copy(far)
        out=(C.c_int16*VOICE_FRAME)()
        self.dsp.lib.speex_echo_cancellation(self.echo,inp,ref,out)
        before=C.string_at(out,640)
        if self.pre: self.dsp.lib.speex_preprocess_run(self.pre,out)
        return C.string_at(out,640),before
    def flush_reference(self):
        length=len(self.reference_delay)
        self.reference_delay.clear();self.reference_delay.extend([bytes(640)]*length)
    def reset(self):
        self.dsp.lib.speex_echo_state_reset(self.echo);self.flush_reference()
    def close(self):
        if self.pre: self.dsp.lib.speex_preprocess_state_destroy(self.pre); self.pre=None
        if self.echo: self.dsp.lib.speex_echo_state_destroy(self.echo); self.echo=None

@dataclasses.dataclass
class Playback:
    pcm:bytes
    generation:int
    on_done:object
    position:int=0

class DiorAudio:
    def __init__(self,*,volume=35,aec_verified=False,measure=None,bootstrap=False):
        if not isinstance(volume,int) or not 0<=volume<=100: raise ValueError('volume_range')
        self.volume=volume; self.aec_verified=bool(aec_verified); self.measure=measure
        self.bootstrap=bool(bootstrap);self.warming=False
        self.control_lock=threading.Lock(); self.lock=threading.Lock()
        self.stop=threading.Event(); self.flush=threading.Event()
        self.thread=None; self.audio=None; self.dsp=None; self.echo=None
        self.capture=C.c_void_p(); self.playback=C.c_void_p()
        self.changed=[]; self.clip=None; self.pending=None; self.on_frame=None
        self.notifications=collections.deque(maxlen=4);self.interrupt_requested_at=None;self.last_interrupt_flush_seconds=None
        self.cancel_drain_target=None
        self.playback_boundary=None
        self.callback_condition=threading.Condition();self.callback_queue=collections.deque()
        self.callback_stopping=False;self.callback_thread=None
        self.frames=0; self.xruns=0; self.last_error=None; self.cancel_count=0;self.xrun_events=[]
        self.resamplers=[]; self.cpu_seconds=0.0; self._started=False
    def capabilities(self):
        return AudioCapabilities(microphone_available=self._started,speaker_available=self._started,
            simultaneous_capture_playback=self._started,aec_available=self.echo is not None,
            aec_verified=self._started and self.aec_verified and self.xruns==0 and not self.warming)
    def _pcm(self,handle,reading):
        a=self.audio; a.check(a.pcm_open(C.byref(handle),b'hw:0,0',int(reading),1),'PCM open')
        a.check(a.pcm_set_params(handle,2,3,1,RATE,0,160000),'PCM params')
        size=C.c_ulong();period=C.c_ulong()
        a.check(a.pcm_get_params(handle,C.byref(size),C.byref(period)),'PCM sizes')
        if not 320<=size.value<=RATE//5 or not 0<period.value<=RATE//10: raise RuntimeError('unexpected_pcm_buffer')
        return size.value,period.value
    def start(self,on_frame):
        if self.thread: raise RuntimeError('already_started')
        self.on_frame=on_frame
        calibration=None
        if self.bootstrap and self.aec_verified and self.volume:
            # Prepared before the real-time thread starts. This one short,
            # fixed startup excitation trains the empty filter; no mic data
            # is saved and no wake interpretation occurs during adaptation.
            generator=random.Random(71163);samples=array.array('h');last=0.
            for index in range(32000):
                last=.45*last+.55*generator.randint(-3500,3500)
                envelope=max(0,min(1,index/320,(31999-index)/320))
                samples.append(int(last*envelope))
            calibration=samples.tobytes()
        try:
            self.audio=Alsa(); self.dsp=Speex(); self.echo=Echo(self.dsp,reference_delay_samples=1920)
            profile=[(name,kind,8 if name=='SPK DRV Volume' else value,bounds) for name,kind,value,bounds in COMMON]
            profile += [(name,kind,84 if name=='RX4 Digital Volume' else 0 if name=='COMP0 Switch' else value,bounds) for name,kind,value,bounds in FULL]
            profile += SPEAKER_END+MIC
            prepared=preflight(self.audio,profile)
            for element,original,desired in prepared:
                self.changed.append((element,original))
                if original!=desired: element.write(desired)
            self.capture_sizes=self._pcm(self.capture,True)
            self.playback_sizes=self._pcm(self.playback,False)
            self.playback_boundary=self.audio.pcm_boundary(self.playback)
            # Every outstanding speech target is at most one PCM buffer away.
            # Keep that distance strictly below half the real pointer ring;
            # raw pointer ordering would fail at ARM32 boundary rollover.
            if self.playback_boundary<=2*self.playback_sizes[0] or self.playback_boundary%self.playback_sizes[0]:
                raise RuntimeError('unexpected_playback_pointer_boundary')
            if self.aec_verified and (self.capture_sizes!=(2560,640) or self.playback_sizes!=(2560,640)):
                raise RuntimeError('qualified_pcm_geometry_mismatch')
            self.set_volume(self.volume)
            # Start playback with two frames rather than waiting for the full
            # software buffer. Capture then advances on the same card clock.
            self._transfer(self.playback,bytes(self.playback_sizes[0]*2),self.playback_sizes[0],False)
            if self.audio.pcm_state(self.playback)!=3:self.audio.check(self.audio.pcm_start(self.playback),'playback start')
            self.audio.check(self.audio.pcm_start(self.capture),'capture start')
            self._started=True
            self.warming=calibration is not None
            self.callback_thread=threading.Thread(target=self._callback_loop,name='dior-audio-completion',daemon=True)
            self.callback_thread.start()
            self.thread=threading.Thread(target=self._io,name='dior-pcm-duplex',daemon=True)
            self.thread.start()
            if calibration:
                completed=threading.Event();success=[]
                def adapted(_generation,ok):success.append(ok);completed.set()
                self.play(calibration,16000,generation=-1,on_done=adapted)
                if not completed.wait(5) or success!=[True]:raise RuntimeError('echo_bootstrap_failed')
                self.warming=False
        except Exception:
            self.close(); raise
    def set_volume(self,value):
        if not isinstance(value,int) or isinstance(value,bool) or not 0<=value<=100: raise ValueError('volume_range')
        with self.control_lock:
            if self.audio: self.audio.elements['SPK DAC Switch'].write([int(value>0)])
            with self.lock: self.volume=value
    def _notify(self,clip,completed):
        if not clip: return
        with self.callback_condition:
            if len(self.callback_queue)>=4:self.last_error='playback_callback_queue_limit';return
            self.callback_queue.append((clip,completed));self.callback_condition.notify_all()
    def _callback_loop(self):
        while True:
            with self.callback_condition:
                self.callback_condition.wait_for(lambda:self.callback_stopping or self.callback_queue)
                if not self.callback_queue and self.callback_stopping:return
                clip,completed=self.callback_queue.popleft()
            try:clip.on_done(clip.generation,completed)
            except Exception:self.last_error='playback_callback_failed'
    def interrupt(self):
        with self.lock:
            old=self.clip; self.clip=None; pending=self.pending; self.pending=None
            self.cancel_count+=int(old is not None or pending is not None);self.flush.set()
            if old:self.notifications.append(old)
            if pending:self.notifications.append(pending[0])
            self.interrupt_requested_at=time.monotonic()
    def _drain_notifications(self):
        while True:
            with self.lock:
                if not self.notifications:return
                clip=self.notifications.popleft()
            self._notify(clip,False)
    def play(self,pcm16,rate,*,generation,on_done):
        if not self._started or self.last_error: raise RuntimeError('audio_not_ready')
        if rate not in (8000,16000,22050,24000,44100,48000) or not isinstance(pcm16,bytes) or len(pcm16)%2 or not 0<len(pcm16)<=rate*2*20: raise ValueError('bounded_pcm_clip')
        if rate!=16000:
            resampler=self.dsp.resampler(rate,16000)
            try: pcm16=resampler.process(pcm16+bytes(math.ceil(rate*.025)*2))
            finally: resampler.close()
            pcm16=pcm16[:math.ceil(len(pcm16)/2)*2]
            if len(pcm16)>16000*2*20: raise ValueError('resampled_clip_limit')
        with self.lock:
            if self.clip or self.pending: raise RuntimeError('playback_busy')
            self.clip=Playback(pcm16,generation,on_done)
    def _transfer(self,handle,payload,frames,reading):
        a=self.audio; channels=1
        if reading: buffer=(C.c_int16*frames)()
        else: buffer=C.create_string_buffer(payload)
        done=0; deadline=time.monotonic()+.5
        while done<frames and not self.stop.is_set():
            if time.monotonic()>deadline: raise RuntimeError('pcm_transfer_deadline')
            pointer=C.cast(C.byref(buffer,done*channels*2),C.c_void_p)
            value=int((a.pcm_readi if reading else a.pcm_writei)(handle,pointer,frames-done))
            if value in (0,-11):
                wait=int(a.pcm_wait(handle,20))
                if wait<0 and wait!=-11: a.check(wait,'PCM wait')
                continue
            if value==-32:
                if len(self.xrun_events)<16:self.xrun_events.append({'reading':reading,'frame':self.frames})
                self.xruns+=1
                # The qualified echo profile depends on continuous sample
                # clocks. Reopen both PCMs through the service supervisor;
                # preparing one side would silently leave AEC degraded.
                raise RuntimeError('pcm_xrun_requires_reopen')
            a.check(value,'PCM transfer')
            if value>frames-done: raise RuntimeError('pcm_transfer_overrun')
            done+=value
        return C.string_at(buffer,done*2) if reading else done
    def _pointers(self):
        text=Path('/proc/asound/card0/pcm0p/sub0/status').read_text(encoding='ascii')
        pointers={k:int(v) for k,v in re.findall(r'(hw_ptr|appl_ptr)\s*:\s*(\d+)',text)}
        if set(pointers)!={'hw_ptr','appl_ptr'}:raise RuntimeError('missing_playback_hardware_pointer')
        for value in pointers.values():self._validate_pointer(value)
        return pointers
    def _validate_pointer(self,value):
        boundary=self.playback_boundary
        if type(boundary) is not int or boundary<=0 or type(value) is not int or not 0<=value<boundary:
            raise RuntimeError('invalid_playback_hardware_pointer')
    def _drained(self,hardware,target):
        self._validate_pointer(hardware);self._validate_pointer(target)
        # ALSA's boundary is negotiated per PCM, not a fixed 32-bit maximum.
        # Distances below half the ring are forward, including exact equality.
        return 2*((hardware-target)%self.playback_boundary)<self.playback_boundary
    def _io(self):
        before=time.thread_time(); zero=bytes(640)
        try:
            while not self.stop.is_set():
                if self.flush.is_set():
                    self.flush.clear()
                    # QCOM drop/prepare can block longer than the capture
                    # FIFO. Keep both clocks running and replace future voice
                    # with zeros; at most one bounded160ms buffer can remain.
                    self.cancel_drain_target=self._pointers()['appl_ptr']
                with self.lock:
                    clip=self.clip; gain=self.volume/100.
                    if clip:
                        raw=clip.pcm[clip.position:clip.position+FRAME*2];clip.position+=len(raw)
                        last=clip.position>=len(clip.pcm)
                    else:raw=zero;last=False
                raw=raw.ljust(FRAME*2,b'\0')
                values=array.array('h',raw)
                scaled=array.array('h',(int(value*gain) for value in values))
                up=scaled.tobytes()
                if len(up)!=FRAME*2: raise RuntimeError('unexpected_resampling_frame')
                self._transfer(self.playback,up,FRAME,False)
                if last:
                    pointers=self._pointers()
                    if 'appl_ptr' not in pointers: raise RuntimeError('no_playback_hardware_pointer')
                    with self.lock:
                        if self.clip is clip:self.clip=None;self.pending=(clip,pointers['appl_ptr'])
                cap=self._transfer(self.capture,b'',FRAME,True)
                if len(cap)!=FRAME*2: break
                near=cap; ref=up
                if len(near)!=FRAME*2 or len(ref)!=FRAME*2: raise RuntimeError('unexpected_capture_resampling')
                at=time.monotonic();self.frames+=FRAME//VOICE_FRAME
                with self.lock:
                    pending=self.pending;reference_active=bool(clip or pending or self.cancel_drain_target is not None)
                if self.cancel_drain_target is not None:
                    pointers=self._pointers()
                    if self._drained(pointers['hw_ptr'],self.cancel_drain_target):
                        self.cancel_drain_target=None
                        if self.interrupt_requested_at is not None:self.last_interrupt_flush_seconds=time.monotonic()-self.interrupt_requested_at
                        self._drain_notifications()
                if pending:
                    pointers=self._pointers()
                    if self._drained(pointers['hw_ptr'],pending[1]):
                        with self.lock:
                            if self.pending is pending:self.pending=None;done=pending[0]
                            else:done=None
                        self._notify(done,True)
                for offset in range(0,FRAME*2,640):
                    rec=near[offset:offset+640];far=ref[offset:offset+640]
                    cleaned,linear=self.echo.process(rec,far)
                    stamp=at-(FRAME*2-offset-640)/32000.
                    if self.measure:self.measure(rec,far,linear,cleaned,stamp,reference_active)
                    if not self.warming:self.on_frame(AudioFrame(cleaned,self.aec_verified and self.xruns==0,stamp,reference_active))
        except Exception as error:
            self.last_error=str(error)
        finally:
            self.cpu_seconds+=time.thread_time()-before
            self._started=False;self.interrupt();self._drain_notifications()
    def status(self):
        return {'frames':self.frames,'xruns':self.xruns,'volume':self.volume,'error':self.last_error,
                'xrun_events':self.xrun_events,'capture_sizes':getattr(self,'capture_sizes',None),'playback_sizes':getattr(self,'playback_sizes',None),
                'playback_pointer_boundary':self.playback_boundary,
                'cpu_seconds_completed':self.cpu_seconds,'cancelled_playbacks':self.cancel_count,
                'last_interrupt_hardware_flush_seconds':self.last_interrupt_flush_seconds,
                'echo_startup_adaptation':self.warming,
                'capabilities':dataclasses.asdict(self.capabilities()),
                'audio_or_transcripts_saved':False}
    def close(self):
        errors=[]
        self.stop.set()
        if self.thread and self.thread is not threading.current_thread():self.thread.join(timeout=2)
        if self.thread and self.thread.is_alive(): raise RuntimeError('audio_thread_did_not_stop')
        self.interrupt()
        if self.audio:
            for handle in (self.capture,self.playback):
                if handle:self.audio.pcm_drop(handle);self.audio.pcm_close(handle)
            self.capture=C.c_void_p();self.playback=C.c_void_p()
            with self.control_lock:
                for element,original in reversed(self.changed):
                    try:element.write(original)
                    except Exception as error:errors.append('restore '+element.name+': '+str(error))
                self.changed=[]
            try:self.audio.close()
            except Exception as error:errors.append('control close: '+str(error))
            self.audio=None
        if self.echo:self.echo.close();self.echo=None
        for resampler in self.resamplers:resampler.close()
        self.resamplers=[];self._started=False
        self._drain_notifications()
        with self.callback_condition:self.callback_stopping=True;self.callback_condition.notify_all()
        if self.callback_thread and self.callback_thread is not threading.current_thread():
            self.callback_thread.join(timeout=1)
            if self.callback_thread.is_alive():errors.append('completion dispatcher did not stop')
        if errors:raise RuntimeError('; '.join(errors))
