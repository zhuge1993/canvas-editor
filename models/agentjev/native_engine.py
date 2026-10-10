"""AgentJev through the ARM worker with stdlib-only tokenization and readout."""
import hashlib
import json
import math
import os
from pathlib import Path
import queue
import resource
import subprocess
import threading
import time
from portable_tokenizer import Tokenizer
from decision_contract import API_VERSION, prepare, encode_paths, answer


class NativeEngine:
    def __init__(self, root, worker, threads=2, max_tokens=1024):
        self.root = Path(root).resolve()
        self.tokenizer = Tokenizer(self.root/'assets')
        self.max_tokens = max_tokens
        self.lock = threading.Lock()
        self.temperatures = {kind: value['temperature'] for kind, value in json.loads((self.root/'assets/temperatures.json').read_text()).items()}
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LD_LIBRARY_PATH': str(self.root/'runtime/lib')}
        def limits():
            resource.setrlimit(resource.RLIMIT_AS, (1536*1024*1024, 1536*1024*1024))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        loader = self.root/'runtime/lib/ld-linux-armhf.so.3'
        self.process = subprocess.Popen([str(loader), '--library-path', str(self.root/'runtime/lib'), str(worker), str(self.root/'model/encoder.int8.onnx'), str(self.root/'model/head.onnx'), str(threads)],
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
                                        env=env, preexec_fn=limits)
        self.responses = queue.Queue(maxsize=2)
        def read():
            try:
                for line in self.process.stdout:
                    self.responses.put(line, timeout=2)
            finally:
                try: self.responses.put(None, timeout=2)
                except queue.Full: pass
        threading.Thread(target=read, daemon=True).start()
        if self.responses.get(timeout=90) != 'READY\n':
            self.close(); raise RuntimeError('native model failed to initialize')

    def info(self):
        temperature=self.temperature()
        return {'api_version': API_VERSION, 'model': 'AgentJev-0.6B', 'output_token_decoding': False, 'available': self.process.poll() is None,
                'cooling':temperature is None or temperature > 45,
                'max_path_tokens': self.max_tokens, 'types': ['boolean','choice','score'], 'backend': 'onnx-int8-armv7',
                'probability_semantics': 'model distribution; domain calibration is not guaranteed'}

    def temperature(self):
        values = []
        for sensor in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
            try:
                value = float(sensor.read_text().strip())
                if value > 1000: value /= 1000
                if 0 < value < 150: values.append(value)
            except (OSError, ValueError): pass
        return max(values) if values else None

    def call(self, kind, n, values, deadline):
        if self.process.poll() is not None: raise RuntimeError('native worker exited')
        encoded = map(str, values) if kind != 'H' else (format(value,'.9g') for value in values)
        self.process.stdin.write(f'{kind} {n} '+' '.join(encoded)+'\n'); self.process.stdin.flush()
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            self.close(); raise RuntimeError('model deadline exceeded')
        try: line = self.responses.get(timeout=remaining)
        except queue.Empty:
            self.close(); raise RuntimeError('model deadline exceeded')
        if not line or not line.startswith('OK '): raise RuntimeError('native inference failed')
        result = [float(value) for value in line.split()[1:]]
        if any(not math.isfinite(value) for value in result): raise RuntimeError('nonfinite result')
        return result

    def evaluate(self, payload):
        temperature = self.temperature()
        if temperature is None or temperature > 45: raise RuntimeError('model cooling or temperature unavailable')
        prepared = prepare(payload)
        paths, locations, rows = encode_paths(prepared, self.tokenizer, self.max_tokens)
        if len(prepared) != 1 or len(rows) > 4 or any(len(q['keys']) > 16 for q in rows): raise ValueError('request exceeds phone bounds')
        start = time.monotonic(); vectors = [[] for _ in rows]
        with self.lock:
            deadline = start + 55
            watching = threading.Event()
            def watch_temperature():
                while not watching.wait(0.5):
                    current = self.temperature()
                    if current is None or current > 65:
                        self.close(); return
            threading.Thread(target=watch_temperature,daemon=True).start()
            try:
                return self._evaluate_paths(prepared,paths,locations,rows,vectors,start,deadline)
            finally:
                watching.set()

    def _evaluate_paths(self,prepared,paths,locations,rows,vectors,start,deadline):
        offset = 0
        while offset < len(paths):
            count = min(4,len(paths)-offset)
            while count > 1 and count*max(map(len,paths[offset:offset+count])) > 256: count -= 1
            chunk = paths[offset:offset+count]
            width = max(map(len,chunk))
            packed = [width]+[token for ids in chunk for token in ids+[151643]*(width-len(ids))]+list(map(len,chunk))
            encoded = self.call('B',count,packed,deadline)
            if len(encoded) != count*1024: raise RuntimeError('wrong encoder shape')
            for i in range(count):
                qi,ci=locations[offset+i]
                vectors[qi].extend(encoded[i*1024:(i+1)*1024])
            offset += count
        answers = []
        for qi, question in enumerate(rows):
            logits = self.call('H', len(question['keys']), vectors[qi], deadline)
            if len(logits) != len(question['keys']): raise RuntimeError('wrong head shape')
            temp = self.temperatures[question['type']]
            maximum = max(logits)
            masses = [math.exp((value-maximum)/temp) for value in logits]
            total = sum(masses)
            answers.append(answer(question, [value/total for value in masses]))
        return {'api_version': API_VERSION, 'model': 'AgentJev-0.6B', 'results': [{'id': prepared[0]['id'], 'answers': answers}],
                'usage': {'generated_tokens': 0, 'truncated_inputs': 0, 'input_path_tokens': sum(map(len, paths)), 'wall_ms': round((time.monotonic()-start)*1000,2)}}

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=2)
            except subprocess.TimeoutExpired: self.process.kill(); self.process.wait(timeout=2)
