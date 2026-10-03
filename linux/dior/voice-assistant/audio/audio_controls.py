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
            "pcm_sw_params_malloc": (I, [PP]), "pcm_sw_params_free": (None, [P]),
            "pcm_sw_params_current": (I, [P, P]),
            "pcm_sw_params_get_boundary": (I, [P, C.POINTER(C.c_ulong)]),
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

    def pcm_boundary(self, handle):
        """Read this PCM's negotiated ring boundary, freeing the temporary container."""
        params = C.c_void_p()
        self.check(self.pcm_sw_params_malloc(C.byref(params)), "allocate PCM software params")
        try:
            self.check(self.pcm_sw_params_current(handle, params), "read PCM software params")
            boundary = C.c_ulong()
            self.check(self.pcm_sw_params_get_boundary(params, C.byref(boundary)), "read PCM boundary")
            if not boundary.value:
                raise RuntimeError("invalid PCM boundary")
            return boundary.value
        finally:
            self.pcm_sw_params_free(params)

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
