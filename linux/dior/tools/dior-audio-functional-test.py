#!/usr/bin/env python3
"""Dior H3-LTE speaker/microphone test with strict preflight and mixer rollback.

Default --mode inspect reads metadata only. Speaker mode emits a 1.2 s,
440 Hz tone; microphone mode samples one second and retains statistics only.
No firmware, device tree, persistent ALSA profile or kernel files are changed.
"""
import argparse
import array
import ctypes as C
import json
import math
from pathlib import Path
import re
import time

KERNEL = "12f40d54ab4e34dabaeb8dd7979bedc3cc8fa064"
MIXER_REFERENCE = ("https://github.com/KaguraRinko/android_device_xiaomi_dior/blob/"
                   "25d14759cd7b49261c678567f5977a0792afdefe/configs/mixer_paths.xml")
# Original factual routing map follows the locked H3-LTE DTS / wcd9306.c.
COMMON = [("SPK DRV Volume", 2, 4, (0, 8)),
          ("SLIM RX1 MUX", 3, "AIF1_PB", None),
          ("SLIM_0_RX Channels", 3, "One", None),
          ("SLIM_0_RX Format", 3, "S16_LE", None),
          ("SLIM_0_RX SampleRate", 3, "KHZ_48", None)]
FULL = [("RX4 Digital Volume", 2, 76, (0, 124)),
        ("RX4 MIX1 INP1", 3, "RX1", None),
        ("COMP0 Switch", 1, 1, (0, 1))]
LITE = [("RX3 Digital Volume", 2, 76, (0, 124)),
        ("RX3 MIX1 INP1", 3, "RX1", None)]
SPEAKER_END = [("SPK DAC Switch", 1, 1, (0, 1)),
               ("SLIMBUS_0_RX Audio Mixer MultiMedia1", 1, 1, (0, 1))]
MIC = [("ADC1 Volume", 2, 8, (0, 19)),
       ("DEC1 Volume", 2, 84, (0, 124)),
       ("SLIM_0_TX Channels", 3, "One", None),
       ("DEC1 MUX", 3, "ADC1", None),
       ("SLIM TX1 MUX", 3, "DEC1", None),
       ("AIF1_CAP Mixer SLIM TX1", 1, 1, (0, 1)),
       ("MultiMedia1 Mixer SLIM_0_TX", 1, 1, (0, 1))]


