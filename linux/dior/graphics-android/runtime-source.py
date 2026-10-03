"""Read original ARM32 GPU library dependencies without executing Android code."""
from pathlib import Path
import struct

DYNAMIC_ROOTS = ('libOpenCL.so', 'libEGL_adreno.so', 'libGLESv2_adreno.so',
                 'eglsubAndroid.so', 'libsc-a3xx.so', 'gralloc.msm8226.so')


def elf_metadata(path):
    with Path(path).open('rb') as stream:
        raw = stream.read(52)
        if raw[:6] != b'\x7fELF\x01\x01':
            raise ValueError('Original GPU runtime requires little-endian ELF32')
        header = struct.unpack('<16sHHIIIIIHHHHHH', raw)
        if header[2] != 40 or header[9] != 32 or not 1 <= header[10] <= 1000:
            raise ValueError('Original GPU runtime requires valid ARM program headers')
        stream.seek(header[5])
        segments = [struct.unpack('<IIIIIIII', stream.read(32)) for _ in range(header[10])]
        entries = []
        for segment in segments:
            if segment[0] != 2:
                continue
            if segment[4] > 1024*1024:
                raise ValueError('ELF dynamic table too large')
            stream.seek(segment[1])
            for _ in range(segment[4]//8):
                tag, value = struct.unpack('<II', stream.read(8))
                if not tag:
                    break
                entries.append((tag, value))
        tags = dict(entries)
        if tags.get(10, 0) > 2*1024*1024:
            raise ValueError('ELF string table too large')
        strings = b''
        for segment in segments:
            if segment[0] == 1 and segment[2] <= tags.get(5, 0) < segment[2]+segment[4]:
                stream.seek(segment[1]+tags[5]-segment[2])
                strings = stream.read(tags.get(10, 0))
                break
        dependencies = []
        for tag, value in entries:
            if tag == 1:
                if value >= len(strings):
                    raise ValueError('ELF dependency outside string table')
                name = strings[value:].split(b'\0', 1)[0].decode('ascii')
                if '/' in name or '..' in name or not name.endswith('.so'):
                    raise ValueError('Unsupported original dependency name')
                dependencies.append(name)
        return {'machine': header[2], 'needed': dependencies}


def original_libraries(root):
    root = Path(root).resolve()
    search = [root/path for path in ('vendor/lib', 'lib', 'vendor/lib/egl',
                                    'lib/egl', 'vendor/lib/hw', 'lib/hw')]
    queue, results = list(DYNAMIC_ROOTS), {}
    while queue:
        name = queue.pop(0)
        if name in results:
            continue
        path = next((directory/name for directory in search if (directory/name).is_file()), None)
        if path is None:
            raise ValueError('Missing this phone original GPU dependency: '+name)
        path = path.resolve()
        if not path.is_relative_to(root):
            raise ValueError('Original library escaped read-only source mount')
        info = elf_metadata(path)
        results[name] = {**info, 'path': str(path.relative_to(root))}
        queue.extend(info['needed'])
    return results
