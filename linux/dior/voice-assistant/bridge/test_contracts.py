"""Bridge host contracts with fake providers; not phone/model/Unix-DAC proof."""
import base64
import json
import socket
import threading
import time
import unittest
import errno
import sys
import ast
import hashlib
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from protocol import BridgeError,validate,receive
from server import InferenceBridge
from providers import Providers,model_diagnostics,runtime_limits

PEERS={107:{'gid':107,'role':'voice'},101:{'gid':101,'role':'web'}}
def req(op='chat',**data):return {'v':1,'id':'test','op':op,'deadline_ms':3000,**data}
class Fake:
    def __init__(self):self.prompts=[];self.block=False;self.entered=threading.Event();self.released=threading.Event();self.asr_aborts=0
    def alive(self):return True
    def cached(self,text):return text=='我在，请说。'
    def summary(self):return {'model_load_count':1,'native_worker_pid':123,'web_history':False}
    def chat(self,prompt,cancel,deadline):
        self.prompts.append(prompt);self.entered.set()
        while self.block and not self.released.wait(.01):
            if cancel.is_set():raise BridgeError('cancelled')
        return {'text':'回答'}
    def speech(self,text,cancel,deadline):return SimpleNamespace(pcm16=bytes(640),sample_rate=16000)
    def transcribe(self,pcm,cancel,deadline):
        self.entered.set()
        while not cancel.wait(.01):
            if self.released.is_set():return {'text':'实际路径待设备验证'}
        raise BridgeError('cancelled')
    def abort_asr(self):self.asr_aborts+=1
    def close(self):self.released.set()