class Alsa:
    def __init__(self):
        self.lib = C.CDLL("libasound.so.2")
        self.allocations = []
        self.ctl = C.c_void_p()
        P, PP, I, U, L, S = C.c_void_p, C.POINTER(C.c_void_p), C.c_int, C.c_uint, C.c_long, C.c_char_p
        specs = {
            "strerror": (S, [I]), "ctl_open": (I, [PP, S, I]), "ctl_close": (I, [P]),
            "ctl_elem_list": (I, [P, P]), "ctl_elem_list_alloc_space": (I, [P, U]),
            "ctl_elem_list_free_space": (None, [P]), "ctl_elem_list_get_count": (U, [P]),
            "ctl_elem_list_get_used": (U, [P]), "ctl_elem_list_get_id": (None, [P, U, P]),
            "ctl_elem_id_get_name": (S, [P]), "ctl_elem_id_get_interface": (I, [P]),
            "ctl_elem_id_get_numid": (U, [P]), "ctl_elem_info_set_id": (None, [P, P]),
            "ctl_elem_value_set_id": (None, [P, P]), "ctl_elem_info": (I, [P, P]),
            "ctl_elem_info_get_type": (I, [P]), "ctl_elem_info_get_count": (U, [P]),
            "ctl_elem_info_is_readable": (I, [P]), "ctl_elem_info_is_writable": (I, [P]),
            "ctl_elem_info_get_min": (L, [P]), "ctl_elem_info_get_max": (L, [P]),
            "ctl_elem_info_get_items": (U, [P]), "ctl_elem_info_set_item": (None, [P, U]),
            "ctl_elem_info_get_item_name": (S, [P]), "ctl_elem_read": (I, [P, P]),
            "ctl_elem_write": (I, [P, P]), "pcm_open": (I, [PP, S, I, I]),
            "pcm_close": (I, [P]), "pcm_drop": (I, [P]), "pcm_drain": (I, [P]),
            "pcm_state": (I, [P]), "pcm_start": (I, [P]), "pcm_wait": (I, [P, I]), "pcm_prepare": (I, [P]),
            "pcm_set_params": (I, [P, I, I, U, U, I, U]),
            "pcm_get_params": (I, [P, C.POINTER(C.c_ulong), C.POINTER(C.c_ulong)]),
            "pcm_writei": (L, [P, P, C.c_ulong]), "pcm_readi": (L, [P, P, C.c_ulong]),
            "pcm_delay": (I, [P, C.POINTER(L)]),
        }
        for kind in ("ctl_elem_list", "ctl_elem_id", "ctl_elem_info", "ctl_elem_value"):
            specs[kind + "_malloc"] = (I, [PP])
            specs[kind + "_free"] = (None, [P])
        for kind, typ in (("boolean", I), ("integer", L), ("enumerated", U)):
            specs["ctl_elem_value_get_" + kind] = (typ, [P, U])
            specs["ctl_elem_value_set_" + kind] = (None, [P, U, typ])
        # ALSA boolean setters take long, not int.
        specs["ctl_elem_value_set_boolean"] = (None, [P, U, L])
        for name, (restype, args) in specs.items():
            fn = getattr(self.lib, "snd_" + name)
            fn.restype, fn.argtypes = restype, args
            setattr(self, name, fn)
        self.check(self.ctl_open(C.byref(self.ctl), b"hw:0", 0), "open hw:0 control")
        self.elements = self.enumerate()

    def check(self, code, stage):
        if code < 0:
            raise RuntimeError(f"{stage}: {self.strerror(int(code)).decode()} ({code})")
        return code

    def alloc(self, kind):
        pointer = C.c_void_p()
        self.check(getattr(self, kind + "_malloc")(C.byref(pointer)), "allocate " + kind)
        self.allocations.append((kind, pointer))
        return pointer

    def enumerate(self):
        listing = self.alloc("ctl_elem_list")
        self.check(self.ctl_elem_list(self.ctl, listing), "count controls")
        count = self.ctl_elem_list_get_count(listing)
        if not 0 < count <= 4096:
            raise RuntimeError("unexpected control count")
        self.check(self.ctl_elem_list_alloc_space(listing, count), "allocate control list")
        self.check(self.ctl_elem_list(self.ctl, listing), "enumerate controls")
        if self.ctl_elem_list_get_used(listing) != count:
            raise RuntimeError("incomplete/changing control list")
        wanted = {row[0] for row in COMMON + FULL + LITE + SPEAKER_END + MIC}
        found = {}
        for index in range(count):
            identity = self.alloc("ctl_elem_id")
            self.ctl_elem_list_get_id(listing, index, identity)
            name = self.ctl_elem_id_get_name(identity).decode("utf-8", "replace")
            if name not in wanted:
                continue
            if name in found:
                raise RuntimeError("duplicate target control: " + name)
            found[name] = Element(self, identity, name)
        return found

    def close(self):
        for kind, pointer in reversed(self.allocations):
            if kind == "ctl_elem_list":
                self.ctl_elem_list_free_space(pointer)
            getattr(self, kind + "_free")(pointer)
        self.allocations.clear()
        if self.ctl:
            self.ctl_close(self.ctl)
            self.ctl = C.c_void_p()


