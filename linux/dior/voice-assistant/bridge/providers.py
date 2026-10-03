"""One resident qualified Qwen adapter, existing shared ASR and readonly Piper."""
import base64
import importlib.util
import math
import os
from pathlib import Path
import socket
import stat
import sys
import threading
import time
from protocol import BridgeError,receive,encode,validate_messages
sys.dont_write_bytecode=True

FIXED={'我在，请说。','好的，唤醒词已经更新。','好的，保持原来的唤醒词。','请说确认，或者取消。',
       '音量已设为百分之0。','音量已设为百分之50。','音量已设为百分之100。','我还没听清，请再说一遍。','好的。','请稍等。',
       '这次没有及时回答，请再问一次。'}

MODEL_STATUSES={'complete','cancelled','deadline','decode_error','prompt_context_limit',
                'token_piece_limit','output_limit','invalid_evidence'}
def thermal_limits(config):
    admit=config.get('thermal_admit_c',52);tts_admit=config.get('tts_thermal_admit_c',admit)
    if any(type(value) is not int or not 45<=value<=52 for value in (admit,tts_admit)):
        raise BridgeError('invalid_config')
    return admit,tts_admit

def runtime_limits(config):
    threads=config.get('llm_threads',3);admit,_=thermal_limits(config)
    if type(threads) is not int or not 1<=threads<=4:raise BridgeError('invalid_config')
    return threads,admit

def model_diagnostics(metrics):
    """Only bounded numbers and a fixed status enum; never retain native text/id."""
    if not isinstance(metrics,dict):return {'status':'not_reported'}
    status=metrics.get('status')
    result={'status':status if isinstance(status,str) and status in MODEL_STATUSES else 'unknown_status'}
    integers={'input_tokens':1024,'cached_prefix_tokens':1024,'prefix_tokens_reused':512,'generated_tokens':128,
              'max_rss_kib':2**31-1,'history_excerpt_turns':2}
    for key,maximum in integers.items():
        value=metrics.get(key)
        if type(value) is int and 0<=value<=maximum:result[key]=value
    for key in ('first_token_seconds','prefill_seconds','total_seconds'):
        value=metrics.get(key)
        minimum=-1 if key=='first_token_seconds' else 0
        if type(value) in (int,float) and minimum<=value<=300 and math.isfinite(value):result[key]=value
    if type(metrics.get('gpu_used')) is bool:result['gpu_used']=metrics['gpu_used']
    if type(metrics.get('prefix_cache_hit')) is bool:result['prefix_cache_hit']=metrics['prefix_cache_hit']
    return result

def tts_diagnostics(value):
    """Bounded status only; no text, paths, audio, stderr or request identifiers."""
    if not isinstance(value,dict):return {'state':'unavailable'}
    result={}
    for key in ('persistent','lazy_started','alive','initialized','closed','cloud_used','audio_file_persisted',
                'cpu_affinity_preexec_applied','cpu_affinity_threads_verified'):
        if type(value.get(key)) is bool:result[key]=value[key]
    bounds={'process_pid':2**31-1,'worker_start_count':2**31-1,'request_count':2**31-1,
            'anonymous_audio_bytes':644096,'reader_threads':2,'stderr_buffer_bytes':8192,'statistics_entries':4,
            'cpu_affinity_requested_max':2,'cpu_affinity_preexec_count':2,
            'cpu_affinity_verified_thread_count':64,'cpu_affinity_checks':2**31-1}
    for key,maximum in bounds.items():
        item=value.get(key)
        if type(item) is int and 0<=item<=maximum:result[key]=item
    if value.get('state') in ('not_started','idle','active','unavailable','closed'):result['state']=value['state']
    if value.get('last_error') in ('none','cancelled','deadline','unavailable'):result['last_error']=value['last_error']
    return result
def load(path,name):
    path=Path(path);info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or path.resolve()!=path:raise BridgeError('untrusted_provider')
    parent=str(path.parent)
    if parent not in sys.path:sys.path.insert(0,parent)
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module);return module
def temperature():
    values=[]
    for path in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            value=float(path.read_text().strip());value=value/1000 if abs(value)>200 else value
            if -20<=value<=150:values.append(value)
        except (OSError,ValueError):pass
    return max(values) if values else None

