#!/usr/bin/env python3
"""One-load, paced generated/public WAV positive and negative KWS tests."""
import argparse
import json
from pathlib import Path
import time
import wave
from kws_adapter import LocalKeywordSpotter

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--base',type=Path,default=Path(__file__).resolve().parent)
    p.add_argument('--tts-base',type=Path,required=True);p.add_argument('--cases',type=Path,required=True)
    p.add_argument('--report',type=Path,required=True);p.add_argument('--tail-seconds',type=float,default=1.5)
    p.add_argument('--threads',type=int,choices=[1,2],default=2)
    p.add_argument('--score',type=float,default=1.5);p.add_argument('--threshold',type=float,default=.35)
    args=p.parse_args()
    if not 1<=args.tail_seconds<=3:raise ValueError('tail budget1..3seconds')
    cases=json.loads(args.cases.read_text(encoding='utf8'))
    if not isinstance(cases,list) or not 1<=len(cases)<=24:raise ValueError('case count bound')
    engine=None;report={'status':'FAIL','generated_or_public_recording_only':True,'human_voice_tested':False,
        'microphone_acoustics_tested':False,'gpu_used':False,'cases':[]}
    try:
        engine=LocalKeywordSpotter(args.base,args.tts_base,keyword=cases[0]['keyword'],threads=args.threads,score=args.score,threshold=args.threshold)
        report['ready']=engine.ready;report['worker_pid']=engine.process.pid
        for case in cases:
            if engine.keyword!=case['keyword']:engine.set_keyword(case['keyword'])
            engine.reset();path=Path(case['wav'])
            if not path.is_file() or not 0<path.stat().st_size<=1024*1024:raise ValueError('WAV bound')
            with wave.open(str(path),'rb') as audio:
                if (audio.getnchannels(),audio.getframerate(),audio.getsampwidth())!=(1,16000,2):raise ValueError('PCM16 mono16k needed')
                duration=audio.getnframes()/16000.;audio_frames=[]
                while True:
                    raw=audio.readframes(320)
                    if not raw:break
                    audio_frames.append(raw+bytes(640-len(raw)))
            if duration>27:raise ValueError('voice input too long')
            start=time.monotonic();hits=[];max_rpc=0;decode_ms=0
            for number,raw in enumerate(audio_frames+[bytes(640)]*int(args.tail_seconds/.02)):
                available=min((number+1)*.02,duration) if number<len(audio_frames) else duration+(number-len(audio_frames)+1)*.02
                delay=start+available-time.monotonic()
                if delay>0:time.sleep(delay)
                begin=time.monotonic();result=engine.feed(raw);max_rpc=max(max_rpc,time.monotonic()-begin);decode_ms+=result.get('decode_ms',0)
                if result.get('keyword'):
                    hits.append({'wall_seconds':time.monotonic()-start,'audio_available_seconds':available,'native':result})
            expected=case.get('expect_hit');hit=bool(hits)
            report['cases'].append({'name':case['name'],'wav':str(path),'active_keyword':case['keyword'],'expect_hit':expected,'hit':hit,
                'passed':hit==expected if isinstance(expected,bool) else None,'audio_seconds':duration,'paced_tail_seconds':args.tail_seconds,
                'wall_seconds':time.monotonic()-start,'max_rpc_seconds':max_rpc,'total_decode_ms':decode_ms,'hits':hits})
        report['final_ping']=engine.ping();report['status']='PASS_GENERATED_KWS_CASES' if all(x['passed'] is True for x in report['cases']) else 'OBSERVED_KWS_CANDIDATE'
    except Exception as e:report['error']=str(e)
    finally:
        if engine:engine.close()
        args.report.parent.mkdir(parents=True,exist_ok=True);args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        print(json.dumps(report,ensure_ascii=False),flush=True)
    return 0 if report['status']=='PASS_GENERATED_KWS_CASES' else 1

if __name__=='__main__':raise SystemExit(main())
