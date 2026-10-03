"""Bounded ASR span contracts; no device, capture RPC or ASR model needed."""
import struct
import threading
import unittest
from types import SimpleNamespace
from asr_stream import Span

def pcm(index):return struct.pack('<h',index)*320
def frame(index):return SimpleNamespace(pcm16=pcm(index),at_monotonic=index*.02)

class SpanBufferContracts(unittest.TestCase):
    def test_full_replay_and_two_handshakes_preserve_four_seconds_of_fresh_audio(self):
        # Capture continues during a two-second lease ACK followed by a
        # two-second ASR ready wait. Deterministic frame timestamps simulate
        # both handshakes without sleeping or invoking a capture-side RPC.
        replay=[pcm(i) for i in range(50)]
        span=Span(0,'kws_dialog',1,replay,15)
        for index in range(50,150):self.assertTrue(span.push(frame(index),True))
        self.assertEqual(len(span.frames),150) # lease ACK has now arrived
        for index in range(150,250):self.assertTrue(span.push(frame(index),True))
        self.assertEqual(len(span.frames),Span.MAX_FRAMES)
        self.assertEqual(sum(len(raw) for raw in span.frames),160000)
        self.assertEqual(span.samples,250*320)
        self.assertFalse(span.cancel.is_set());self.assertFalse(span.overflow)
        span.finish();chunks=[];done=False
        while not done:
            raw,done=span.take(timeout=0)
            self.assertLessEqual(len(raw),6400);chunks.append(raw)
        self.assertEqual(b''.join(chunks),b''.join(pcm(i) for i in range(250)))
    def test_real_overflow_cancels_without_silent_trim_or_extra_audio(self):
        span=Span(0,'dialog',1,[pcm(i) for i in range(50)],15)
        for index in range(50,250):self.assertTrue(span.push(frame(index),True))
        before=list(span.frames);samples=span.samples
        self.assertFalse(span.push(frame(250),True))
        self.assertTrue(span.overflow);self.assertTrue(span.cancel.is_set())
        self.assertEqual(list(span.frames),before);self.assertEqual(span.samples,samples)
        self.assertFalse(span.push(frame(251),True))
    def test_preroll_excess_and_invalid_pcm_fail_closed(self):
        with self.assertRaisesRegex(ValueError,'span_preroll_limit'):
            Span(0,'dialog',1,(pcm(i) for i in range(51)),15)
        for invalid in (bytes(638),bytes(642),bytearray(640),'invalid'):
            with self.assertRaisesRegex(ValueError,'span_pcm_frame'):Span(0,'dialog',1,[invalid],15)
            span=Span(0,'dialog',1,[pcm(0)],15)
            self.assertFalse(span.push(SimpleNamespace(pcm16=invalid,at_monotonic=1),True))
            self.assertTrue(span.cancel.is_set());self.assertTrue(span.closed)
            self.assertEqual(list(span.frames),[pcm(0)])
    def test_total_audio_budget_remains_independent_of_buffer_capacity(self):
        span=Span(0,'wake',1,[pcm(i) for i in range(50)],4)
        for index in range(50,200):self.assertTrue(span.push(frame(index),True))
        self.assertFalse(span.push(frame(200),True))
        self.assertTrue(span.closed);self.assertFalse(span.overflow)
        self.assertEqual(span.samples,4*16000);self.assertEqual(len(span.frames),200)
        with self.assertRaisesRegex(ValueError,'span_audio_budget'):Span(0,'wake',1,[pcm(i) for i in range(50)],.5)
    def test_cancel_wakes_waiting_consumer_and_rejects_further_capture(self):
        span=Span(0,'dialog',1,[],15);result=[];entered=threading.Event()
        def wait_for_frames():entered.set();result.append(span.take(timeout=5))
        consumer=threading.Thread(target=wait_for_frames)
        consumer.start();self.assertTrue(entered.wait(1));span.abort();consumer.join(1)
        self.assertFalse(consumer.is_alive());self.assertEqual(result,[(b'',True)])
        self.assertFalse(span.push(frame(1),True));self.assertEqual(span.samples,0)

if __name__=='__main__':unittest.main(verbosity=2)
