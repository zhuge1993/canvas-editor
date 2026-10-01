"""Measure speaker sound through AMIC1, with coded tones and mixer rollback."""
import argparse
import array
import ctypes as C
import importlib.util
import json
import math
from pathlib import Path
import threading
import time

spec=importlib.util.spec_from_file_location('audio',str(Path(__file__).with_name('dior-audio-functional-test.py')))
audio=importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)
RATE=48000

def spectral_amp(samples, hz):
    n=len(samples)
    if not n: return 0.0
    coeff=2*math.cos(2*math.pi*hz/RATE)
    prev=prev2=0.0
    for value in samples:
        current=value+coeff*prev-prev2;prev2=prev;prev=current
    power=max(0.0,prev*prev+prev2*prev2-coeff*prev*prev2)
    return 2*math.sqrt(power)/n

def pcm_transfer(a,capture):
    pcm=C.c_void_p();opened=False;samples=[];result={}
    channels=1 if capture else 2
    frames=int(RATE*(2.4 if capture else 1.6))
    try:
        a.check(a.pcm_open(C.byref(pcm),b'hw:0,0',int(capture),1),'PCM open')
        opened=True
        a.check(a.pcm_set_params(pcm,2,3,channels,RATE,0,100000),'hardware params')
        size,period=C.c_ulong(),C.c_ulong()
        a.check(a.pcm_get_params(pcm,C.byref(size),C.byref(period)),'effective sizes')
        result.update(period_frames=period.value,buffer_frames=size.value)
        if capture:
            a.check(a.pcm_start(pcm),'explicit capture start')
        else:
            data=array.array('h')
            for frame in range(frames):
                t=frame/RATE
                hz=440 if 0.1<=t<0.5 else 880 if 0.7<=t<1.1 else 0
                ramp=min(1.0,(t-(0.1 if hz==440 else 0.7))*100,
                         ((0.5 if hz==440 else 1.1)-t)*100) if hz else 0
                value=int(32767*0.20*max(0,ramp)*math.sin(2*math.pi*hz*t))
                data.extend((value,value))
            payload=C.create_string_buffer(data.tobytes())
        completed=0;deadline=time.monotonic()+10
        result['start_monotonic']=time.monotonic()
        while completed<frames:
            if time.monotonic()>deadline: raise TimeoutError('PCM transfer deadline')
            block=min(period.value,frames-completed)
            if capture:
                buf=(C.c_int16*block)()
                done=int(a.pcm_readi(pcm,buf,block))
            else:
                done=int(a.pcm_writei(pcm,C.cast(C.byref(payload,completed*4),C.c_void_p),block))
            if done in (-11,0):
                a.check(a.pcm_wait(pcm,100),'PCM wait');continue
            a.check(done,'PCM transfer')
            if done>block: raise RuntimeError('too many frames')
            if capture: samples.extend(buf[:done])
            completed+=done
        result.update(frames_transferred=completed,end_monotonic=time.monotonic())
        if capture:
            a.check(a.pcm_drop(pcm),'capture stop')
            bins=[]
            for pos in range(0,len(samples),2400):
                chunk=samples[pos:pos+2400]
                mean=sum(chunk)/len(chunk)
                frequencies={str(hz):spectral_amp(chunk,hz) for hz in (350,440,550,700,880,1050)}
                bins.append({'seconds':pos/RATE,
                             'rms_ac':math.sqrt(sum((x-mean)**2 for x in chunk)/len(chunk)),
                             'frequency_amplitudes':frequencies})
            result.update(peak=max(abs(x) for x in samples),bins=bins)
        else:
            while True:
                code=int(a.pcm_drain(pcm))
                if code==0: break
                if code!=-11: a.check(code,'drain')
                wait=int(a.pcm_wait(pcm,100))
                if wait==-5 and int(a.pcm_state(pcm))==1:
                    state=Path('/proc/asound/card0/pcm0p/sub0/status').read_text()
                    import re
                    values=dict(re.findall(r'(hw_ptr|appl_ptr|delay)\s*:\s*(\d+)',state))
                    if values.get('delay')=='0' and values.get('hw_ptr')==values.get('appl_ptr'):break
                a.check(wait,'drain wait')
                if time.monotonic()>deadline: raise TimeoutError('drain deadline')
            result['drain_completed']=True
        result['status']='pcm-transfer-pass'
    except Exception as error:
        result.update(status='error',error=str(error),frames_transferred=locals().get('completed',0))
    finally:
        if opened: a.pcm_drop(pcm);a.pcm_close(pcm)
    return result