class Element:
    def __init__(self, a, identity, name):
        self.a, self.identity, self.name = a, identity, name
        self.info, self.value = a.alloc("ctl_elem_info"), a.alloc("ctl_elem_value")
        a.ctl_elem_info_set_id(self.info, identity)
        a.ctl_elem_value_set_id(self.value, identity)
        a.check(a.ctl_elem_info(a.ctl, self.info), "read metadata: " + name)
        self.type, self.count = a.ctl_elem_info_get_type(self.info), a.ctl_elem_info_get_count(self.info)
        self.options = []
        self.minimum = self.maximum = None
        if self.type == 1:
            self.minimum, self.maximum = 0, 1
        elif self.type == 2:
            self.minimum, self.maximum = a.ctl_elem_info_get_min(self.info), a.ctl_elem_info_get_max(self.info)
        elif self.type == 3:
            items = a.ctl_elem_info_get_items(self.info)
            if items > 64:
                raise RuntimeError("unexpected enum size: " + name)
            for item in range(items):
                a.ctl_elem_info_set_item(self.info, item)
                a.check(a.ctl_elem_info(a.ctl, self.info), "read enum: " + name)
                self.options.append(a.ctl_elem_info_get_item_name(self.info).decode())
            self.minimum, self.maximum = 0, items - 1
        self.readable = bool(a.ctl_elem_info_is_readable(self.info))
        self.writable = bool(a.ctl_elem_info_is_writable(self.info))
        self.interface = a.ctl_elem_id_get_interface(identity)
        self.kind = {1: "boolean", 2: "integer", 3: "enumerated"}.get(self.type)

    def read(self):
        if not self.kind or not self.readable or not 0 < self.count <= 16:
            raise RuntimeError("unsupported control layout: " + self.name)
        self.a.check(self.a.ctl_elem_read(self.a.ctl, self.value), "read " + self.name)
        get = getattr(self.a, "ctl_elem_value_get_" + self.kind)
        values = [int(get(self.value, i)) for i in range(self.count)]
        if any(not self.minimum <= value <= self.maximum for value in values):
            raise RuntimeError("out-of-range existing value: " + self.name)
        return values

    def metadata(self):
        return {"numid": self.a.ctl_elem_id_get_numid(self.identity), "type": self.type,
                "count": self.count, "range": [self.minimum, self.maximum],
                "options": self.options, "current": self.read(), "writable": self.writable}

    def write(self, values):
        set_value = getattr(self.a, "ctl_elem_value_set_" + self.kind)
        for index, value in enumerate(values):
            set_value(self.value, index, value)
        self.a.check(self.a.ctl_elem_write(self.a.ctl, self.value), "write " + self.name)
        if self.read() != values:
            raise RuntimeError("control write verification failed: " + self.name)


def preflight(a, profile):
    prepared = []
    for name, expected_type, setting, expected_range in profile:
        if name not in a.elements:
            raise RuntimeError("missing required control: " + name)
        element = a.elements[name]
        if element.interface != 2 or element.type != expected_type or element.count != 1:
            raise RuntimeError("unexpected interface/type/count: " + name)
        if not element.readable or not element.writable:
            raise RuntimeError("control must be readable/writable: " + name)
        if expected_range and (element.minimum, element.maximum) != expected_range:
            raise RuntimeError("range differs from the locked codec source: " + name)
        if expected_type == 3:
            if element.options.count(setting) != 1:
                raise RuntimeError("missing/ambiguous enum option: " + name + "=" + setting)
            setting = element.options.index(setting)
        if not element.minimum <= setting <= element.maximum:
            raise RuntimeError("test setting outside range: " + name)
        prepared.append((element, element.read(), [setting]))
    return prepared


