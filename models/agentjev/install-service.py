"""Install the prepared native decision service on the ARMv7 phone."""
import argparse
import json
import os
from pathlib import Path
import pwd
import subprocess
import time
import urllib.request

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--root',type=Path,default=Path('/opt/agentjev'))
args=parser.parse_args()
root=args.root.resolve()
if os.geteuid()!=0:raise SystemExit('root required')
if root!=Path('/opt/agentjev') or args.root.is_symlink():raise ValueError('unexpected installation root')
for relative in ['app/service.py','agentjev-worker','model/manifest.json','runtime/lib/libonnxruntime.so','runtime/lib/ld-linux-armhf.so.3']:
    file=root/relative
    if not file.is_file() or file.is_symlink():raise ValueError('missing prepared artifact: '+relative)
try:pwd.getpwnam('agentjev')
except KeyError:
    subprocess.run(['addgroup','-S','agentjev'],check=True)
    subprocess.run(['adduser','-S','-D','-H','-h',str(root),'-s','/sbin/nologin','-G','agentjev','agentjev'],check=True)
service=Path('/etc/init.d/agentjev')
service.write_text('''#!/sbin/openrc-run
description="Local AgentJev probability decisions"
supervisor="supervise-daemon"
command="/usr/bin/python3"
command_args="/opt/agentjev/app/service.py --backend native --root /opt/agentjev --worker /opt/agentjev/agentjev-worker --threads 2 --max-tokens 512 --port 8149"
command_user="agentjev:agentjev"
directory="/opt/agentjev/app"
pidfile="/run/agentjev-supervise.pid"
respawn_delay=5
respawn_max=5
respawn_period=300
output_log="/dev/null"
error_log="/dev/null"
depend() { need localmount; }
''',encoding='utf-8')
service.chmod(0o755)
subprocess.run(['rc-service','--nodeps','agentjev','start'],check=True)
deadline=time.monotonic()+60
while True:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8149/health',timeout=2) as response:status=json.load(response)
        if status.get('status')=='ready' and status.get('model')=='AgentJev-0.6B' and status.get('backend')=='onnx-int8-armv7':break
    except (OSError,ValueError):pass
    if time.monotonic()>=deadline:raise RuntimeError('native service did not become ready')
    time.sleep(.5)
subprocess.run(['rc-update','add','agentjev','default'],check=True)
print(json.dumps({'status':'NATIVE_SERVICE_READY','model':status['model'],'backend':status['backend'],'output_token_decoding':status['output_token_decoding']}))
