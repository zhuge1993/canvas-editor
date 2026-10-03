import argparse,grp,hashlib,json,os,pwd,socket,stat,subprocess,time,urllib.request,urllib.error
from pathlib import Path
BASE=Path('/tmp/dior-kernel-test/voice-qa')
def request(path,message):
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as peer:
        peer.settimeout(3);peer.connect(path);peer.sendall((json.dumps(message)+'\n').encode());data=bytearray()
        while b'\n' not in data:
            chunk=peer.recv(16384-len(data));assert chunk;data.extend(chunk)
        return json.loads(data)
def snapshot():
    return request('/run/dior-voice/control.sock',{'op':'status'})['status']
def processes():
    rows=[]
    for directory in Path('/proc').glob('[0-9]*'):
        try:
            args=(directory/'cmdline').read_bytes().split(b'\0')
            if args[0]==b'/opt/dior-voice/llm-worker':kind='native_model'
            elif b'/opt/dior-inference/bridge/server.py' in args and args[0]==b'/usr/bin/python3':kind='shared_inference'
            elif b'/opt/dior-voice/runtime/run_assistant.py' in args and args[0]==b'/usr/bin/python3':kind='voice'
            elif b'/opt/dior-voice/kws/native/kws-worker' in args:kind='keyword'
            else:continue
            row={'kind':kind,'pid':int(directory.name)}
            for line in (directory/'status').read_text().splitlines():
                if line.startswith('Uid:'):row['uid']=int(line.split()[1])
                if line.startswith('VmRSS:'):row['rss_kib']=int(line.split()[1])
                if line.startswith('Threads:'):row['threads']=int(line.split()[1])
            fields=(directory/'stat').read_text().rsplit(')',1)[1].split();row['cpu_ticks']=int(fields[11])+int(fields[12]);rows.append(row)
        except OSError:pass
    return sorted(rows,key=lambda row:row['kind'])
def http(code,url):
    try:
        with urllib.request.urlopen(url,timeout=5) as response:assert response.status==code
    except urllib.error.HTTPError as error:assert error.code==code
parser=argparse.ArgumentParser();parser.add_argument('--bundle-sha',required=True);args=parser.parse_args()
report={'status':'RUNNING','human_acoustics_tested':False,'actual_24_hour_soak_tested':False}
try:
    account=pwd.getpwnam('dior-inference');voice=pwd.getpwnam('dior-voice');gid=grp.getgrnam('dior-inference').gr_gid
    info=Path('/run/dior-inference/inference.sock').lstat()
    assert stat.S_ISSOCK(info.st_mode) and info.st_uid==account.pw_uid and info.st_gid==gid and stat.S_IMODE(info.st_mode)==0o660
    assert stat.S_IMODE(Path('/run/dior-inference').stat().st_mode)==0o750 and account.pw_shell=='/sbin/nologin'
    assert not set(os.getgrouplist('dior-inference',account.pw_gid))&{grp.getgrnam(g).gr_gid for g in ('audio','wheel','video')}
    first=snapshot();before=processes();report['components_before']=before;start=time.monotonic();time.sleep(30);second=snapshot();after=processes()
    report['components_after']=after
    assert len(before)==len(after)==4 and [r['pid'] for r in before]==[r['pid'] for r in after]
    assert sum(r['kind']=='native_model' for r in after)==1
    for row in after:assert row['uid']==(voice.pw_uid if row['kind'] in ('voice','keyword') else account.pw_uid)
    assert second['ready'] and second['model_ready'] and second['wake_word']=='二狗' and second['full_duplex'] and second['aec_verified']
    probe=request('/run/dior-inference/inference.sock',{'v':1,'id':'final_status','op':'status'})
    assert probe['ready'] and probe['model_load_count']==1 and probe['public_tcp'] is False
    report.update(shared_status=probe,voice_status=second,idle={'seconds':time.monotonic()-start,'before':before,'after':after,
        'audio_frames_delta':second['counters'].get('audio_frames',0)-first['counters'].get('audio_frames',0),'clk_tck':os.sysconf('SC_CLK_TCK')})
    for name in ('dior-inference','dior-voice','dior-asr'):assert Path('/etc/runlevels/default',name).is_symlink()
    root=Path('/opt/flowboard');bundle=hashlib.sha256((root/'server-bundle.cjs').read_bytes()).hexdigest();assert bundle==args.bundle_sha
    users=json.loads((root/'auth-data/users.json').read_text());shares=json.loads((root/'auth-data/shares.json').read_text())
    assert len(users)==5 and len(shares)==5
    for share in shares:http(200,'http://127.0.0.1:3000/api/share/'+share['token'])
    http(401,'http://127.0.0.1:3000/api/voice/status')
    url=Path('/var/lib/dior-tunnel/public-url').read_text().strip();assert url=='https://announce-poet-humans-den.trycloudflare.com'
    report.update(status='PASS_SHARED_DEVICE_SCOPE',website={'users':len(users),'shares':len(shares),'share_statuses':[200]*5,
        'bundle_sha256':bundle,'voice_guest_status':401,'public_url_unchanged':True},
        kernel=subprocess.check_output(['uname','-r']).decode().strip(),kernel_tainted=int(Path('/proc/sys/kernel/tainted').read_text()),
        free_storage_bytes=os.statvfs('/').f_bavail*os.statvfs('/').f_frsize,boot_enabled=True)
    assert report['kernel_tainted']==0
except Exception as error:report.update(status='FAIL',error=repr(error))
(BASE/'SHARED-FINAL-AUDIT.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,ensure_ascii=False),flush=True)
if report['status']=='FAIL':raise SystemExit(1)