def pcm_test(a, capture):
    pcm = C.c_void_p()
    opened = False
    result = {"stream": "capture" if capture else "playback", "format": "S16_LE", "rate": 48000,
              "channels": 1 if capture else 2, "duration_seconds": 1.0 if capture else 1.2}
    channels = result["channels"]
    frames = int(result["duration_seconds"] * 48000)
    try:
        a.check(a.pcm_open(C.byref(pcm), b"hw:0,0", int(capture), 1), "PCM open")
        opened = True
        a.check(a.pcm_set_params(pcm, 2, 3, channels, 48000, 0, 100000), "PCM S16_LE/48k hardware parameters")
        buffer_size, period_size = C.c_ulong(), C.c_ulong()
        a.check(a.pcm_get_params(pcm, C.byref(buffer_size), C.byref(period_size)), "PCM effective buffer/period")
        result.update(buffer_frames=buffer_size.value, period_frames=period_size.value)
        samples = [] if capture else array.array("h")
        if not capture:
            for frame in range(frames):
                ramp = min(1.0, frame / 480.0, (frames - 1 - frame) / 480.0)
                sample = int(32767 * 0.08 * ramp * math.sin(2 * math.pi * 440 * frame / 48000))
                samples.extend([sample] * channels)
            if __import__("sys").byteorder != "little":
                samples.byteswap()
            payload = C.create_string_buffer(samples.tobytes())
            result.update(tone_hz=440, pcm_peak_fraction=0.08, digital_gain_control=76)
        if capture:
            a.check(a.pcm_start(pcm), "start capture explicitly")
        completed, waits = 0, 0
        deadline = time.monotonic() + 8.0
        snapshots = []
        while completed < frames:
            if time.monotonic() >= deadline:
                raise RuntimeError("PCM transfer exceeded its deadline")
            block = min(2048, frames - completed)
            if capture:
                chunk = (C.c_int16 * block)()
                done = int(a.pcm_readi(pcm, chunk, block))
            else:
                pointer = C.cast(C.byref(payload, completed * channels * 2), C.c_void_p)
                done = int(a.pcm_writei(pcm, pointer, block))
            if done == -11 or done == 0:
                a.check(a.pcm_wait(pcm, 100), "wait for PCM readiness")
                waits += 1
                continue
            a.check(done, "PCM readi" if capture else "PCM writei")
            if done > block:
                raise RuntimeError("driver transferred more frames than requested")
            if capture:
                samples.extend(chunk[:done])
            completed += done
            status_path = Path("/proc/asound/card0/pcm0" + ("c" if capture else "p") + "/sub0/status")
            if len(snapshots) < 12:
                try:
                    text = status_path.read_text()
                    snapshots.append({key: int(value) for key, value in
                                      re.findall(r"(hw_ptr|appl_ptr)\s*:\s*(\d+)", text)})
                except OSError:
                    pass
        result.update(frames_transferred=completed, waits=waits, pointer_samples=snapshots)
        if capture:
            a.check(a.pcm_drop(pcm), "stop capture")
            mean = sum(samples) / len(samples)
            rms = math.sqrt(sum((x - mean) ** 2 for x in samples) / len(samples))
            result.update(peak=max(abs(x) for x in samples), rms_ac=rms, mean=mean,
                          nonzero_samples=sum(x != 0 for x in samples), captured_audio_saved=False)
            result["signal_present"] = rms > 2.0
        else:
            delay = C.c_long()
            code = a.pcm_delay(pcm, C.byref(delay))
            result["queued_frames_after_write"] = delay.value if code >= 0 else None
            while True:
                code = int(a.pcm_drain(pcm))
                if code != -11:
                    a.check(code, "DSP playback drain")
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("playback drain exceeded its deadline")
                wait_code = int(a.pcm_wait(pcm, 100))
                # Drain can complete after EAGAIN and before ALSA poll.
                if wait_code == -5 and int(a.pcm_state(pcm)) == 1:
                    state_text = Path("/proc/asound/card0/pcm0p/sub0/status").read_text()
                    values = dict(re.findall(r"(hw_ptr|appl_ptr|delay)\s*:\s*(\d+)", state_text))
                    if values.get("delay") == "0" and values.get("hw_ptr") == values.get("appl_ptr"):
                        result["drain_poll_completion_race"] = True
                        break
                a.check(wait_code, "wait for playback drain")
                time.sleep(0.01)
            result.update(drain_completed=True, audible_confirmed=False)
        result["status"] = "pcm-transfer-pass"
        return result
    except Exception as error:
        result.update(status="error", error=str(error),
                      frames_transferred=locals().get("completed", 0),
                      waits=locals().get("waits", 0),
                      pointer_samples=locals().get("snapshots", []))
        status_path = Path("/proc/asound/card0/pcm0" + ("c" if capture else "p") + "/sub0/status")
        try:
            result["kernel_pcm_status"] = status_path.read_text()
        except OSError:
            pass
        return result
    finally:
        if opened:
            a.pcm_drop(pcm)
            a.check(a.pcm_close(pcm), "close PCM")


