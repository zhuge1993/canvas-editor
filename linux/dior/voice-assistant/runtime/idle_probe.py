#!/usr/bin/env python3
"""Wall-clock idle resource probe with FakeAudio. No actual hardware claim."""
import argparse
import json
from pathlib import Path
import tempfile
import time
import tracemalloc
from assistant import Assistant
from interfaces import AudioFrame
from settings import Settings
from test_contracts import Audio,ASR,TTS

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seconds',type=float,default=20)
    args=parser.parse_args()
    if not 1<=args.seconds<=300:parser.error('seconds must be1..300')
    with tempfile.TemporaryDirectory() as directory:
        audio=Audio();asr=ASR();core=Assistant(audio,asr,TTS(),Settings(Path(directory)/'settings.json'),temperature=lambda:40)
        core.start();tracemalloc.start();before=tracemalloc.get_traced_memory()[0]
        start=time.monotonic();cpu=time.process_time();frames=0;max_callback=0
        while time.monotonic()-start<args.seconds:
            frames+=1;at=time.monotonic();b=time.monotonic()
            core.on_audio(AudioFrame(bytes(640),False,at));max_callback=max(max_callback,time.monotonic()-b)
            wait=start+frames*.02-time.monotonic()
            if wait>0:time.sleep(wait)
        elapsed=time.monotonic()-start;cpu_seconds=time.process_time()-cpu
        current,peak=tracemalloc.get_traced_memory();tracemalloc.stop();core.close()
        assert asr.calls==0 and len(core.preroll)==0 and not any(t.is_alive() for t in core.threads)
        assert current-before<256*1024
        print(json.dumps({'status':'PASS_FAKE_IO_IDLE','scope':'host_fake_audio_wall_clock_only',
            'hardware_tested':False,'wall_seconds':elapsed,'frames':frames,'process_cpu_seconds':cpu_seconds,
            'one_core_cpu_fraction':cpu_seconds/elapsed,'memory_growth_bytes':current-before,'tracemalloc_peak_bytes':peak,
            'max_callback_seconds':max_callback,'asr_calls':asr.calls,'worker_threads_stopped':True}))

if __name__=='__main__':main()
