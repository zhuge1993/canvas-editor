#!/usr/bin/env python3
"""Bounded official KWS WAV CLI runner, for candidate testing only."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import subprocess
import time
from compile_keywords import compile_keyword

HERE=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--tts-base',type=Path,required=True)
    p.add_argument('--keyword',required=True);p.add_argument('--wav',type=Path,nargs='+',required=True)
    p.add_argument('--threads',type=int,choices=[1,2,3,4],default=2)
    p.add_argument('--score',type=float,default=1.5);p.add_argument('--threshold',type=float,default=.35)
    p.add_argument('--report',type=Path,required=True)
    args=p.parse_args()
    keywords=compile_keyword(args.keyword,HERE/'model-small/tokens.txt',score=args.score,threshold=args.threshold)
    args.report.parent.mkdir(parents=True,exist_ok=True)
    keyword_file=args.report.parent/'benchmark-keywords.txt';keyword_file.write_text(keywords+'\n',encoding='utf8')
    if len(args.wav)>24:raise ValueError('Maximum24public/generated benchmark inputs')
    for path in args.wav:
        if not path.is_file() or not 0<path.stat().st_size<=1024*1024:raise ValueError('WAV input budget')
    libraries=args.tts_base/'private-glibc/lib';loader=libraries/'ld-linux-armhf.so.3'
    command=[str(loader),'--library-path',str(HERE/'runtime/lib')+':'+str(libraries),str(HERE/'runtime/bin/sherpa-onnx-keyword-spotter'),
       '--encoder='+str(HERE/'model-small/encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
       '--decoder='+str(HERE/'model-small/decoder-epoch-12-avg-2-chunk-16-left-64.onnx'),
       '--joiner='+str(HERE/'model-small/joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx'),
       '--tokens='+str(HERE/'model-small/tokens.txt'),'--keywords-file='+str(keyword_file),
       '--num-threads='+str(args.threads),'--provider=cpu',*[str(x) for x in args.wav]]
    def limits():
        resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(384*1024*1024,)*2)
        resource.setrlimit(resource.RLIMIT_FSIZE,(1024*1024,)*2)
    start=time.monotonic()
    # Capture to bounded scratch files rather than unbounded communicate memory.
    out=args.report.parent/'benchmark-stdout.txt';err=args.report.parent/'benchmark-stderr.txt';timed_out=False
    with out.open('wb') as stdout,err.open('wb') as stderr:
        try:run=subprocess.run(command,stdin=subprocess.DEVNULL,stdout=stdout,stderr=stderr,timeout=90,preexec_fn=limits,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
        except subprocess.TimeoutExpired:timed_out=True;run=None
    report={'status':'CLI_EXECUTED' if run and run.returncode==0 else 'CLI_FAILED','keyword':args.keyword,'compiled_keyword':keywords,
            'wav_files':[str(x) for x in args.wav],'threads':args.threads,'wall_seconds':time.monotonic()-start,
            'returncode':run.returncode if run else None,'timed_out':timed_out,
            'stdout':out.read_text(encoding='utf8',errors='replace')[:65536],
            'stderr':err.read_text(encoding='utf8',errors='replace')[:65536],
            'microphone_tested':False,'recording_or_generated_only':True,'gpu_used':False,
            'continuous_pcm_IPC_tested':False,'true_positive_or_negative_accuracy_not_inferred_from_exitcode':True}
    args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':main()
