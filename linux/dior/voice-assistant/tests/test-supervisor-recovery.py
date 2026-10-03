"""Controlled PCM clock discontinuity; only this voice controller is paused."""
import json,os,signal,socket,time
from pathlib import Path
BASE=Path('/tmp/dior-kernel-test/voice-qa')
def procs():
    voice=[];other=[]
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            args=(directory/'cmdline').read_bytes().split(b'\0')
            if len(args)>1 and args[:2]==[b'/usr/bin/python3',b'/opt/dior-voice/runtime/run_assistant.py']:
                voice.append(int(directory.name))
            if args and (args[0].endswith(b'cloudflared') or b'/opt/flowboard/server-bundle.cjs' in args):
                other.append(int(directory.name))
        except OSError:pass
    return sorted(voice),sorted(other)
def status():
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.settimeout(2);peer.connect('/run/dior-voice/control.sock')
        peer.sendall(b'{"op":"status"}\n')
        return json.loads(peer.recv(4096))['status']
report={'status':'RUNNING','fault':'SIGSTOP 350ms exceeds 160ms PCM buffer','recordings_saved':False}
try:
    before,other=procs();assert len(before)==1 and status()['ready']
    word=status()['wake_word'];pid=before[0]
    assert b'/opt/dior-voice/runtime/run_assistant.py' in Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
    started=time.monotonic();os.kill(pid,signal.SIGSTOP)
    try:time.sleep(.35)
    finally:os.kill(pid,signal.SIGCONT)
    deadline=started+75
    while time.monotonic()<deadline:
        try:
            after,current_other=procs();state=status()
            if len(after)==1 and after!=before and state['ready'] and state['aec_verified'] and state['full_duplex']:
                assert current_other==other and state['wake_word']==word
                report.update(status='PASS',controller_before=before,controller_after=after,
                    other_service_pids_unchanged=current_other==other,recovery_seconds=time.monotonic()-started,
                    final_status=state,kernel_tainted=int(Path('/proc/sys/kernel/tainted').read_text()))
                assert report['kernel_tainted']==0
                break
        except (OSError,KeyError,ValueError):pass
        time.sleep(.5)
    else:raise RuntimeError('voice_supervisor_recovery_deadline')
except Exception as error:report.update(status='FAIL',error=repr(error))
(BASE/'SUPERVISOR-RECOVERY.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,ensure_ascii=False),flush=True)
if report['status']!='PASS':raise SystemExit(1)
