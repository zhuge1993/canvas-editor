"""Light host contracts only: no Piper, ONNX, model, phone, mic or cloud tests."""
from dataclasses import dataclass
import io
import hashlib
import json
import os
from pathlib import Path
import struct
import threading
import tempfile
import time
import unittest
import wave
from types import SimpleNamespace
from unittest.mock import patch
from persistent_tts import PersistentPiperTTS,PersistentTTSError,PersistentTTSCancelled,read_complete_wav,cumulative_inference_metrics,tmpfs_directory,select_child_cpus,persistent_child_setup,enforce_piper_threads,PosixPiperSession
from offline_tts import OfflineTTS,FIXED_PHRASES,PIPER_MODEL_SHA256,create_persistent

@dataclass(frozen=True)
class TTSAudio:
    pcm16:bytes
    sample_rate:int

class Delegate:
    engine='piper';max_seconds=20;timeout=1
    def __init__(self):self._fixed_cache={'ack':TTSAudio(bytes(640),16000)};self.last_report=None;self.fixed_cache_error=None
    def synthesize(self,text,cancel):
        self.last_report={'cache_hit':True,'model_inference_this_call':False,'worker_spawned':False}
        return self._fixed_cache[text]

class FakeSession:
    def __init__(self,index,action=None):self.index=index;self.calls=0;self.closed=False;self.action=action
    def request(self,text,cancel,deadline):
        self.calls+=1
        if self.action:self.action(cancel)
        return bytes([self.index,self.calls])*320,16000,{'model_load_this_call':self.calls==1,'scope':'fake_transport'}
    def close(self):self.closed=True
    def status(self):return {'alive':not self.closed,'initialized':True,'process_pid':123,'request_count':self.calls,
                            'anonymous_audio_bytes':0,'reader_threads':2,'stderr_buffer_bytes':0,'statistics_entries':0}

def wav_bytes(pcm,rate=16000,channels=1):
    out=io.BytesIO()
    with wave.open(out,'wb') as wav:wav.setnchannels(channels);wav.setsampwidth(2);wav.setframerate(rate);wav.writeframes(pcm)
    return out.getvalue()

