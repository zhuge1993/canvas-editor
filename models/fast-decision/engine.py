"""Small semantic classifier: similarities and normalized matching weights."""
from collections import OrderedDict
import hashlib
import json
import math
from pathlib import Path
import queue
import resource
import subprocess
import threading
import time
from tokenizer import Tokenizer
from decision_contract import prepare,answer

MODEL='bge-small-zh-v1.5'
API_VERSION='fast-decision.v1'
SEMANTICS='normalized semantic similarity; not calibrated correctness probability'


class Engine:
    def __init__(self,root,worker,threads=2):
        self.root=Path(root).resolve()
        manifest=json.loads((self.root/'manifest.json').read_text())
        for relative in ['encoder.int8.onnx','assets/vocab.txt']:
            file=self.root/relative;expected=manifest['files'][file.name]
            if file.stat().st_size!=expected['bytes'] or hashlib.sha256(file.read_bytes()).hexdigest()!=expected['sha256']:
                raise ValueError('model artifact mismatch')
        self.tokenizer=Tokenizer(self.root/'assets');self.cache=OrderedDict()
        self.lock=threading.Lock();self.responses=queue.Queue(maxsize=2)
        def limits():
            resource.setrlimit(resource.RLIMIT_AS,(512*1024*1024,512*1024*1024))
            resource.setrlimit(resource.RLIMIT_CORE,(0,0))
        library=self.root/'runtime/lib'
        self.process=subprocess.Popen([str(library/'ld-linux-armhf.so.3'),'--library-path',str(library),str(worker),str(self.root/'encoder.int8.onnx'),str(threads)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,bufsize=1,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'},preexec_fn=limits)
        def read():
            try:
                for line in self.process.stdout:self.responses.put(line,timeout=2)
            finally:
                try:self.responses.put(None,timeout=2)
                except queue.Full:pass
        threading.Thread(target=read,daemon=True).start()
        try:ready=self.responses.get(timeout=20)
        except queue.Empty:self.close();raise RuntimeError('worker startup timeout')
        if ready!='READY\n':self.close();raise RuntimeError('worker startup failed')

    def temperature(self):
        values=[]
        for file in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
            try:
                value=float(file.read_text().strip());value=value/1000 if value>1000 else value
                if 0<value<150:values.append(value)
            except (OSError,ValueError):pass
        return max(values) if values else None

    def info(self):
        temperature=self.temperature()
        return {'api_version':API_VERSION,'model':MODEL,'available':self.process.poll() is None,'cooling':temperature is None or temperature>45,'output_token_decoding':False,'backend':'onnx-int8-armv7','max_path_tokens':128,'types':['choice','boolean','score'],'probability_semantics':SEMANTICS}

    def embed(self,texts,deadline):
        tokenized=[self.tokenizer.encode(text) for text in texts]
        vectors=[];offset=0
        while offset<len(texts):
            # Dynamic activation quantization depends on the batch range.
            # Encode each text separately so cold/warm/cache state cannot
            # change its embedding and therefore the decision distribution.
            batch=1
            chunk=tokenized[offset:offset+batch];width=max(map(len,chunk))
            packed=[token for ids in chunk for token in ids+[0]*(width-len(ids))]
            if self.process.poll() is not None:raise RuntimeError('worker exited')
            self.process.stdin.write('B '+str(batch)+' '+str(width)+' '+' '.join(map(str,packed))+'\n');self.process.stdin.flush()
            remaining=deadline-time.monotonic()
            try:line=self.responses.get(timeout=max(.001,remaining))
            except queue.Empty:self.close();raise RuntimeError('model deadline exceeded')
            if not line or not line.startswith('OK '):self.close();raise RuntimeError('invalid worker response')
            numbers=[float(value) for value in line.split()[1:]]
            if len(numbers)!=batch*512 or any(not math.isfinite(v) for v in numbers):self.close();raise RuntimeError('invalid embedding')
            vectors.extend(numbers[i*512:(i+1)*512] for i in range(batch));offset+=batch
        return vectors,sum(map(len,tokenized))

    def evaluate(self,payload):
        temperature=self.temperature()
        if temperature is None or temperature>45:raise RuntimeError('model cooling or temperature unavailable')
        prepared=prepare(payload)
        if len(prepared)!=1 or len(prepared[0]['questions'])>4 or any(len(q['keys'])>16 for q in prepared[0]['questions']):raise ValueError('request outside bounds')
        original=payload.get('requests',[payload])[0]
        state=original['state']
        if isinstance(state,dict) and isinstance(state.get('text'),str):
            text=state['text']+(('\n'+str(state['data'])) if state.get('data') else '')
        else:text=prepared[0]['state']
        start=time.monotonic();question_rows=prepared[0]['questions'];descriptions=[]
        for raw,q in zip(original['questions'],question_rows):
            if q['type']=='boolean':
                criteria=raw.get('criteria')
                if not isinstance(criteria,dict) or set(criteria)!= {'true','false'}:raise ValueError('boolean needs descriptive true/false criteria')
            descriptions.extend(q['candidates'])
        # Validate every input even when candidate embeddings are already cached.
        for candidate in [text,*descriptions]:self.tokenizer.encode(candidate)
        missing=list(dict.fromkeys(candidate for candidate in descriptions if candidate not in self.cache))
        with self.lock:
            stop=threading.Event()
            def watch():
                while not stop.wait(.5):
                    current=self.temperature()
                    if current is None or current>65:self.close();return
            threading.Thread(target=watch,daemon=True).start()
            try:
                vectors,tokens=self.embed([text,*missing],start+10)
                query=vectors[0]
                for candidate,vector in zip(missing,vectors[1:]):self.cache[candidate]=vector
                rows=[]
                for q in question_rows:
                    similarities=[sum(a*b for a,b in zip(query,self.cache[candidate])) for candidate in q['candidates']]
                    maximum=max(similarities)
                    masses=[math.exp((v-maximum)/.08) for v in similarities];total=sum(masses)
                    result=answer(q,[v/total for v in masses])
                    result['similarities']=dict(zip(q['keys'],similarities));rows.append(result)
                # Fixed-size RAM cache; user inputs and vectors are never persisted.
                for candidate in descriptions:self.cache.move_to_end(candidate)
                while len(self.cache)>128:self.cache.popitem(last=False)
                return {'api_version':API_VERSION,'model':MODEL,'probability_semantics':SEMANTICS,'results':[{'id':prepared[0]['id'],'answers':rows}],'usage':{'generated_tokens':0,'truncated_inputs':0,'input_path_tokens':tokens,'wall_ms':round((time.monotonic()-start)*1000,2)}}
            finally:stop.set()

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=2)