def run(compander, speaker_mute):
    report={'mode':'speaker-to-AMIC1 acoustic test','compander':compander,
            'recording_saved':False,'digital_loopback':False,'acoustic_tone_detected':False,
            'speaker_muted':speaker_mute, 'kernel_release':__import__('os').uname().release}
    a=None;changed=[];reader=None;capture={}
    try:
        pre=audio.run('inspect')
        if pre.get('target_serial')!='1f1fb247':raise RuntimeError('unexpected device')
        a=audio.Alsa()
        speaker=audio.COMMON+audio.FULL+audio.SPEAKER_END
        speaker=[(name,kind,7 if name=='SPK DRV Volume' else
                  84 if name=='RX4 Digital Volume' else value,bounds)
                 for name,kind,value,bounds in speaker]
        speaker=[(name,kind,compander if name=='COMP0 Switch' else value,bounds)
                 for name,kind,value,bounds in speaker]
        if speaker_mute:
            speaker=[(name,kind,0 if name=='SPK DAC Switch' else value,bounds)
                     for name,kind,value,bounds in speaker]
        prepared=audio.preflight(a,speaker+audio.MIC)
        for element,original,desired in prepared:
            if original!=desired:
                changed.append((element,original));element.write(desired)
                if element.read()!=desired: raise RuntimeError('mixer failed '+element.name)
        def collect(): capture.update(pcm_transfer(a,True))
        reader=threading.Thread(target=collect,daemon=True);reader.start()
        time.sleep(0.25)
        report['playback']=pcm_transfer(a,False)
        reader.join(timeout=11)
        if reader.is_alive():raise RuntimeError('capture did not finish')
        report['capture']=capture
        bins=capture.get('bins',[])
        detections={}
        for hz in (440,880):
            selected=[row for row in bins if row['frequency_amplitudes'][str(hz)]>=20
                      and row['frequency_amplitudes'][str(hz)]>4*max(
                          row['frequency_amplitudes'][str(other)] for other in (350,550,700,1050))]
            detections[str(hz)]=[row['seconds'] for row in selected]
        report['tone_windows']=detections
        report['acoustic_tone_detected']=(len(detections['440'])>=3 and len(detections['880'])>=3
            and max(detections['440'])<min(detections['880'])
            and capture.get('status')=='pcm-transfer-pass'
            and report['playback'].get('drain_completed') is True)
        report['status']='acoustic-tone-detected' if report['acoustic_tone_detected'] else 'acoustic-tone-unconfirmed'
    except Exception as error:report.update(status='error',error=str(error))
    finally:
        if reader and reader.is_alive():reader.join(timeout=11)
        errors=[]
        if a:
            for element,original in reversed(changed):
                try:
                    element.write(original)
                    if element.read()!=original:errors.append(element.name)
                except Exception as error:errors.append(str(error))
            a.close()
        report['all_controls_restored']=not errors;report['restoration_errors']=errors
    return report

args=argparse.ArgumentParser()
args.add_argument('--compander',type=int,choices=(0,1),default=0)
args.add_argument('--speaker-mute',action='store_true')
option=args.parse_args()
result=run(option.compander,option.speaker_mute)
suffix='-muted' if option.speaker_mute else ''
Path(__file__).with_name('audio-acoustic-comp%d%s.json'%(option.compander,suffix)).write_text(json.dumps(result,indent=2))
print(result.get('status'))
