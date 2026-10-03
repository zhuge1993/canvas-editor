#!/usr/bin/env python3
"""Finite ALSA pointer-ring contracts; fake PCM periods, no phone audio opened."""
import ctypes
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode=True
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'runtime'))
from audio_controls import Alsa
from dior_audio import DiorAudio, Playback


class FakeSoftwareParams:
    def __init__(self,boundary=10240,current_result=0,boundary_result=0):
        self.boundary=boundary;self.current_result=current_result
        self.boundary_result=boundary_result;self.calls=[]
    def check(self,result,label):
        if result<0:raise RuntimeError(label)
    def pcm_sw_params_malloc(self,pointer):
        self.calls.append('malloc')
        ctypes.cast(pointer,ctypes.POINTER(ctypes.c_void_p))[0]=ctypes.c_void_p(17)
        return 0
    def pcm_sw_params_current(self,handle,params):
        self.calls.append('current');return self.current_result
    def pcm_sw_params_get_boundary(self,params,pointer):
        self.calls.append('boundary')
        ctypes.cast(pointer,ctypes.POINTER(ctypes.c_ulong))[0]=self.boundary
        return self.boundary_result
    def pcm_sw_params_free(self,params):
        self.calls.append('free');assert params.value==17


class PointerContracts(unittest.TestCase):
    def device(self,boundary=10240):
        device=DiorAudio(aec_verified=True);device.playback_boundary=boundary
        return device

    def test_before_equal_and_after_without_rollover(self):
        device=self.device()
        self.assertFalse(device._drained(1900,2000))
        self.assertTrue(device._drained(2000,2000))
        self.assertTrue(device._drained(2100,2000))

    def test_rollover_distinguishes_waiting_and_passed_targets(self):
        device=self.device()
        self.assertFalse(device._drained(10200,10220))
        self.assertTrue(device._drained(10220,10220))
        self.assertTrue(device._drained(40,10220))
        self.assertFalse(device._drained(10200,40))
        self.assertTrue(device._drained(40,40))
        self.assertTrue(device._drained(60,40))

    def test_comparison_uses_each_actual_boundary(self):
        for boundary in (10240,20480,1342177280):
            device=self.device(boundary)
            self.assertFalse(device._drained(boundary-120,boundary-100))
            self.assertTrue(device._drained(20,boundary-100))
            self.assertFalse(device._drained(boundary-100,20))
            self.assertFalse(device._drained(boundary//2,0))

    def test_out_of_range_or_missing_pointer_fails_closed(self):
        device=self.device()
        for value in (-1,10240,10241,True,None):
            with self.subTest(value=value):
                with self.assertRaisesRegex(RuntimeError,'invalid_playback_hardware_pointer'):
                    device._drained(value,100)
                with self.assertRaisesRegex(RuntimeError,'invalid_playback_hardware_pointer'):
                    device._drained(100,value)
        with patch.object(Path,'read_text',return_value='hw_ptr : 20\nappl_ptr : 30\n'):
            self.assertEqual(device._pointers(),{'hw_ptr':20,'appl_ptr':30})
        for status in ('hw_ptr : 20\n','hw_ptr : -1\nappl_ptr : 30\n',
                       'hw_ptr : 10240\nappl_ptr : 30\n'):
            with patch.object(Path,'read_text',return_value=status):
                with self.assertRaises(RuntimeError):device._pointers()

    def test_negotiated_boundary_container_is_always_freed(self):
        for boundary in (10240,1342177280):
            api=FakeSoftwareParams(boundary)
            self.assertEqual(Alsa.pcm_boundary(api,None),boundary)
            self.assertEqual(api.calls,['malloc','current','boundary','free'])
        for options in ({'current_result':-1},{'boundary_result':-1},{'boundary':0}):
            api=FakeSoftwareParams(**options)
            with self.assertRaises(RuntimeError):Alsa.pcm_boundary(api,None)
            self.assertEqual(api.calls[-1],'free')

    def assert_period_drain(self,cancelled):
        device=self.device();device._started=True
        device.echo=type('Echo',(),{'process':staticmethod(lambda near,far:(near,near))})()
        device._transfer=lambda handle,payload,frames,reading:bytes(frames*2) if reading else frames
        snapshots=iter(({'hw_ptr':10200,'appl_ptr':10220},
                        {'hw_ptr':40,'appl_ptr':680}))
        device._pointers=lambda:next(snapshots)
        callbacks=[];frames=[]
        clip=Playback(b'\x01\x00'*640,42,lambda generation,ok:callbacks.append((generation,ok,len(frames))))
        device._notify=lambda item,ok:item.on_done(item.generation,ok) if item else None
        if cancelled:
            device.cancel_drain_target=10220;device.notifications.append(clip)
        else:device.pending=(clip,10220)
        def receive(frame):
            frames.append(frame)
            if len(frames)==4:device.stop.set()
        device.on_frame=receive
        device._io()
        self.assertEqual(callbacks,[(42,not cancelled,2)])
        self.assertIsNone(device.cancel_drain_target)
        self.assertIsNone(device.pending)
        self.assertIsNone(device.last_error)

    def test_normal_completion_waits_then_drains_across_rollover(self):
        self.assert_period_drain(False)

    def test_cancellation_waits_then_reports_discard_across_rollover(self):
        self.assert_period_drain(True)


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(PointerContracts))
    print(json.dumps({'status':'PASS_HOST_POINTER_CONTRACTS' if result.wasSuccessful() else 'FAIL',
                      'test_count':result.testsRun,'fake_pcm_periods':True,'phone_audio_tested':False,
                      'actual_24_hour_soak_tested':False},sort_keys=True))
    raise SystemExit(0 if result.wasSuccessful() else 1)
