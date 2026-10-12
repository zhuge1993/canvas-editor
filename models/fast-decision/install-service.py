"""Install the prepared small local classifier as an unprivileged service."""
import json
import os
from pathlib import Path
import pwd
import subprocess
import time
import urllib.request

root=Path('/opt/fast-decision')
if os.geteuid()!=0:raise SystemExit('root required')
if root.is_symlink():raise ValueError('unsafe installation root')
for relative in ['app/service.py','fast-decision-worker','encoder.int8.onnx','manifest.json','runtime/lib/libonnxruntime.so.1.14.1','runtime/lib/ld-linux-armhf.so.3']:
    if not (root/relative).is_file() or (root/relative).is_symlink():raise ValueError('missing prepared artifact: '+relative)
try:pwd.getpwnam('fast-decision')
except KeyError:
    subprocess.run(['addgroup','-S','fast-decision'],check=True)
    subprocess.run(['adduser','-S','-D','-H','-h',str(root),'-s','/sbin/nologin','-G','fast-decision','fast-decision'],check=True)
for file in [root,*root.rglob('*')]:
    if file.is_symlink():raise ValueError('unexpected deployment symlink')
    os.chown(file,0,0)
    file.chmod(0o755 if file.is_dir() or file.name=='fast-decision-worker' or file.parent==root/'runtime/lib' else 0o644)
service=Path('/etc/init.d/fast-decision')
service.write_text('''#!/sbin/openrc-run
description="Small Chinese semantic decisions"
supervisor="supervise-daemon"
command="/usr/bin/python3"
command_args="/opt/fast-decision/app/service.py --root /opt/fast-decision --threads 2 --port 8149"
command_user="fast-decision:fast-decision"
directory="/opt/fast-decision/app"
pidfile="/run/fast-decision-supervise.pid"
respawn_delay=5
respawn_max=5
respawn_period=300
output_log="/dev/null"
error_log="/dev/null"
depend() { need localmount; }
''',encoding='utf-8')
service.chmod(0o755)
subprocess.run(['rc-service','--nodeps','fast-decision','start'],check=True)
deadline=time.monotonic()+25
while True:
    try:
        info=json.load(urllib.request.urlopen('http://127.0.0.1:8149/health',timeout=2))
        if info.get('model')=='bge-small-zh-v1.5' and info.get('available'):break
    except (OSError,ValueError):pass
    if time.monotonic()>deadline:raise RuntimeError('service did not become ready')
    time.sleep(.2)
subprocess.run(['rc-update','add','fast-decision','default'],check=True)
print('SMALL_SERVICE_READY')
