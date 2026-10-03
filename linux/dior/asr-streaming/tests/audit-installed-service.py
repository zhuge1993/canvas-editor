#!/usr/bin/env python3
"""Root read-only audit plus one restart of only the installed ASR service."""
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import subprocess
import sys
import time
import traceback
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path('/opt/dior-asr')

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def command(args, check=True):
    return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=check)
def ready(user='root'):
    args = ['/usr/bin/python3', '/opt/dior-asr/asr-client.py', '--ready']
    if user != 'root': args = ['su', '-s', '/bin/sh', user, '-c', 'python3 /opt/dior-asr/asr-client.py --ready']
    return json.loads(command(args).stdout)
def processes():
    result = {}
    for entry in Path('/proc').glob('[0-9]*'):
        try:
            argv = (entry / 'cmdline').read_bytes().split(b'\0')
            labels = []
            if b'/opt/flowboard/server-bundle.cjs' in argv: labels.append('flowboard')
            if any(b'cloudflared' in v for v in argv): labels.append('tunnel')
            if b'/opt/dior-asr/asr-broker.py' in argv and argv[0] in (b'/usr/bin/python3', b'python3'): labels.append('asr_broker')
            if b'/opt/dior-asr/stream-worker' in argv: labels.append('asr_worker')
            for label in labels:
                row = {'pid': int(entry.name)}
                for line in (entry / 'status').read_text().splitlines():
                    if line.startswith('Uid:'): row['uid'] = int(line.split()[1])
                    if line.startswith('VmRSS:'): row['rss_kib'] = int(line.split()[1])
                    if line.startswith('Threads:'): row['threads'] = int(line.split()[1])
                result.setdefault(label, []).append(row)
        except OSError: pass
    return result
def website():
    base = Path('/opt/flowboard')
    users = json.loads((base / 'auth-data/users.json').read_text())
    shares = json.loads((base / 'auth-data/shares.json').read_text())
    statuses = []
    for share in shares:
        with urllib.request.urlopen('http://127.0.0.1:3000/api/share/' + share['token'], timeout=5) as response:
            statuses.append(response.status)
    return {'users': len(users), 'shares': len(shares), 'share_http_statuses': statuses,
            'bundle_sha256': digest(base / 'server-bundle.cjs'),
            'public_url': Path('/var/lib/dior-tunnel/public-url').read_text().strip()}

report = {'status': 'RUNNING', 'microphone_tested': False, 'gpu_used': False}
try:
    account = pwd.getpwnam('dior-asr'); group = grp.getgrnam('dior-asr')
    assert account.pw_shell == '/sbin/nologin'
    report['account'] = {'uid': account.pw_uid, 'gid': account.pw_gid, 'shell': account.pw_shell,
                         'supplementary_groups': [g.gr_name for g in grp.getgrall() if 'dior-asr' in g.gr_mem and g.gr_gid != account.pw_gid]}
    assert not report['account']['supplementary_groups']
    manifest = json.loads((ROOT / 'INSTALL-MANIFEST.json').read_text())
    verified = 0
    for item in manifest['files']:
        name = item['path']
        if name.startswith('program/'): target = ROOT / name[8:]
        elif name.startswith('models/'): target = ROOT / name
        elif name == 'etc/dior-asr.json': target = Path('/etc/dior-asr.json')
        elif name == 'service/dior-asr.openrc': target = Path('/etc/init.d/dior-asr')
        else: raise AssertionError('Unexpected manifest path')
        info = target.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022
        assert info.st_size == item['bytes'] and digest(target) == item['sha256'], name
        verified += 1
    report['immutable_files_verified'] = verified
    link = Path('/etc/runlevels/default/dior-asr')
    assert link.is_symlink() and link.resolve() == Path('/etc/init.d/dior-asr')
    report['default_boot_enabled'] = True
    perms = {}
    for path, expected in ((Path('/run/dior-asr'), 0o750), (Path('/run/dior-asr/recognize.sock'), 0o660)):
        info = path.lstat(); assert stat.S_IMODE(info.st_mode) == expected
        assert info.st_uid == account.pw_uid and info.st_gid == group.gr_gid
        perms[str(path)] = oct(expected)
    report['socket_permissions'] = perms
    report['authorized_clients'] = {user: ready(user) for user in ('dior', 'flowboard')}
    denied = command(['su', '-s', '/bin/sh', 'nobody', '-c', 'python3 /opt/dior-asr/asr-client.py --ready'], check=False)
    denied_result = json.loads(denied.stdout)
    assert denied.returncode != 0 and denied_result['status'] == 'FAIL_PROTOCOL' and 'Permission denied' in denied_result['error']
    report['unauthorized_user_denied'] = True
    before = processes(); web_before = website(); old_worker = ready()['worker_pid']
    assert len(before.get('asr_broker', [])) == 1 and len(before.get('asr_worker', [])) == 1
    assert all(row['uid'] == account.pw_uid for label in ('asr_broker', 'asr_worker') for row in before[label])
    command(['rc-service', '--nodeps', 'dior-asr', 'restart'])
    last = None
    for _ in range(15):
        try:
            last = ready()
            if last.get('status') == 'READY': break
        except (subprocess.SubprocessError, ValueError): pass
        time.sleep(1)
    assert last and last['status'] == 'READY' and last['worker_pid'] != old_worker and last['model_load_count'] == 1
    assert not Path('/proc/%d' % old_worker).exists()
    after = processes(); web_after = website()
    assert len(after.get('asr_broker', [])) == 1 and len(after.get('asr_worker', [])) == 1
    assert before.get('flowboard') == after.get('flowboard') or [r['pid'] for r in before['flowboard']] == [r['pid'] for r in after['flowboard']]
    assert [r['pid'] for r in before['tunnel']] == [r['pid'] for r in after['tunnel']]
    assert web_before == web_after
    report['restart'] = {'passed': True, 'old_worker_reaped': True, 'new_ready': last,
                         'before_processes': before, 'after_processes': after,
                         'website_and_tunnel_pid_unchanged': True}
    report['website'] = web_after
    report['kernel_tainted'] = int(Path('/proc/sys/kernel/tainted').read_text())
    report['kernel'] = os.uname().release
    assert report['kernel_tainted'] == 0
    report['installed_total_bytes'] = sum(p.stat().st_size for p in ROOT.rglob('*') if p.is_file())
    usage = os.statvfs(ROOT)
    report['free_bytes'] = usage.f_bavail * usage.f_frsize
    report['status'] = 'PASS'
except Exception as error:
    traceback.print_exc()
    report['status'] = 'FAIL'; report['error'] = repr(error)
print(json.dumps(report, ensure_ascii=False), flush=True)
if report['status'] != 'PASS': raise SystemExit(1)