def execute_profile(a, profile, capture):
    prepared = preflight(a, profile)  # All controls validated before the first write.
    changed = []
    report = {"status": "error", "controls": [entry[0].name for entry in prepared]}
    try:
        for element, original, desired in prepared:
            if original != desired:
                changed.append((element, original))  # A failed write may already have changed state.
                element.write(desired)
        report["pcm"] = pcm_test(a, capture)
        report["status"] = report["pcm"]["status"]
    except Exception as error:
        report["error"] = str(error)
    finally:
        restoration_errors = []
        for element, original in reversed(changed):
            try:
                element.write(original)
            except Exception as error:
                restoration_errors.append(str(error))
        for element, original, _ in prepared:
            try:
                if element.read() != original:
                    restoration_errors.append("final state mismatch: " + element.name)
            except Exception as error:
                restoration_errors.append(str(error))
        report["all_controls_restored"] = not restoration_errors
        if restoration_errors:
            report["status"] = "mixer-restore-error"
            report["restore_errors"] = restoration_errors
    return report


def run(mode):
    report = {"mode": mode, "kernel_source_commit": KERNEL, "dior_mixer_reference": MIXER_REFERENCE,
              "persistent_profile_written": False, "hardware_audio_fully_confirmed": False}
    a = None
    try:
        model = None
        for name in ("/proc/device-tree/model", "/sys/firmware/devicetree/base/model"):
            if Path(name).is_file():
                model = Path(name).read_bytes().rstrip(b"\0").decode()
                break
        if model is not None and model != "Qualcomm MSM 8926 H3-LTE":
            raise RuntimeError("unexpected device-tree model: " + model)
        # The locked config disables PROC_DEVICETREE. The verified bootloader
        # serial remains available through the preserved android_usb gadget.
        serial = Path("/sys/class/android_usb/android0/iSerial").read_text().strip()
        if serial != "1f1fb247":
            raise RuntimeError("unexpected device serial: " + serial)
        cards = Path("/proc/asound/cards").read_text()
        if "msm8226" not in cards or "tapan" not in cards:
            raise RuntimeError("expected msm8226-tapan sound card")
        report.update(model=model, target_serial=serial)
        a = Alsa()
        report["metadata"] = {name: elem.metadata() for name, elem in a.elements.items()}
        full = "RX4 MIX1 INP1" in a.elements and "RX4 Digital Volume" in a.elements
        speaker = COMMON + (FULL if full else LITE) + SPEAKER_END
        report["speaker_codec_path"] = "Tapan RX4" if full else "Tapan-lite RX3"
        if mode == "inspect":
            report["status"] = "metadata-only-no-writes"
            report["missing_speaker_controls"] = [row[0] for row in speaker if row[0] not in a.elements]
            report["missing_microphone_controls"] = [row[0] for row in MIC if row[0] not in a.elements]
        else:
            # A combined run is also preflighted as a whole before any mutation.
            if mode in ("speaker", "both"):
                preflight(a, speaker)
            if mode in ("microphone", "both"):
                preflight(a, MIC)
            if mode in ("speaker", "both"):
                report["speaker"] = execute_profile(a, speaker, False)
            if mode in ("microphone", "both"):
                if report.get("speaker", {}).get("all_controls_restored", True):
                    report["microphone"] = execute_profile(a, MIC, True)
            outcomes = [report[key] for key in ("speaker", "microphone") if key in report]
            report["status"] = "data-transfer-tests-completed" if all(
                item["status"] == "pcm-transfer-pass" for item in outcomes) else "audio-test-incomplete"
    except Exception as error:
        report["status"], report["error"] = "error", str(error)
    finally:
        if a is not None:
            a.close()
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("inspect", "speaker", "microphone", "both"), default="inspect")
    print(json.dumps(run(parser.parse_args().mode), indent=2))
