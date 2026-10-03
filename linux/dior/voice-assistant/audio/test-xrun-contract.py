#!/usr/bin/env python3
"""Host ALSA fault contracts; these do not open phone audio or test real AEC."""
import ctypes
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'runtime'))
from dior_audio import DiorAudio, FRAME


class FakeAlsa:
    def __init__(self,*,read_returns=(),write_returns=()):
        self.read_returns=list(read_returns);self.write_returns=list(write_returns)
        self.read_requests=[];self.write_requests=[];self.written=[];self.recovery_calls=[]

    def pcm_readi(self,handle,pointer,frames):
        self.read_requests.append(frames)
        count=self.read_returns.pop(0) if self.read_returns else frames
        if count>0:ctypes.memmove(pointer,b'\x34\x12'*count,count*2)
        return count

    def pcm_writei(self,handle,pointer,frames):
        self.write_requests.append(frames)
        count=self.write_returns.pop(0) if self.write_returns else frames
        if count>0:self.written.append(ctypes.string_at(pointer,count*2))
        return count

    def pcm_wait(self,handle,timeout):return 1

    def pcm_prepare(self,handle):
        self.recovery_calls.append('prepare');return 0

    def pcm_start(self,handle):
        self.recovery_calls.append('start');return 0

    def check(self,value,label):
        if value<0:raise RuntimeError(label+': '+str(value))


class FakeEcho:
    def __init__(self):self.resets=0
    def reset(self):self.resets+=1
    def process(self,near,far):return near,near


class XrunContracts(unittest.TestCase):
    def device(self,**kwargs):
        device=DiorAudio(aec_verified=True)
        device.audio=FakeAlsa(**kwargs);device.echo=FakeEcho();device._started=True
        return device

    def assert_fault(self,reading):
        device=self.device(**({'read_returns':[-32]} if reading else {'write_returns':[-32]}))
        device.frames=42
        with self.assertRaisesRegex(RuntimeError,'^pcm_xrun_requires_reopen$'):
            device._transfer(None,b'\x00\x00'*FRAME,FRAME,reading)
        self.assertEqual(device.xruns,1)
        self.assertEqual(device.xrun_events,[{'reading':reading,'frame':42}])
        self.assertEqual(device.audio.recovery_calls,[])
        self.assertEqual(device.echo.resets,0)
        self.assertFalse(device.capabilities().aec_verified)

    def test_capture_xrun_requires_reopen_without_one_sided_recovery(self):
        self.assert_fault(True)

    def test_playback_xrun_requires_reopen_without_one_sided_recovery(self):
        self.assert_fault(False)

    def assert_io_fault(self,reading):
        device=self.device(**({'read_returns':[-32]} if reading else {'write_returns':[-32]}))
        delivered=[];device.on_frame=delivered.append
        device._io()
        self.assertEqual(device.status()['error'],'pcm_xrun_requires_reopen')
        self.assertFalse(device.capabilities().microphone_available)
        self.assertFalse(device.capabilities().speaker_available)
        self.assertEqual(delivered,[])
        self.assertEqual(device.audio.recovery_calls,[])
        self.assertEqual(device.echo.resets,0)

    def test_capture_fault_reaches_foreground_status_gate(self):
        self.assert_io_fault(True)

    def test_playback_fault_reaches_foreground_status_gate(self):
        self.assert_io_fault(False)

    def test_fault_evidence_stays_bounded(self):
        device=self.device(read_returns=[-32]*20)
        for at in range(20):
            device.frames=at
            with self.assertRaisesRegex(RuntimeError,'^pcm_xrun_requires_reopen$'):
                device._transfer(None,b'',FRAME,True)
        self.assertEqual(device.xruns,20)
        self.assertEqual(len(device.xrun_events),16)
        self.assertEqual([event['frame'] for event in device.xrun_events],list(range(16)))
        self.assertEqual(device.audio.recovery_calls,[])

    def test_healthy_partial_capture_and_playback_remain_exact(self):
        device=self.device(read_returns=[240,400],write_returns=[240,400])
        captured=device._transfer(None,b'',FRAME,True)
        self.assertEqual(captured,b'\x34\x12'*FRAME)
        pcm=b'\x01\x00'*240+b'\x02\x00'*400
        self.assertEqual(device._transfer(None,pcm,FRAME,False),FRAME)
        self.assertEqual(b''.join(device.audio.written),pcm)
        self.assertEqual(device.audio.read_requests,[640,400])
        self.assertEqual(device.audio.write_requests,[640,400])
        self.assertEqual(device.xruns,0)
        self.assertTrue(device.capabilities().aec_verified)

    def test_healthy_duplex_period_delivers_both_clean_frames(self):
        device=self.device();delivered=[]
        def receive(frame):
            delivered.append(frame)
            if len(delivered)==2:device.stop.set()
        device.on_frame=receive
        device._io()
        self.assertEqual(len(delivered),2)
        self.assertTrue(all(frame.aec_clean for frame in delivered))
        self.assertEqual(b''.join(frame.pcm16 for frame in delivered),b'\x34\x12'*FRAME)
        self.assertIsNone(device.last_error)
        self.assertEqual(device.xruns,0)


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(XrunContracts))
    print(json.dumps({'status':'PASS_HOST_XRUN_CONTRACTS' if result.wasSuccessful() else 'FAIL',
                      'test_count':result.testsRun,'fake_alsa':True,'phone_audio_tested':False,
                      'real_supervisor_restart_tested':False},sort_keys=True))
    raise SystemExit(0 if result.wasSuccessful() else 1)
