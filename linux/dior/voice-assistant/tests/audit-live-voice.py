"""Read-only live service permissions, bounded status and 30s idle observation."""
import json
import os
from pathlib import Path
import pwd
import socket
import stat
import subprocess
import time

ROOT=Path('/opt/dior-voice')
BASE=Path('/tmp/dior-kernel-test/voice-qa')
SOCKET='/run/dior-voice/control.sock'
def status():
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.settimeout(3);peer.connect(SOCKET);peer.sendall(b'{"op":"status"}\n')
        data=bytearray()
        while b'\n' not in data:
            chunk=peer.recv(4096-len(data))
            if not chunk:raise RuntimeError('status_eof')
            data.extend(chunk)
        return json.loads(data)['status']
def processes():
    rows=[]
    for process in Path('/proc').glob('[0-9]*'):
        try:
            argv=(process/'cmdline').read_bytes().split(b'\0')
            is_kws=b'/opt/dior-voice/kws/native/kws-worker' in argv
            if not (is_kws or argv[0]==b'/opt/dior-voice/llm-worker' or
                    len(argv)>1 and argv[0]==b'/usr/bin/python3' and argv[1]==b'/opt/dior-voice/runtime/run_assistant.py'):continue
            row={'pid':int(process.name),'kind':'keyword' if is_kws else 'model' if argv[0].endswith(b'llm-worker') else 'controller'}
            for line in (process/'status').read_text().splitlines():
                if line.startswith('Uid:'):row['uid']=int(line.split()[1])
                if line.startswith('VmRSS:'):row['rss_kib']=int(line.split()[1])
                if line.startswith('Threads:'):row['threads']=int(line.split()[1])
            fields=(process/'stat').read_text().rsplit(')',1)[1].split()
            row['cpu_ticks']=int(fields[11])+int(fields[12]);rows.append(row)
        except OSError:pass
    return sorted(rows,key=lambda row:row['kind'])
report={'status':'RUNNING','microphone_recordings_saved':False,'human_wake_tested':False}
try:
    account=pwd.getpwnam('dior-voice')
    assert account.pw_uid!=0 and account.pw_shell=='/sbin/nologin'
    info=Path(SOCKET).lstat()
    assert stat.S_ISSOCK(info.st_mode) and info.st_uid==account.pw_uid and stat.S_IMODE(info.st_mode)==0o660
    assert stat.S_IMODE(Path('/run/dior-voice').stat().st_mode)==0o750
    for message in (b'{"op":"text","text":"change_wake_word"}\n',b'{"op":"status","admin":true}\n'):
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
            peer.settimeout(3);peer.connect(SOCKET);peer.sendall(message)
            assert 'error' in json.loads(peer.recv(4096))
    report['read_only_control_rejected_actions']=True
    denied=subprocess.run(['su','-s','/bin/sh','nobody','-c','python3 /opt/dior-voice/runtime/voice_ctl.py'],
                           capture_output=True,timeout=5)
    assert denied.returncode!=0
    report['unauthorized_user_denied']=True
    first=status();before=processes();start=time.monotonic()
    time.sleep(30)
    second=status();after=processes();elapsed=time.monotonic()-start
    assert first['ready'] and second['ready'] and second['wake_word']=='二狗'
    assert len(before)==len(after)==3 and [r['pid'] for r in before]==[r['pid'] for r in after]
    assert all(r['uid']==account.pw_uid for r in after)
    report['idle']={'wall_seconds':elapsed,'before':before,'after':after,
                    'audio_frames_delta':second['counters'].get('audio_frames',0)-first['counters'].get('audio_frames',0),
                    'asr_spans_delta':second['counters'].get('asr_spans',0)-first['counters'].get('asr_spans',0),
                    'model_cpu_ticks_delta':next(r['cpu_ticks'] for r in after if r['kind']=='model')-next(r['cpu_ticks'] for r in before if r['kind']=='model')}
    report['final_status']=second
    report['boot_enabled']=Path('/etc/runlevels/default/dior-voice').is_symlink()
    report['kernel_tainted']=int(Path('/proc/sys/kernel/tainted').read_text())
    assert report['boot_enabled'] and report['kernel_tainted']==0
    report['status']='PASS'
except Exception as error:
    report['status']='FAIL';report['error']=repr(error)
(BASE/'LIVE-VOICE-AUDIT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,ensure_ascii=False),flush=True)
if report['status']!='PASS':raise SystemExit(1)