class Contracts(unittest.TestCase):
    def setUp(self):self.fake=Fake();self.bridge=InferenceBridge(self.fake,PEERS,lambda:40)
    def tearDown(self):self.bridge.close()
    def finished(self,job):self.assertTrue(job.done.wait(2));return job.result
    def test_peer_uid_gid_and_operator_readonly(self):
        self.assertEqual(self.bridge.role(107,107),'voice')
        self.assertEqual(self.bridge.role(101,101),'web')
        for peer in ((101,107),(999,101)):
            with self.assertRaises(BridgeError):self.bridge.role(*peer)
        with self.assertRaises(BridgeError):validate(req(text='hi'),'operator')
        with self.assertRaises(BridgeError):validate(req('clear_history'),'web')
    def test_bounded_protocol_and_audio_validation(self):
        validate(req('transcribe',pcm16_base64=base64.b64encode(bytes(640000)).decode()),'web')
        with self.assertRaises(BridgeError):validate(req('transcribe',pcm16_base64=base64.b64encode(bytes(640002)).decode()),'web')
        with self.assertRaises(BridgeError):validate(req('tts',text='中'*121),'web')
        a,b=socket.socketpair()
        try:
            a.sendall(b'['*9+b'0'+b']'*9+b'\n')
            with self.assertRaises(BridgeError):receive(b,time.monotonic()+1)
        finally:a.close();b.close()
    def test_web_stateless_and_voice_history_isolated(self):
        self.finished(self.bridge.submit(req(text='voice-private'),'voice'))
        self.finished(self.bridge.submit(req(text='web-user-A',context='permitted project A'),'web'))
        self.finished(self.bridge.submit(req(text='web-user-B',context='permitted project B'),'web'))
        self.finished(self.bridge.submit(req(text='voice-follow'),'voice'))
        self.assertNotIn('voice-private',self.fake.prompts[1]);self.assertNotIn('web-user-A',self.fake.prompts[2])
        self.assertIn('voice-private',self.fake.prompts[3]);self.assertNotIn('web-user-B',self.fake.prompts[3])
        self.assertEqual(len(self.bridge.voice_history),2)
    def test_combined_model_prompt_is_768_bytes_and_reports_truncation(self):
        result=self.finished(self.bridge.submit(req(text='问'*300,context='资料'*200),'web'))
        self.assertLessEqual(len(self.fake.prompts[-1].encode()),768)
        self.assertTrue(result['text_truncated']);self.assertTrue(result['context_truncated'])
    def test_voice_preempts_web_and_same_provider_remains(self):
        self.fake.block=True
        web=self.bridge.submit(req(text='web'),'web');self.assertTrue(self.fake.entered.wait(1))
        voice=self.bridge.submit(req(text='voice'),'voice');self.fake.released.set()
        self.assertEqual(self.finished(web)['error_code'],'preempted')
        self.assertTrue(self.finished(voice)['ok']);self.assertEqual(self.bridge.provider.summary()['model_load_count'],1)
    def test_voice_asr_presence_closes_web_lease_and_blocks_new_web(self):
        pcm=base64.b64encode(bytes(640)).decode();web=self.bridge.submit(req('transcribe',pcm16_base64=pcm),'web')
        self.assertTrue(self.fake.entered.wait(1))
        self.bridge.control(req('begin_voice_asr',lease_id='lease',ttl_ms=20000),'voice')
        self.assertEqual(self.finished(web)['error_code'],'preempted');self.assertGreater(self.fake.asr_aborts,0)
        with self.assertRaises(BridgeError):self.bridge.submit(req(text='web'),'web')
        self.bridge.control(req('end_voice_asr',lease_id='lease'),'voice')
        self.assertTrue(self.finished(self.bridge.submit(req(text='web'),'web'))['ok'])
    def test_queue_has_hard_limit(self):
        self.fake.block=True;active=self.bridge.submit(req(text='voice'),'voice');self.assertTrue(self.fake.entered.wait(1))
        for _ in range(3):self.bridge.submit(req(text='waiting'),'web')
        with self.assertRaises(BridgeError):self.bridge.submit(req(text='overflow'),'web')
    def test_hot_dynamic_work_waits_but_fixed_voice_cache_preempts_and_remains_available(self):
        self.bridge.temperature=66;self.bridge.temperature_reader=lambda:66
        web=self.bridge.submit(req(text='web'),'web')
        until=time.monotonic()+1
        while web.state!='cooling' and time.monotonic()<until:time.sleep(.01)
        status=self.bridge.control(req('status'),'operator')
        self.assertTrue(status['cooling']);self.assertTrue(status['thermal_waiting'])
        self.assertEqual(status['active'],'chat');self.assertEqual(status['active_state'],'cooling')
        self.assertFalse(self.fake.entered.is_set())
        result=self.finished(self.bridge.submit(req('tts',text='我在，请说。'),'voice'))
        self.assertEqual(self.finished(web)['error_code'],'preempted')
        self.assertTrue(result['ok']);self.assertTrue(result['cache_hit']);self.assertFalse(result['model_inference_this_call'])
    def test_disconnect_cancels_active_job(self):
        self.fake.block=True;a,b=socket.socketpair();self.bridge.slots.acquire()
        thread=threading.Thread(target=self.bridge.handle,args=(b,(101,101)),daemon=True);thread.start()
        a.sendall((json.dumps(req(text='web'))+'\n').encode());self.assertTrue(self.fake.entered.wait(1));a.close()
        thread.join(1);self.assertFalse(thread.is_alive())
        until=time.monotonic()+1
        while self.bridge.active and time.monotonic()<until:time.sleep(.01)
        self.assertIsNone(self.bridge.active)
    def test_absolute_deadline_returns_before_uncooperative_late_provider(self):
        def late(prompt,cancel,deadline):time.sleep(1.4);return {'text':'late'}
        self.fake.chat=late;a,b=socket.socketpair();a.settimeout(2);self.bridge.slots.acquire()
        thread=threading.Thread(target=self.bridge.handle,args=(b,(101,101)),daemon=True);thread.start()
        begin=time.monotonic();request=req(text='web');request['deadline_ms']=1000
        a.sendall((json.dumps(request)+'\n').encode());data=bytearray()
        while b'\n' not in data:data.extend(a.recv(4096))
        self.assertEqual(json.loads(data)['error_code'],'deadline');self.assertLess(time.monotonic()-begin,1.3)
        a.close();thread.join(1)
    def test_hot_inflight_work_is_cancelled(self):
        self.fake.block=True;job=self.bridge.submit(req(text='web'),'web');self.assertTrue(self.fake.entered.wait(1))
        self.bridge.temperature=66
        self.assertEqual(self.finished(job)['error_code'],'thermal')
    def test_restart_fallback_is_fixed_cache_only_and_never_busy_bypass(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
        from client import BridgeTTS,VoiceASRLease
        clip=SimpleNamespace(pcm16=bytes(640),sample_rate=16000)
        class Missing:
            def request(self,*a,**kw):raise FileNotFoundError(errno.ENOENT,'socket absent')
        tts=BridgeTTS.__new__(BridgeTTS);tts.ipc=Missing();tts.fixed=SimpleNamespace(audio={'我在，请说。':clip})
        self.assertIs(tts.synthesize('我在，请说。',threading.Event()),clip)
        with self.assertRaises(OSError):tts.synthesize('dynamic reply',threading.Event())
        lease=VoiceASRLease('unused');lease.ipc=Missing();lease.begin();self.assertIsNone(lease.local.token)
        class Busy:
            def request(self,*a,**kw):raise RuntimeError('busy')
        tts.ipc=Busy();lease.ipc=Busy()
        with self.assertRaises(RuntimeError):tts.synthesize('我在，请说。',threading.Event())
        with self.assertRaises(RuntimeError):lease.begin()
    def test_fixed_cache_indices_match_actual_tts_builder_phrase_order(self):
        sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'runtime'))
        from client import FixedCache
        source=Path(__file__).resolve().parent.parent/'tts/offline_tts.py'
        tree=ast.parse(source.read_text(encoding='utf8'))
        actual=None
        for node in tree.body:
            if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='FIXED_PHRASES' for t in node.targets):
                actual=ast.literal_eval(node.value)
        self.assertIsNotNone(actual)
        self.assertEqual(tuple(actual),FixedCache.PHRASES)
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);phrases={}
            for index,phrase in enumerate(actual):
                data=bytes([index,0])*320;path=root/('phrase-%02d.pcm'%index);path.write_bytes(data);path.chmod(0o444)
                phrases[phrase]={'file':path.name,'bytes':len(data),'sample_rate':16000,'sha256':hashlib.sha256(data).hexdigest()}
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'schema':1,'engine':'piper',
                'model_sha256':'d30b143fac66d821a1285aa013295adf5cd129d3cc11d70334e51c7b20662c37','phrases':phrases}),encoding='utf8');manifest.chmod(0o444)
            try:
                cache=FixedCache(root)
                self.assertEqual(cache.audio['音量已设为百分之100。'].pcm16,bytes([5,0])*320)
                self.assertEqual(cache.audio['音量已设为百分之50。'].pcm16,bytes([6,0])*320)
            finally:
                for path in root.iterdir():path.chmod(0o600)
    def test_model_diagnostics_distinguish_empty_eos_without_private_payload(self):
        provider=Providers.__new__(Providers);provider.diagnostics_lock=threading.Lock()
        provider.last_model_diagnostics={'status':'not_run'};provider.last_error_type='none'
        provider.asr_path='nonexistent-contract-asr.sock';provider.tts=SimpleNamespace()
        model=SimpleNamespace(last_metrics=None,ready={'model_load_count':1},
            process=SimpleNamespace(pid=123,poll=lambda:None),clear_history=lambda:None)
        provider.model=model
        def empty(*args,**kwargs):
            model.last_metrics={'status':'complete','generated_tokens':0,'input_tokens':73,
                'cached_prefix_tokens':33,'first_token_seconds':-1,'prefill_seconds':7.09,
                'total_seconds':7.09,'max_rss_kib':455000,'gpu_used':False,
                'text':'private-native-text','id':'private-native-id','prompt':'private-prompt',
                'history':['private-history']}
            return SimpleNamespace(text='')
        model.generate=empty
        result=provider.chat('private-user-input',threading.Event(),time.monotonic()+3)
        summary=provider.summary()
        self.assertEqual(summary['last_error_type'],'empty_complete')
        self.assertEqual(summary['last_model_diagnostics']['generated_tokens'],0)
        self.assertEqual(summary['last_model_diagnostics']['status'],'complete')
        self.assertEqual(result['metrics'],summary['last_model_diagnostics'])
        encoded=json.dumps(summary)+json.dumps(result['metrics'])
        for secret in ('private-native-text','private-native-id','private-prompt','private-history','private-user-input'):
            self.assertNotIn(secret,encoded)
        model.generate=lambda *a,**kw:SimpleNamespace(text='')
        provider.chat('next-user',threading.Event(),time.monotonic()+3)
        self.assertEqual(provider.summary()['last_model_diagnostics'],{'status':'not_reported'})
        self.assertEqual(provider.summary()['last_error_type'],'empty_unreported')
    def test_model_diagnostics_reject_unbounded_values_and_exception_messages(self):
        poisoned={'status':'private-status','generated_tokens':65,'input_tokens':True,
            'first_token_seconds':float('inf'),'prefill_seconds':float('nan'),
            'total_seconds':10**1000,'max_rss_kib':-1,'gpu_used':'private-string'}
        self.assertEqual(model_diagnostics(poisoned),{'status':'unknown_status'})
        provider=Providers.__new__(Providers);provider.diagnostics_lock=threading.Lock()
        provider.last_model_diagnostics={'status':'not_run'};provider.last_error_type='none'
        provider.asr_path='nonexistent-contract-asr.sock';provider.tts=SimpleNamespace()
        model=SimpleNamespace(last_metrics=None,ready={'model_load_count':1},
            process=SimpleNamespace(pid=123,poll=lambda:None),clear_history=lambda:None)
        provider.model=model
        def rejected(*a,**kw):
            model.last_metrics={'status':'prompt_context_limit','input_tokens':0,'generated_tokens':0}
            return SimpleNamespace(text='')
        model.generate=rejected
        provider.chat('private-input',threading.Event(),time.monotonic()+3)
        self.assertEqual(provider.summary()['last_error_type'],'native_noncomplete')
        self.assertEqual(provider.summary()['last_model_diagnostics']['status'],'prompt_context_limit')
        def failed(*a,**kw):raise RuntimeError('private-exception-message')
        model.generate=failed
        with self.assertRaises(RuntimeError):provider.chat('private-input',threading.Event(),time.monotonic()+3)
        summary=provider.summary()
        self.assertEqual(summary['last_error_type'],'provider_error')
        self.assertEqual(summary['last_model_diagnostics'],{'status':'not_reported'})
        self.assertNotIn('private-exception-message',json.dumps(summary))
    def test_thermal_admission_is_hysteretic_and_uses_existing_worker(self):
        self.bridge.temperature=67;self.bridge.temperature_reader=lambda:self.bridge.temperature
        threads=(self.bridge.worker.ident,self.bridge.monitor.ident)
        job=self.bridge.submit(req(text='cooling query'),'web')
        until=time.monotonic()+1
        while job.state!='cooling' and time.monotonic()<until:time.sleep(.01)
        time.sleep(.12)
        self.assertFalse(job.cancel.is_set());self.assertFalse(self.fake.entered.is_set())
        with self.bridge.condition:self.bridge.temperature=53;self.bridge.condition.notify_all()
        time.sleep(.12);self.assertFalse(self.fake.entered.is_set())
        with self.bridge.condition:self.bridge.temperature=52;self.bridge.condition.notify_all()
        self.assertTrue(self.finished(job)['ok']);self.assertTrue(self.fake.entered.is_set())
        self.assertEqual(threads,(self.bridge.worker.ident,self.bridge.monitor.ident))
        self.assertFalse(self.bridge.control(req('status'),'operator')['cooling'])
    def test_thermal_wait_retains_cancel_and_original_deadline(self):
        self.bridge.temperature=60;self.bridge.temperature_reader=lambda:60
        job=self.bridge.submit(req(text='cancel cooling'),'web')
        until=time.monotonic()+1
        while job.state!='cooling' and time.monotonic()<until:time.sleep(.01)
        with self.bridge.condition:self.bridge._cancel(job,'cancelled');self.bridge.condition.notify_all()
        self.assertEqual(self.finished(job)['error_code'],'cancelled')
        request=req(text='deadline cooling');request['deadline_ms']=1000
        start=time.monotonic();result=self.finished(self.bridge.submit(request,'web'))
        self.assertEqual(result['error_code'],'deadline');self.assertLess(time.monotonic()-start,1.4)
        self.assertFalse(self.fake.entered.is_set())
        self.bridge.temperature=None
        result=self.finished(self.bridge.submit(req(text='unknown thermal'),'web'))
        self.assertEqual(result['error_code'],'thermal_unavailable')
    def test_config_limits_validate_before_provider_load_and_forward_actual_threads(self):
        self.assertEqual(runtime_limits({}),(3,52))
        for threads in (1,2,3,4):self.assertEqual(runtime_limits({'llm_threads':threads}),(threads,52))
        for config in ({'llm_threads':0},{'llm_threads':5},{'llm_threads':True},{'llm_threads':'3'},
                       {'thermal_admit_c':49},{'thermal_admit_c':53},{'thermal_admit_c':True}):
            with self.assertRaises(BridgeError):runtime_limits(config)
        with patch('providers.load') as loader:
            with self.assertRaises(BridgeError):Providers({'llm_threads':0})
            loader.assert_not_called()
        seen={}
        model=SimpleNamespace(ready={'threads':3,'model_load_count':1},process=SimpleNamespace(pid=123,poll=lambda:None))
        def model_factory(binary,weight,threads):seen['threads']=threads;return model
        modules=[SimpleNamespace(LocalLanguageModel=model_factory),SimpleNamespace(OfflineTTS=lambda **kw:SimpleNamespace())]
        config={'runtime_dir':'contract-runtime','llm_module':'contract-llm','llm_binary':'contract-binary',
                'llm_model':'contract-model','tts_module':'contract-tts','tts_base':'contract-tts-base','llm_threads':3}
        with patch('providers.load',side_effect=modules):provider=Providers(config)
        self.assertEqual(seen['threads'],3);self.assertEqual(provider.summary()['native_threads'],3)
if __name__=='__main__':unittest.main(verbosity=2)
