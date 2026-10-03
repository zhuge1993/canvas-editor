#!/usr/bin/env python3
"""Foreground service glue. Providers are trusted installed modules, not voice input."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import sys
import threading
import time
from assistant import Assistant,Config
from asr_stream import StreamingASR
from settings import Settings
from control import StatusServer
sys.dont_write_bytecode=True

def load(path,name):
    original=Path(path).absolute();info=original.lstat();path=original.resolve(strict=True)
    if not stat.S_ISREG(info.st_mode) or original.is_symlink() or path!=original or info.st_size>2*1024*1024:
        raise RuntimeError('untrusted_provider_module')
    if os.name=='posix' and (info.st_uid!=0 or info.st_mode&0o022):raise RuntimeError('provider_requires_root_owned_immutable_source')
    # Providers are immutable installed modules; their sibling helpers must
    # resolve from that same trusted directory rather than the runtime cwd.
    if str(path.parent) not in sys.path:sys.path.insert(0,str(path.parent))
    spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return module

def temperature():
    values=[]
    for file in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            value=float(file.read_text().strip());value=value/1000 if abs(value)>200 else value
            if -20<=value<=150:values.append(value)
        except (ValueError,OSError):pass
    return max(values) if values else None

def prepare_startup(llm,conversation,cancel,clock=time.monotonic):
    """One synchronous startup attempt, before capture; never a dialogue turn."""
    started=clock();result={'scope':'startup_only','attempted':False,'initialized':False,'warmup_skipped':True,
        'status':'unsupported','prefix_tokens':0,'generated_tokens':0,'elapsed_seconds':0}
    prepare=getattr(llm,'prepare_system',None)
    if not callable(prepare):return result
    if cancel.is_set():result['status']='cancelled';return result
    result['attempted']=True
    try:
        snapshot=conversation.messages()
        if len(snapshot)!=1 or snapshot[0].get('role')!='system':raise ValueError('startup_conversation_not_fresh')
        value=prepare(snapshot[0]['content'],cancel=cancel,deadline=started+20)
        count=value.get('prefix_tokens');generated=value.get('generated_tokens')
        if cancel.is_set() or clock()>started+20:raise TimeoutError('startup_cancelled_or_deadline')
        if value.get('status')!='complete' or value.get('initialized') is not True or type(count) is not int or not 1<=count<=512 or type(generated) is not int or generated!=0:raise ValueError('invalid_prepare_ack')
        result.update(initialized=True,warmup_skipped=False,status='complete',prefix_tokens=count)
    except Exception as error:
        code=getattr(error,'code',None)
        if cancel.is_set():result['status']='cancelled'
        elif isinstance(error,TimeoutError) or code=='deadline':result['status']='deadline'
        elif code=='cancelled':result['status']='cancelled'
        elif code=='prepare_system_unsupported' or str(error)=='prepare_system_unsupported':result['status']='unsupported'
        elif code in ('busy','preempted','thermal','thermal_unavailable'):result['status']=code
        else:result['status']='unavailable'
    result['elapsed_seconds']=round(max(0,clock()-started),3)
    return result

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audio-module',required=True,help='Root-provided module exposing create_device() -> AudioDevice')
    parser.add_argument('--tts-module',required=True)
    parser.add_argument('--tts-root',required=True)
    parser.add_argument('--tts-engine',choices=['espeak','piper'],default='espeak')
    parser.add_argument('--llm-module')
    parser.add_argument('--llm-binary')
    parser.add_argument('--llm-model')
    parser.add_argument('--llm-threads',type=int,choices=(1,2,3,4),default=4)
    parser.add_argument('--llm-seconds',type=float,default=25,metavar='1..30')
    parser.add_argument('--vad-rms',type=int,default=180,metavar='1..10000')
    parser.add_argument('--progress-cue',action='store_true')
    parser.add_argument('--diagnostic-seconds',type=float,default=0,help='0..180 seconds bounded volatile turn trace, no recording')
    parser.add_argument('--kws-module')
    parser.add_argument('--kws-base')
    parser.add_argument('--kws-tts-base')
    parser.add_argument('--kws-threads',type=int,choices=(1,2,3,4),default=2)
    parser.add_argument('--settings',default='/var/lib/dior-voice/settings.json')
    parser.add_argument('--asr-socket',default='/run/dior-asr/recognize.sock')
    parser.add_argument('--network',action='store_true')
    parser.add_argument('--status-only',action='store_true',help='Instantiate providers and print configured capability status without starting capture')
    parser.add_argument('--control-socket',default='/run/dior-voice/control.sock')
    parser.add_argument('--inference-socket')
    parser.add_argument('--inference-client-module',default='/opt/dior-inference/bridge/client.py')
    args=parser.parse_args()
    if not 1<=args.llm_seconds<=30:parser.error('llm-seconds must be1..30')
    if not 1<=args.vad_rms<=10000:parser.error('vad-rms must be1..10000')
    if not 0<=args.diagnostic_seconds<=180:parser.error('diagnostic-seconds must be0..180')
    if not args.inference_socket and args.llm_module and not (args.llm_binary and args.llm_model):parser.error('LLM module requires qualified binary and model')
    if args.kws_module and not args.kws_base:parser.error('KWS module requires qualified base')
    audio=load(args.audio_module,'dior_voice_audio').create_device()
    lease_hooks=None;availability=None
    if args.inference_socket:
        proxy=load(args.inference_client_module,'dior_shared_inference_client')
        tts=proxy.BridgeTTS(args.inference_socket,Path(args.tts_root)/'fixed-cache');llm=proxy.BridgeLanguageModel(args.inference_socket)
        lease_hooks=proxy.VoiceASRLease(args.inference_socket)
        availability=proxy.Availability(args.inference_socket)
    else:
        tts=load(args.tts_module,'dior_voice_tts').create_persistent(base=Path(args.tts_root),engine=args.tts_engine)
        llm=None
        if args.llm_module:
            llm=load(args.llm_module,'dior_voice_llm').LocalLanguageModel(args.llm_binary,args.llm_model,threads=args.llm_threads)
    settings=Settings(args.settings);wake=None
    if args.kws_module:
        from wake_detector import KeywordWakeDetector
        backend=load(args.kws_module,'dior_voice_kws').LocalKeywordSpotter(args.kws_base,
            args.kws_tts_base or args.tts_root,keyword=settings.wake_word,threads=args.kws_threads)
        wake=KeywordWakeDetector(backend)
    core=Assistant(audio,StreamingASR(args.asr_socket,lease_hooks),tts,settings,llm=llm,wake_detector=wake,
                   config=Config(network_enabled=args.network,llm_seconds=args.llm_seconds,
                                 vad_rms=args.vad_rms,progress_cue=args.progress_cue,diagnostic_seconds=args.diagnostic_seconds),temperature=temperature)
    warmup={'scope':'startup_only','attempted':False,'initialized':False,'warmup_skipped':True,
        'status':'not_started','prefix_tokens':0,'generated_tokens':0,'elapsed_seconds':0}
    def snapshot():
        status=core.status()
        status['warmup']=dict(warmup)
        if availability:
            status['shared_inference']=availability.snapshot
            status['model_ready']=bool(availability.snapshot.get('ready'))
        return status
    if args.status_only:
        if availability:availability.check()
        print(json.dumps(snapshot(),ensure_ascii=False));core.close();return
    stopped=threading.Event()
    def stop(_signum,_frame):stopped.set()
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    control=StatusServer(snapshot,args.control_socket);last_inference_check=0
    try:
        warmup=prepare_startup(llm,core.conversation,stopped)
        if stopped.is_set():return
        core.start();control.start()
        # No transcription/log stream. Workers block on bounded conditions;
        # only this shutdown wait wakes periodically.
        while not stopped.wait(.25):
            if availability and time.monotonic()-last_inference_check>=1:
                availability.check();last_inference_check=time.monotonic()
            if hasattr(audio,'status') and audio.status().get('error'):
                raise RuntimeError('audio_backend_reported_error')
            if wake is not None and not wake.status().get('alive'):
                raise RuntimeError('keyword_backend_not_alive')
    finally:control.close();core.close()

if __name__=='__main__':main()
