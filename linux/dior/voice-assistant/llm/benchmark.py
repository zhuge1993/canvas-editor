#!/usr/bin/env python3
"""Run the qualified local worker only; no microphone, skills or cloud APIs."""
import argparse
import dataclasses
import json
from pathlib import Path
import sys
import threading
import time
import types
from adapter import LocalLanguageModel

# Benchmark scratch directories need not include the whole voice core. The
# production adapter uses the core's actual interfaces.LanguageReply class.
try: import interfaces
except ImportError:
    interfaces=types.ModuleType('interfaces')
    @dataclasses.dataclass(frozen=True)
    class LanguageReply:
        text: str
        intent: object=None
    interfaces.LanguageReply=LanguageReply;sys.modules['interfaces']=interfaces

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary',required=True);parser.add_argument('--model',required=True)
    parser.add_argument('--report',required=True);parser.add_argument('--threads',type=int,default=2)
    parser.add_argument('--load-timeout',type=int,default=90);parser.add_argument('--deadline',type=float,default=15)
    args=parser.parse_args()
    if not 1<=args.deadline<=30:parser.error('deadline must be1..30seconds')
    model=None;report={'status':'FAIL','gpu_used':False,'microphone_used':False,'skills_executed':False,'cases':[]}
    try:
        start=time.monotonic();model=LocalLanguageModel(args.binary,args.model,threads=args.threads,load_timeout=args.load_timeout)
        report['adapter_startup_seconds']=time.monotonic()-start;report['native_ready']=model.ready
        for prompt in ['你好，请用一句话介绍自己。','为什么手机服务器需要保持联网？']:
            begin=time.monotonic();reply=model.generate(prompt,cancel=threading.Event(),deadline=begin+args.deadline)
            report['cases'].append({'prompt':prompt,'reply':reply.text,'intent':reply.intent,'wall_seconds':time.monotonic()-begin,'native':model.last_metrics})
        cancel=threading.Event();cancel_times=[]
        def interrupt():time.sleep(.5);cancel_times.append(time.monotonic());cancel.set()
        interrupter=threading.Thread(target=interrupt,daemon=True);interrupter.start()
        begin=time.monotonic();reply=model.generate('请慢慢解释天空为什么是蓝色的。',cancel=cancel,deadline=begin+args.deadline)
        end=time.monotonic();interrupter.join(timeout=1)
        report['cancellation']={'cancel_was_set':cancel.is_set(),'reply_empty':not reply.text,
            'return_after_cancel_seconds':end-cancel_times[0] if cancel_times else None,
            'native':model.last_metrics,'worker_still_alive':model.process.poll() is None}
        report['status']='PASS_LOCAL_GENERATION' if all(x['reply'] and x['native']['status']=='complete' for x in report['cases']) else 'PARTIAL_LOCAL_MODEL_LOADED'
    except Exception as error:report['error']=str(error)
    finally:
        if model:model.close()
        path=Path(args.report);path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
        print(json.dumps(report,ensure_ascii=False),flush=True)
    return 0 if report['status']=='PASS_LOCAL_GENERATION' else 1

if __name__=='__main__':raise SystemExit(main())
