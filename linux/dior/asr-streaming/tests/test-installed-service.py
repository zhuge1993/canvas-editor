#!/usr/bin/env python3
"""Regression of the installed Unix-socket service using the actual model.

Uses only published test WAVs, never opens a microphone or network endpoint.
Run as an authorized client account. JSON report goes to stdout.
"""
import base64
import argparse
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import wave

sys.dont_write_bytecode = True
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--wav-root',type=Path,required=True,help='Directory containing the four pinned public test WAVs')
parser.add_argument('--install-root',type=Path,default=Path('/opt/dior-asr'))
parser.add_argument('--socket',default='/run/dior-asr/recognize.sock')
args=parser.parse_args()
sys.path.insert(0,str(args.install_root))
from importlib.util import spec_from_file_location, module_from_spec
spec = spec_from_file_location('installed_client', args.install_root/'asr-client.py')
client_module = module_from_spec(spec)
spec.loader.exec_module(client_module)
SOCKET = args.socket
ROOT = args.wav_root

class Peer:
    def __init__(self, ready=True):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(27)
        self.sock.connect(SOCKET)
        self.buffer = bytearray()
        assert self.read()['type'] == 'queued'
        if ready:
            self.ready = self.read()
            assert self.ready['type'] == 'ready_session', self.ready
    def read(self):
        while b'\n' not in self.buffer:
            data = self.sock.recv(65536)
            if not data: raise RuntimeError('unexpected_disconnect')
            self.buffer.extend(data)
        raw, _, remain = self.buffer.partition(b'\n')
        self.buffer = bytearray(remain)
        return json.loads(raw)
    def send(self, value):
        self.sock.sendall((json.dumps(value) + '\n').encode())
    def close(self): self.sock.close()

def ping():
    c = client_module.Client(SOCKET)
    try: return c.request('ping')
    finally: c.close()

def cpu_ticks(pid):
    fields = Path('/proc/%d/stat' % pid).read_text().rsplit(')', 1)[1].split()
    return int(fields[11]) + int(fields[12])

report = {'status': 'RUNNING', 'input': 'public_pcm16_wav_only', 'microphone_tested': False,
          'backend': 'CPU_NEON_OPENMP', 'gpu_used': False, 'checks': {}, 'speech': []}
try:
    initial = ping()
    worker = initial['worker_pid']
    report['worker_pid'] = worker
    assert initial['model_load_count'] == 1
    report['initial_ping'] = initial
    def record(name, value=True):
        report['checks'][name] = value
        print(json.dumps({'progress': name, 'value': value}), flush=True)

    for name, message, code in (
        ('forbidden_quit', {'op': 'quit'}, 'forbidden_operation'),
        ('invalid_pcm', {'op': 'feed', 'pcm16_base64': 'bad!'}, 'invalid_pcm16'),
        ('client_config_forbidden', {'op': 'ping', 'threads': 8}, 'unexpected_fields')):
        p = Peer()
        p.send(message)
        result = p.read()
        assert result['code'] == code, result
        p.close()
        assert ping()['worker_pid'] == worker
        record(name)

    for name, data, code in (
        ('json_depth', b'[' * 9 + b'0' + b']' * 9 + b'\n', 'invalid_bounded_json'),
        ('frame_limit', b'{"x":"' + b'x' * 70000 + b'"}\n', 'frame_limit')):
        p = Peer()
        try: p.sock.sendall(data)
        except OSError: pass
        assert p.read()['code'] == code
        p.close()
        assert ping()['worker_pid'] == worker
        record(name)

    # A disconnected partial recording must not be retained by the next caller.
    with wave.open(str(ROOT / 'BAC009S0764W0121.wav'), 'rb') as wav:
        raw = wav.readframes(16000)
    p = Peer()
    p.send({'op': 'feed', 'pcm16_base64': base64.b64encode(raw).decode()})
    assert p.read()['type'] in ('partial', 'final')
    p.close()
    fresh = ping()
    assert fresh['audio_seen_seconds'] == 0 and fresh['worker_pid'] == worker
    record('disconnect_resets_native_stream')

    first = Peer(); second = Peer(False); third = Peer(False)
    first.close()
    assert second.read()['type'] == 'ready_session'
    # Third remains queued while second owns the native stream.
    third.sock.settimeout(.3)
    try:
        third.sock.recv(1)
        raise AssertionError('third_bypassed_fifo')
    except socket.timeout: pass
    third.sock.settimeout(27)
    second.close()
    assert third.read()['type'] == 'ready_session'
    third.close()
    record('real_native_fifo')

    # Verify the configured production idle timeout and passive native threads.
    idle = Peer(); queued = Peer(False)
    start_ticks = cpu_ticks(worker); start = time.monotonic()
    assert idle.read()['code'] == 'idle_timeout'
    assert queued.read()['type'] == 'ready_session'
    elapsed = time.monotonic() - start
    ticks = cpu_ticks(worker) - start_ticks
    assert 18 <= elapsed <= 25, elapsed
    idle.close(); queued.close()
    record('idle_timeout_releases_queue', {'wall_seconds': elapsed, 'native_cpu_ticks': ticks})

    for sample in ('BAC009S0764W0121.wav', 'BAC009S0916W0489.wav', 'IT0011W0002.wav', 'zh-short.wav'):
        proc = subprocess.run(['/usr/bin/python3', str(args.install_root/'asr-client.py'), str(ROOT / sample)],
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=40, check=True)
        result = json.loads(proc.stdout.decode())
        assert result['status'] == 'PASS_PROTOCOL' and result['endpoint_detected'], result
        assert result['worker_pid'] == worker and result['model_load_count'] == 1, result
        result['sample_id'] = sample
        report['speech'].append(result)
        record('paced_wav_' + sample, {'endpoint': True, 'tail_seconds': result['last_text_final_from_audio_deadline_seconds'],
                                     'max_rss_kib': result['max_rss_kib']})

    # Repeated short calls must preserve a single loaded model and stable native memory.
    before = ping()
    for _ in range(80):
        p = ping()
        assert p['worker_pid'] == worker and p['model_load_count'] == 1 and p['audio_seen_seconds'] == 0
    after = ping()
    assert after['max_rss_kib'] - before['max_rss_kib'] <= 1024, (before, after)
    record('eighty_calls_single_model', {'before_max_rss_kib': before['max_rss_kib'], 'after_max_rss_kib': after['max_rss_kib']})
    report['final_ping'] = after
    report['status'] = 'PASS'
except Exception as error:
    report['status'] = 'FAIL'
    report['error'] = repr(error)
finally:
    print(json.dumps(report, ensure_ascii=False), flush=True)
if report['status'] != 'PASS': raise SystemExit(1)
