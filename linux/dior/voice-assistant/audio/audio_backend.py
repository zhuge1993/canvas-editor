"""Trusted Dior factory; acoustic qualification is tied to this kernel preset."""
import json
import os
from pathlib import Path
import stat
from dior_audio import DiorAudio

def create_device():
    file=Path(__file__).with_name('audio-profile.json')
    info=file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>8192:
        raise RuntimeError('untrusted_audio_profile')
    profile=json.loads(file.read_text(encoding='utf8'))
    qualified=(profile.get('acoustic_echo_test')=='PASS' and
        profile.get('device_rate')==16000 and profile.get('period_frames')==640 and
        profile.get('buffer_frames')==2560 and profile.get('reference_delay_samples')==1920 and
        profile.get('echo_filter_samples')==2560 and profile.get('kernel_release')==os.uname().release and
        profile.get('kernel_version')==os.uname().version)
    return DiorAudio(volume=50,aec_verified=qualified,bootstrap=qualified)
