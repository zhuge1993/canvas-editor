#!/usr/bin/env python3
"""Actual Linux child limits and SIGKILL-parent cleanup, without real audio."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from offline_tts import _LINUX_CHILD_GUARDS,CHILD_VM_LIMIT_BYTES,CHILD_FD_LIMIT

def state(pid):
    try:
        text=Path('/proc/'+str(pid)+'/stat').read_text()
        return text.rsplit(')',1)[1].strip().split()[0]
    except FileNotFoundError: return None

def main():
    if not _LINUX_CHILD_GUARDS:
        print(json.dumps({'status':'SKIP_UNSUPPORTED_HOST','parent_death_tested':False,
            'reason':'requires native Linux prctl, resource and /proc; Windows host is not a phone test'}))
        return 0
    # The sibling parent creates a genuine running child with the same setup
    # used by TTS. The test controller then SIGKILLs that parent.
    parent_code='''
import json,os,subprocess,sys,time
from offline_tts import _unix_child_setup
expected=os.getpid()
code="import json,os,resource,time;print(json.dumps({'pid':os.getpid(),'ppid':os.getppid(),'core':resource.getrlimit(resource.RLIMIT_CORE),'as':resource.getrlimit(resource.RLIMIT_AS),'fds':resource.getrlimit(resource.RLIMIT_NOFILE)}),flush=True);time.sleep(60)"
child=subprocess.Popen([sys.executable,'-c',code],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=lambda:_unix_child_setup(expected))
line=child.stdout.readline().decode().strip()
if not line:raise RuntimeError('child never reached user code: '+child.stderr.read().decode())
print(line,flush=True)
time.sleep(60)
'''
    parent=subprocess.Popen([sys.executable,'-c',parent_code],cwd=Path(__file__).resolve().parent,
        stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,bufsize=0)
    child_pid=None
    try:
        import select
        ready,_,_=select.select([parent.stdout],[],[],5)
        if not ready: raise AssertionError('child startup deadline')
        line=parent.stdout.readline()
        if not line: raise AssertionError(parent.stderr.read().decode())
        limits=json.loads(line);child_pid=limits['pid']
        assert limits['ppid']==parent.pid and state(child_pid) not in(None,'Z'), 'child not genuinely running'
        assert limits['core']==[0,0], 'core dumps permitted'
        assert 0<limits['as'][0]<=CHILD_VM_LIMIT_BYTES and limits['as'][0]==limits['as'][1]
        assert 0<limits['fds'][0]<=CHILD_FD_LIMIT and limits['fds'][0]==limits['fds'][1]
        started=time.monotonic();parent.kill();parent.wait(timeout=2)
        while state(child_pid) not in(None,'Z') and time.monotonic()-started<3: time.sleep(0.02)
        observed=state(child_pid)
        assert observed in(None,'Z'), 'orphan heavy child survived parent SIGKILL'
        print(json.dumps({'status':'PASS_LINUX_LIFECYCLE','parent_death_tested':True,
            'parent_killed_with':'SIGKILL','child_state_after_parent_death':observed,
            'child_kernel_limits':limits,'death_seconds':time.monotonic()-started,
            'audio_file_created':False,'phone_audio_tested':False}))
        return 0
    finally:
        if parent.poll() is None: parent.kill();parent.wait(timeout=2)
        if child_pid and state(child_pid) not in(None,'Z'):
            try: os.kill(child_pid,9)
            except ProcessLookupError: pass

if __name__=='__main__': raise SystemExit(main())
