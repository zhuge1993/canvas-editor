"""Bounded span wrapper around the separately qualified keyword IPC provider."""
import collections
import time
from interfaces import WakeDetection
class KeywordWakeDetector:
    def __init__(self,backend):self.backend=backend
    def validate_keyword(self,name):return self.backend.validate_keyword(name)
    def set_keyword(self,name):self.backend.set_keyword(name)
    def close(self):self.backend.close()
    def status(self):return self.backend.status()
    def detect(self,span):
        self.backend.reset();history=collections.deque(maxlen=50)
        try:
            while not span.cancel.is_set() and time.monotonic()-span.created<8:
                raw,done=span.take()
                for offset in range(0,len(raw),640):
                    frame=raw[offset:offset+640]
                    if len(frame)!=640:raise ValueError('keyword_frame_size')
                    history.append(frame);result=self.backend.feed(frame)
                    keyword=result.get('keyword')
                    if keyword:
                        # This is a bounded replay, not a claimed exact word
                        # boundary. Token timestamps indicate onset only.
                        trailing=raw[offset+640:]
                        replay=(b''.join(history)+trailing)[-32000:]
                        return WakeDetection(keyword,replay)
                if done:return None
            return None
        finally:self.backend.reset()