class Providers:
    def __init__(self,config):
        threads,_=runtime_limits(config)
        runtime=str(Path(config['runtime_dir']))
        if runtime not in sys.path:sys.path.insert(0,runtime)
        self.model=load(config['llm_module'],'dior_shared_model').LocalLanguageModel(
            config['llm_binary'],config['llm_model'],threads=threads)
        self.tts=load(config['tts_module'],'dior_shared_tts').create_persistent(base=Path(config['tts_base']),engine='piper',max_cpus=2)
        self.asr_path=config.get('asr_socket','/run/dior-asr/recognize.sock')
        self.asr_lock=threading.Lock();self.asr_connection=None
        self.diagnostics_lock=threading.Lock()
        self.last_model_diagnostics={'status':'not_run'};self.last_error_type='none'
    def alive(self):return self.model.process.poll() is None
    def cached(self,text):return text in FIXED and text in getattr(self.tts,'_fixed_cache',{})
    def summary(self):
        path=Path(self.asr_path)
        asr=path.exists() and stat.S_ISSOCK(path.lstat().st_mode)
        with self.diagnostics_lock:
            diagnostics=dict(self.last_model_diagnostics);error_type=self.last_error_type
        native_threads=self.model.ready.get('threads')
        if type(native_threads) is not int or not 1<=native_threads<=4:native_threads=None
        model_id=self.model.ready.get('model_id','Qwen2.5-0.5B-Instruct-Q4_0')
        if model_id not in ('Qwen2.5-0.5B-Instruct-Q4_0','Qwen3.5-0.8B-Q4_0'):model_id='unknown'
        engine_tag=self.model.ready.get('engine_tag','b3927')
        if engine_tag not in ('b3927','b11371'):engine_tag='unknown'
        try:tts_state=tts_diagnostics(self.tts.status()) if callable(getattr(self.tts,'status',None)) else {'persistent':False,'state':'idle'}
        except Exception:tts_state={'persistent':True,'state':'unavailable'}
        return {'model_load_count':self.model.ready.get('model_load_count',1),'native_worker_pid':self.model.process.pid,
            'native_threads':native_threads,'model_id':model_id,'engine_tag':engine_tag,
            'native_alive':self.alive(),'backend':'CPU_NEON','public_tcp':False,'web_history':False,
            'last_model_diagnostics':diagnostics,'last_error_type':error_type,
            'tts_state':tts_state,
            'capabilities':{'chat':self.alive(),'chat_messages':callable(getattr(self.model,'generate_messages',None)),
                            'prepare_system':callable(getattr(self.model,'prepare_system',None)) and self.model.ready.get('prepare_system_supported') is True,
                            'speech':self.tts is not None,'transcribe':asr},
            'capability_scope':'initialized provider; each call still validates runtime/availability'}
    def chat(self,prompt,cancel,deadline):
        return self._chat(prompt,cancel,deadline,structured=False)
    def chat_messages(self,messages,cancel,deadline):
        validate_messages(messages)
        if not callable(getattr(self.model,'generate_messages',None)):raise BridgeError('messages_unsupported')
        return self._chat(messages,cancel,deadline,structured=True)
    def _chat(self,prompt,cancel,deadline,structured):
        # Explicit-message adapters own no semantic history. Their bounded
        # exact-token inference checkpoints survive calls until scheduler clear.
        legacy_history=getattr(self.model,'explicit_messages',False) is not True
        previous_metrics=self.model.last_metrics
        with self.diagnostics_lock:
            self.last_model_diagnostics={'status':'running'};self.last_error_type='none'
        try:
            if legacy_history:self.model.clear_history()
            if structured:reply=self.model.generate_messages(prompt,cancel=cancel,deadline=deadline)
            else:reply=self.model.generate(prompt,cancel=cancel,deadline=deadline,web_evidence=None)
            raw=self.model.last_metrics
            diagnostics=model_diagnostics(raw if raw is not previous_metrics else None)
            error_type='none'
            if not reply.text:
                if cancel.is_set():error_type='cancelled'
                elif time.monotonic()>=deadline:error_type='deadline'
                elif diagnostics['status']=='complete':error_type='empty_complete'
                elif diagnostics['status']=='not_reported':error_type='empty_unreported'
                else:error_type='native_noncomplete'
            with self.diagnostics_lock:
                self.last_model_diagnostics=diagnostics;self.last_error_type=error_type
            if cancel.is_set():raise BridgeError('cancelled')
            return {'text':reply.text[:120],'metrics':diagnostics}
        except Exception as error:
            raw=self.model.last_metrics
            diagnostics=model_diagnostics(raw if raw is not previous_metrics else None)
            if cancel.is_set():error_type='cancelled'
            elif isinstance(error,TimeoutError) or time.monotonic()>=deadline:error_type='deadline'
            elif isinstance(error,ValueError):error_type='invalid_input'
            elif isinstance(error,OSError):error_type='provider_transport'
            else:error_type='provider_error'
            with self.diagnostics_lock:
                self.last_model_diagnostics=diagnostics;self.last_error_type=error_type
            raise
        finally:
            if legacy_history:self.model.clear_history()
    def clear_history(self):
        # Called only by the inference worker, never the connection handler.
        self.model.clear_history()
    def prepare_system(self,system,cancel,deadline):
        prepare=getattr(self.model,'prepare_system',None)
        if not callable(prepare):raise BridgeError('prepare_system_unsupported')
        value=prepare(system,cancel=cancel,deadline=deadline)
        if not isinstance(value,dict) or value.get('status')!='complete' or value.get('initialized') is not True or \
           type(value.get('prefix_tokens')) is not int or not 1<=value['prefix_tokens']<=512 or \
           type(value.get('generated_tokens')) is not int or value['generated_tokens']!=0 or type(value.get('cache_hit')) is not bool:
            raise BridgeError('unavailable')
        return {key:value[key] for key in ('status','initialized','prefix_tokens','generated_tokens','cache_hit')}
    def speech(self,text,cancel,deadline):
        clip=self.tts.synthesize(text,cancel)
        if cancel.is_set() or time.monotonic()>=deadline:raise BridgeError('cancelled')
        if clip.sample_rate!=16000 or len(clip.pcm16)>640000:raise BridgeError('audio_limit')
        return clip
    def abort_asr(self):
        with self.asr_lock:connection=self.asr_connection
        if connection:
            try:connection.shutdown(socket.SHUT_RDWR)
            except OSError:pass
    def transcribe(self,pcm,cancel,deadline):
        connection=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);buffer=bytearray();serial=0
        with self.asr_lock:self.asr_connection=connection
        def reply():
            if cancel.is_set():raise BridgeError('cancelled')
            return receive(connection,min(deadline,time.monotonic()+3),buffer,65536)
        def request(op,**payload):
            nonlocal serial
            serial+=1;ident='bridge_'+str(serial)
            connection.sendall(encode({'op':op,'id':ident,**payload},65536));result=reply()
            if result.get('id')!=ident or result.get('type')=='error':raise BridgeError('asr_unavailable')
            return result
        try:
            connection.settimeout(2);connection.connect(self.asr_path)
            while True:
                result=reply()
                if result.get('type')=='ready_session':break
                if result.get('type')!='queued':raise BridgeError('asr_unavailable')
            texts=[]
            for at in range(0,len(pcm),32000):
                if cancel.is_set() or time.monotonic()>=deadline:raise BridgeError('cancelled')
                result=request('feed',pcm16_base64=base64.b64encode(pcm[at:at+32000]).decode())
                if result.get('type')=='final' and result.get('text'):texts.append(result['text'])
            result=request('finish')
            if result.get('text'):texts.append(result['text'])
            return {'text':' '.join(texts)[:1024],'audio_seconds':len(pcm)/32000,'input_mode':'uploaded_pcm16','endpoint_claim':False}
        finally:
            with self.asr_lock:
                if self.asr_connection is connection:self.asr_connection=None
            connection.close()
    def close(self):
        self.abort_asr();self.model.close()
        if hasattr(self.tts,'close'):self.tts.close()
