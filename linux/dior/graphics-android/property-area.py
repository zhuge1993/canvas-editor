#!/usr/bin/env python3
"""Build a private KitKat property area for the original GPU libraries.

Layout reference: AOSP android-4.4.4_r2 libc/bionic/system_properties.c.
Only non-secret platform identity is included; this is not a property service.
"""
import os
from pathlib import Path
import struct

PROPERTIES = {
    'ro.hardware': 'qcom',
    'ro.board.platform': 'msm8226',
    'ro.product.board': 'MSM8226',
    'ro.product.device': 'dior',
    'ro.build.version.sdk': '19',
    'ro.build.version.release': '4.4.4',
}


def encode(properties):
    data = bytearray(128*1024)
    used = 20
    nodes = {}

    def allocate(size):
        nonlocal used
        size = (size+3) & ~3
        if used+size > len(data)-128:
            raise ValueError('KitKat property area full')
        offset = used
        used += size
        return offset

    def store_node(token):
        name = token.encode('ascii')
        offset = allocate(20+len(name)+1)
        data[128+offset] = len(name)
        data[128+offset+20:128+offset+20+len(name)] = name
        return offset

    def attach(parent, token):
        key = (parent, token)
        if key in nodes:
            return nodes[key]
        parent_position = 128+parent
        current = struct.unpack_from('<I', data, parent_position+16)[0]
        if current == 0:
            created = store_node(token)
            struct.pack_into('<I', data, parent_position+16, created)
        else:
            while True:
                position = 128+current
                length = data[position]
                current_name = data[position+20:position+20+length].decode('ascii')
                link = 8 if (len(token), token) < (length, current_name) else 12
                following = struct.unpack_from('<I', data, position+link)[0]
                if following:
                    current = following
                    continue
                created = store_node(token)
                struct.pack_into('<I', data, position+link, created)
                break
        nodes[key] = created
        return created

    for name, value in sorted(properties.items()):
        if len(name.encode('ascii')) > 31 or len(value.encode('ascii')) > 91:
            raise ValueError('KitKat property name/value too long')
        parent = 0
        for token in name.split('.'):
            if not token:
                raise ValueError('Empty property token')
            parent = attach(parent, token)
        value_bytes, name_bytes = value.encode('ascii'), name.encode('ascii')
        info = allocate(96+len(name_bytes)+1)
        struct.pack_into('<I', data, 128+info, len(value_bytes)<<24)
        data[128+info+4:128+info+4+len(value_bytes)] = value_bytes
        data[128+info+96:128+info+96+len(name_bytes)] = name_bytes
        struct.pack_into('<I', data, 128+parent+4, info)
    struct.pack_into('<IIII', data, 0, used, 0, 0x504f5250, 0xfc6ed0ab)
    return bytes(data)


if __name__ == '__main__':
    if os.geteuid() != 0:
        raise RuntimeError('Private property provisioning requires root')
    target = Path('/opt/dior-android/properties-area')
    temporary = target.with_name('properties-area.new')
    descriptor = os.open(str(temporary), os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o444)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(encode(PROPERTIES))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, target)
    print('Provisioned private KitKat platform properties')