class Contracts(unittest.TestCase):
    def test_postinit_worker_masks_are_restricted_and_rechecked_each_request(self):
        process=SimpleNamespace(pid=900,poll=lambda:None);masks={900:{0,1},901:{1},902:{2},903:{3}};sets=[]
        def setter(tid,cpus):sets.append(tid);masks[tid]=set(cpus)
        with patch('persistent_tts.piper_task_ids',return_value=(900,901,902,903)),patch.object(os,'sched_getaffinity',side_effect=lambda tid:masks[tid],create=True),patch.object(os,'sched_setaffinity',side_effect=setter,create=True):
            result=enforce_piper_threads(process,(0,1),threading.Event(),time.monotonic()+1)
            self.assertTrue(result['verified']);self.assertEqual(result['thread_count'],4)
            self.assertEqual(sets,[901,902,903]);self.assertNotIn(0,sets)
            masks[902]={2};enforce_piper_threads(process,(0,1),threading.Event(),time.monotonic()+1)
            self.assertEqual(sets[-1],902);self.assertTrue(all(mask=={0,1} for mask in masks.values()))
    def test_postinit_affinity_failure_cancel_deadline_and_churning_tasks_fail_closed(self):
        process=SimpleNamespace(pid=900,poll=lambda:None);cancel=threading.Event();cancel.set()
        with self.assertRaises(PersistentTTSCancelled):enforce_piper_threads(process,(0,1),cancel,time.monotonic()+1)
        with self.assertRaises(PersistentTTSError):enforce_piper_threads(process,(0,1),threading.Event(),time.monotonic()-1)
        with patch('persistent_tts.piper_task_ids',return_value=(900,901)),patch.object(os,'sched_getaffinity',return_value={3},create=True),patch.object(os,'sched_setaffinity',side_effect=PermissionError('denied'),create=True):
            with self.assertRaises(PermissionError):enforce_piper_threads(process,(0,1),threading.Event(),time.monotonic()+1)
        with patch('persistent_tts.piper_task_ids',side_effect=[(900,901),(900,902),(900,902),(900,903),(900,903),(900,904)]),patch.object(os,'sched_getaffinity',return_value={0,1},create=True):
            with self.assertRaises(PersistentTTSError):enforce_piper_threads(process,(0,1),threading.Event(),time.monotonic()+1)
    def test_synthesis_json_is_not_written_on_failed_postinit_barrier(self):
        session=PosixPiperSession.__new__(PosixPiperSession)
        session.closed=False;session.fault=threading.Event();session.initialized=threading.Event();session.initialized.set()
        session.process=SimpleNamespace(poll=lambda:None,stdin=unittest.mock.Mock());session.queue=__import__('queue').Queue()
        session.file=io.BytesIO();session.request_count=0;session.path='/proc/self/fd/4';session.synthesis_active=threading.Event()
        session._enforce_affinity=unittest.mock.Mock(side_effect=PersistentTTSError('failed_mask'))
        session.close=unittest.mock.Mock(side_effect=lambda:setattr(session,'closed',True))
        with self.assertRaises(PersistentTTSError):session.request('synthetic',threading.Event(),time.monotonic()+1)
        session.process.stdin.write.assert_not_called();session.close.assert_called_once()
        self.assertFalse(session.synthesis_active.is_set())
    def test_affinity_selects_only_inherited_cpus_without_changing_parent(self):
        with patch.object(os,'sched_getaffinity',return_value={7,3,5,9},create=True) as getter,patch.object(os,'sched_setaffinity',create=True) as setter:
            self.assertEqual(select_child_cpus(2),(3,5));getter.assert_called_once_with(0);setter.assert_not_called()
            getter.return_value={7};self.assertEqual(select_child_cpus(2),(7,))
            self.assertIsNone(select_child_cpus(None));setter.assert_not_called()
    def test_affinity_preexec_after_existing_guards_and_before_exec(self):
        events=[]
        resource=SimpleNamespace(RLIMIT_FSIZE=1,RLIM_INFINITY=-1,getrlimit=lambda kind:(-1,-1),
            setrlimit=lambda kind,value:events.append(('fsize',kind,value)))
        module=SimpleNamespace(_RESOURCE=resource,_unix_child_setup=lambda parent:events.append(('guards',parent)))
        persistent_child_setup(module,123,644096,(3,5),lambda pid,cpus:events.append(('affinity',pid,cpus)))
        self.assertEqual(events,[('guards',123),('fsize',1,(644096,644096)),('affinity',0,(3,5))])
        def fail(pid,cpus):raise OSError('affinity denied')
        with self.assertRaises(OSError):persistent_child_setup(module,123,644096,(3,5),fail)
    def test_affinity_bounds_and_no_lazy_cpu_probe_or_fixed_cache_spawn(self):
        for invalid in (True,False,0,3,1.0,'2'):
            with self.assertRaises(ValueError):PersistentPiperTTS(Delegate(),max_cpus=invalid)
        with patch.object(os,'sched_getaffinity',side_effect=AssertionError('lazy CPU probe'),create=True):
            tts=PersistentPiperTTS(Delegate(),max_cpus=2);self.addCleanup(tts.close)
            self.assertEqual(tts.status()['cpu_affinity_requested_max'],2)
            self.assertEqual(tts.synthesize('ack',threading.Event()).pcm16,bytes(640))
        with patch.object(os,'sched_setaffinity',None,create=True):
            with self.assertRaises(PersistentTTSError):select_child_cpus(2)
    def test_factory_forwards_affinity_option_only_to_persistent_piper(self):
        constructor=unittest.mock.Mock(return_value='wrapped')
        with patch('offline_tts._trusted_persistent_module',return_value=SimpleNamespace(PersistentPiperTTS=constructor)):
            self.assertEqual(create_persistent(engine='piper',max_cpus=2),'wrapped')
            self.assertEqual(constructor.call_args.kwargs,{'max_cpus':2})
            self.assertIsInstance(create_persistent(engine='espeak',max_cpus=2),OfflineTTS)
    def facade(self,action=None):
        self.sessions=[]
        def factory():
            session=FakeSession(len(self.sessions)+1,action);self.sessions.append(session);return session
        obj=PersistentPiperTTS(Delegate(),session_factory=factory);self.addCleanup(obj.close);return obj
    def test_fixed_cache_does_not_spawn_or_infer(self):
        tts=self.facade();clip=tts.synthesize('ack',threading.Event())
        self.assertEqual(clip.pcm16,bytes(640));self.assertEqual(len(self.sessions),0)
        self.assertFalse(tts.last_report['model_inference_this_call'])
    def test_two_dynamic_requests_reuse_one_session_without_previous_audio(self):
        tts=self.facade();a=tts.synthesize('first',threading.Event());b=tts.synthesize('second',threading.Event())
        self.assertEqual(len(self.sessions),1);self.assertEqual(self.sessions[0].calls,2)
        self.assertNotEqual(a.pcm16,b.pcm16);self.assertFalse(tts.last_report['model_load_this_call'])
    def test_late_cancel_discards_audio_and_next_request_has_new_session(self):
        def cancel_late(cancel):cancel.set()
        tts=self.facade(cancel_late)
        with self.assertRaises(PersistentTTSCancelled):tts.synthesize('cancelled',threading.Event())
        self.assertTrue(self.sessions[0].closed);self.assertIsNone(tts.session)
        tts.factory=lambda:FakeSession(2)
        self.assertEqual(tts.synthesize('new',threading.Event()).pcm16,bytes([2,1])*320)
    def test_busy_and_input_bounds_are_explicit(self):
        tts=self.facade()
        for text in ('','x'*121,'\0'):
            with self.assertRaises(PersistentTTSError):tts.synthesize(text,threading.Event())
        tts.lock.acquire()
        try:
            with self.assertRaises(PersistentTTSError):tts.synthesize('busy',threading.Event())
        finally:tts.lock.release()
        self.assertEqual(self.sessions,[])
    def test_late_deadline_audio_is_discarded_and_session_closed(self):
        tts=self.facade(lambda cancel:time.sleep(.02));tts.delegate.timeout=.01
        with self.assertRaises(PersistentTTSError):tts.synthesize('late',threading.Event())
        self.assertTrue(self.sessions[0].closed);self.assertIsNone(tts.session)
    def test_wav_ack_before_flush_does_not_return_partial_or_old_pcm(self):
        complete=wav_bytes(bytes([3,0])*320);out=io.BytesIO(complete[:44])
        self.assertIsNone(read_complete_wav(out,644096))
        out.seek(0);out.write(complete)
        self.assertEqual(read_complete_wav(out,644096),bytes([3,0])*320)
    def test_bad_wav_size_format_and_junk_are_rejected(self):
        bad=bytearray(wav_bytes(bytes(640)));bad[4:8]=struct.pack('<I',1000000)
        for content in (bytes(bad),wav_bytes(bytes(640),24000),wav_bytes(bytes(640))+b'junk',b'bad header data'):
            with self.assertRaises(PersistentTTSError):read_complete_wav(io.BytesIO(content),644096)
    def test_no_more_work_after_close(self):
        tts=self.facade();tts.synthesize('first',threading.Event());tts.close()
        self.assertTrue(self.sessions[0].closed)
        with self.assertRaises(PersistentTTSCancelled):tts.synthesize('later',threading.Event())
    def test_idle_constructor_and_status_never_start_work(self):
        tts=self.facade();self.assertEqual(tts.status()['state'],'not_started')
        for _ in range(100):self.assertFalse(tts.status()['lazy_started'])
        self.assertEqual(self.sessions,[])
        tts.synthesize('first',threading.Event());self.assertEqual(tts.status()['state'],'idle')
        self.assertEqual(tts.status()['anonymous_audio_bytes'],0)
    def test_cumulative_metrics_use_adjacent_deltas_or_none(self):
        values=[(1,1.075,1.208,.89),(2,3.223,3.584,.9),(3,4.215,4.792,.88)]
        a=cumulative_inference_metrics(values,1);b=cumulative_inference_metrics(values,2);c=cumulative_inference_metrics(values,3)
        self.assertEqual(a['onnx_infer_cumulative_seconds_reported'],1.075)
        self.assertAlmostEqual(b['onnx_infer_seconds_delta'],2.148)
        self.assertAlmostEqual(c['onnx_infer_seconds_delta'],.992)
        self.assertIsNone(cumulative_inference_metrics([values[2]],3)['onnx_infer_seconds_delta'])
        self.assertIsNone(cumulative_inference_metrics(values,4)['onnx_infer_seconds_delta'])
        self.assertIsNone(cumulative_inference_metrics([(1,3.,2.,1.),(2,1.,3.,1.)],2)['onnx_infer_seconds_delta'])
    def test_tmpfs_requirement_never_falls_back_to_disk(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();line='none '+str(root)+' ext4 rw 0 0\n'
            with patch.object(Path,'read_text',return_value=line):
                with self.assertRaises(PersistentTTSError):tmpfs_directory(root)
    def test_existing_fixed_cache_including_notice_is_forwarded_without_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);cache=base/'fixed-cache';cache.mkdir();pcm=b'\x12\x00'*320
            phrase=FIXED_PHRASES[-1];index=FIXED_PHRASES.index(phrase);name='phrase-%02d.pcm'%index
            (cache/name).write_bytes(pcm)
            (cache/'manifest.json').write_text(json.dumps({'schema':1,'engine':'piper','model_sha256':PIPER_MODEL_SHA256,
                'phrases':{phrase:{'file':name,'bytes':len(pcm),'sample_rate':16000,'sha256':hashlib.sha256(pcm).hexdigest()}}}),encoding='utf8')
            original=OfflineTTS(base,'piper');wrapped=PersistentPiperTTS(original,session_factory=lambda:(_ for _ in ()).throw(AssertionError('spawn')))
            try:
                self.assertIs(wrapped._fixed_cache,original._fixed_cache)
                self.assertEqual(wrapped.synthesize(phrase,threading.Event()).pcm16,pcm)
                self.assertFalse(wrapped.last_report['model_inference_this_call'])
            finally:wrapped.close()
            mechanical=create_persistent(base,'espeak');self.assertIsInstance(mechanical,OfflineTTS)

suite=unittest.defaultTestLoader.loadTestsFromTestCase(Contracts)
result=unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'tests_run':result.testsRun,
    'failures':len(result.failures),'errors':len(result.errors),
    'scope':'fake session + actual WAV/facade/cumulative/cache bounds; no new model/phone or Linux FD lifecycle execution'}),flush=True)
raise SystemExit(0 if result.wasSuccessful() else 1)
