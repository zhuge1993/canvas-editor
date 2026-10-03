"""Bounded audio/provider interfaces. No device is opened by importing this file."""
from dataclasses import dataclass
from typing import Callable, Optional, Protocol
import threading

@dataclass(frozen=True)
class AudioFrame:
    pcm16: bytes
    aec_clean: bool
    at_monotonic: float
    reference_active: bool = False

    def __post_init__(self):
        if not isinstance(self.pcm16,bytes) or len(self.pcm16)!=640:
            raise ValueError('AudioFrame must contain exactly20ms PCM16LE mono16k (640 bytes)')

@dataclass(frozen=True)
class AudioCapabilities:
    microphone_available: bool = False
    speaker_available: bool = False
    simultaneous_capture_playback: bool = False
    aec_available: bool = False
    aec_verified: bool = False

@dataclass(frozen=True)
class AudioClip:
    pcm16: bytes
    sample_rate: int

    def __post_init__(self):
        if self.sample_rate not in (8000,16000,22050,24000,44100,48000):
            raise ValueError('Unsupported bounded output sample rate')
        if not self.pcm16 or len(self.pcm16)%2 or len(self.pcm16)>self.sample_rate*2*20:
            raise ValueError('Output must be PCM16 mono, at most20seconds')

class AudioDevice(Protocol):
    def start(self,on_frame:Callable[[AudioFrame],None])->None: ...
    def capabilities(self)->AudioCapabilities: ...
    def play(self,pcm16:bytes,rate:int,*,generation:int,
             on_done:Callable[[int,bool],None])->None: ...
    def interrupt(self)->None: ...
    def set_volume(self,percent:int)->None: ...
    def close(self)->None: ...

class TextToSpeech(Protocol):
    def synthesize(self,text:str,cancel:threading.Event)->AudioClip: ...

@dataclass(frozen=True)
class TypedIntent:
    kind: str
    value: Optional[str] = None

@dataclass(frozen=True)
class LanguageReply:
    text: str
    intent: Optional[TypedIntent] = None

class LanguageModel(Protocol):
    def generate(self,user_text:str,*,cancel:threading.Event,
                 deadline:float,web_evidence:Optional[dict]=None)->LanguageReply: ...

@dataclass(frozen=True)
class WakeDetection:
    keyword:str
    remaining_pcm16:bytes=b''
    def __post_init__(self):
        if not isinstance(self.keyword,str) or not isinstance(self.remaining_pcm16,bytes) or len(self.remaining_pcm16)>64000 or len(self.remaining_pcm16)%640:
            raise ValueError('bounded_wake_detection')

class WakeDetector(Protocol):
    def detect(self,span)->Optional[WakeDetection]: ...
    def validate_keyword(self,name:str)->str: ...
    def set_keyword(self,name:str)->None: ...
    def close(self)->None: ...
