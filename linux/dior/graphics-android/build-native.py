#!/usr/bin/env python3
"""Build public Android API19 ARM32 GPU probes with pinned NDK r17c/GCC4.9.

This builder never copies proprietary libraries or deploys to a phone. The
manifest describes build checks only; physical GPU validation is separate.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys

HERE = Path(__file__).resolve().parent
INTERPRETER = '/opt/dior-android/system/bin/linker'
NDK_VERSION = {'major': 17, 'minor': 2, 'build': 4988734, 'beta': 0}
NDK_ARCHIVES = {
    'windows-x86_64': {
        'name': 'android-ndk-r17c-windows-x86_64.zip',
        'bytes': 650626501,
        'sha1': '3e3b8d1650f9d297d130be2b342db956003f5992',
    },
    'linux-x86_64': {
        'name': 'android-ndk-r17c-linux-x86_64.zip',
        'bytes': 709387703,
        'sha1': '12cacc70c3fd2f40574015631c00f41fb8a39048',
    },
}


def digest(path, algorithm='sha256'):
    value = hashlib.new(algorithm)
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def run(arguments):
    result = subprocess.run([str(value) for value in arguments], check=False,
                            text=True, encoding='utf-8', errors='replace',
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise RuntimeError('Command failed: ' + str(arguments[0]) + '\n' +
                           result.stdout + result.stderr)
    return result.stdout.strip()


def ndk_tools(ndk, archive=None):
    host = ('windows-x86_64' if os.name == 'nt' else
            'linux-x86_64' if sys.platform.startswith('linux') else None)
    if host is None:
        raise RuntimeError('NDK r17c builder supports Windows x64 and Linux x64 hosts')
    version_text = (ndk / 'sysroot/usr/include/android/ndk-version.h').read_text(encoding='utf-8')
    for name, expected in NDK_VERSION.items():
        match = re.search(r'^\s*#\s*define\s+__NDK_' + name.upper() + r'__\s+(\d+)\s*$', version_text, re.M)
        if not match or int(match.group(1)) != expected:
            raise RuntimeError('Expected NDK r17c 17.2.4988734 version header: ' + name)
    tools = ndk / 'toolchains/arm-linux-androideabi-4.9/prebuilt' / host / 'bin'
    suffix = '.exe' if os.name == 'nt' else ''
    compiler = tools / ('arm-linux-androideabi-gcc' + suffix)
    strip = tools / ('arm-linux-androideabi-strip' + suffix)
    for tool in (compiler, strip):
        if not tool.is_file():
            raise RuntimeError('Missing pinned ARM tool: ' + str(tool))
    compiler_version = run([compiler, '--version'])
    short_version = run([compiler, '-dumpversion'])
    if not re.match(r'^4\.9(?:[.x]|$)', short_version):
        raise RuntimeError('Native probes require the NDK r17c GCC 4.9 compiler')
    pin = dict(NDK_ARCHIVES[host])
    pin['url'] = 'https://dl.google.com/android/repository/' + pin['name']
    pin['archive_verified'] = False
    if archive is not None:
        if archive.stat().st_size != pin['bytes'] or digest(archive, 'sha1') != pin['sha1']:
            raise RuntimeError('NDK archive size/SHA1 mismatch for ' + host)
        pin['archive_verified'] = True
    return compiler, strip, host, compiler_version, short_version, pin


def elf_proof(path):
    data = path.read_bytes()
    if len(data) < 52 or data[:7] != b'\x7fELF\x01\x01\x01':
        raise RuntimeError('Expected little-endian ELF32: ' + str(path))
    header = struct.unpack_from('<HHIIIIIHHHHHH', data, 16)
    kind, machine, version, _entry, phoff, _shoff, flags = header[:7]
    ehsize, phsize, phnum = header[7:10]
    if kind != 3 or machine != 40 or version != 1 or ehsize != 52 or phsize != 32 or not phnum:
        raise RuntimeError('Expected ARM EABI5 PIE executable: ' + str(path))
    if flags & 0xFF000000 != 0x05000000 or flags & 0x600 != 0x200:
        raise RuntimeError('Expected ARM EABI5 with soft-float calling ABI')
    if phoff + phnum * phsize > len(data):
        raise RuntimeError('ELF program headers exceed file bounds')
    interpreters = []
    for index in range(phnum):
        ptype, offset, _vaddr, _paddr, filesz, _memsz, _pflags, _align = struct.unpack_from('<IIIIIIII', data, phoff + index * phsize)
        if offset + filesz > len(data):
            raise RuntimeError('ELF segment exceeds file bounds')
        if ptype == 3:
            value = data[offset:offset + filesz]
            if not value or value[-1:] != b'\0' or b'\0' in value[:-1]:
                raise RuntimeError('Invalid ELF interpreter string')
            interpreters.append(value[:-1].decode('ascii'))
    if interpreters != [INTERPRETER]:
        raise RuntimeError('Expected exactly the private Android linker interpreter')
    return {'class': 'ELF32', 'machine': 'ARM', 'type': 'PIE',
            'byte_order': 'little', 'eabi': 5, 'float_calling_abi': 'soft',
            'elf_flags': flags, 'interpreter': interpreters[0]}


def build(ndk, output, archive=None):
    ndk = ndk.resolve(strict=True)
    output = output.resolve()
    if output == ndk or ndk in output.parents or output == HERE or HERE in output.parents or output in HERE.parents:
        raise RuntimeError('Output must be outside the source/NDK directories')
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise RuntimeError('Output requires a new or empty directory')
    compiler, strip, host, full_version, short_version, pin = ndk_tools(ndk, archive)
    platform = ndk / 'platforms/android-19/arch-arm'
    includes = ndk / 'sysroot/usr/include'
    if not (platform / 'usr/lib/libc.so').is_file() or not (includes / 'arm-linux-androideabi').is_dir():
        raise RuntimeError('Expected complete API19 ARM libraries and unified NDK headers')
    sources = [('dior-opencl-probe', HERE / 'dior-opencl-probe.c', []),
               ('dior-gles-probe', HERE / 'dior-gles-probe.c', ['-lm'])]
    for _name, source, _libraries in sources:
        if not source.is_file():
            raise RuntimeError('Missing public probe source: ' + str(source))
    output.mkdir(parents=True, exist_ok=True)
    (output / 'debug').mkdir()
    flags = ['-std=c99', '-O2', '-g', '-Wall', '-Wextra', '-Werror',
             '-D__ANDROID_API__=19', '-march=armv7-a', '-mfloat-abi=softfp', '-mfpu=neon',
             '-fPIE', '-pie', '--sysroot=' + str(platform),
             '-isystem', str(includes), '-isystem', str(includes / 'arm-linux-androideabi'),
             '-fdebug-prefix-map=' + str(HERE) + '=/dior-native/source',
             '-fdebug-prefix-map=' + str(ndk) + '=/android-ndk-r17c',
             '-Wl,--hash-style=sysv', '-Wl,--dynamic-linker,' + INTERPRETER]
    artifacts = []
    for name, source, libraries in sources:
        debug = output / 'debug' / name
        executable = output / name
        source_sha256 = digest(source)
        run([compiler, *flags, source, '-o', debug, '-ldl', *libraries])
        if digest(source) != source_sha256:
            raise RuntimeError('Source changed during compilation: ' + source.name)
        debug_proof = elf_proof(debug)
        # Preserve the debug ELF, then remove only DWARF/debug data from the
        # deployable copy. No proprietary data enters either output artifact.
        shutil.copyfile(debug, executable)
        run([strip, '--strip-debug', executable])
        proof = elf_proof(executable)
        if proof != debug_proof:
            raise RuntimeError('Stripping changed the executable ABI/interpreter')
        if os.name != 'nt':
            executable.chmod(0o755)
            debug.chmod(0o755)
        artifacts.append({'name': name, 'source': source.name, 'source_sha256': source_sha256,
                          'binary': executable.name, 'sha256': digest(executable),
                          'bytes': executable.stat().st_size, 'elf': proof,
                          'debug_binary': 'debug/' + name, 'debug_sha256': digest(debug),
                          'debug_bytes': debug.stat().st_size, 'linked_libraries': ['libdl', *(['libm'] if libraries else [])]})
    public_flags = [value.replace(str(HERE), '<SOURCE>').replace(str(ndk), '<NDK>') for value in flags]
    manifest = {'schema': 1, 'ndk': 'r17c', 'ndk_revision': '17.2.4988734',
                'ndk_version_header_verified': True, 'ndk_archive_pin': pin,
                'host': host, 'compiler_version': full_version, 'compiler_dumpversion': short_version,
                'compiler_sha256': digest(compiler), 'strip_sha256': digest(strip),
                'target': 'armv7-linux-android', 'android_api': 19,
                'float_calling_abi': 'softfp', 'compiler_flags': public_flags,
                'builder_sha256': digest(Path(__file__).resolve()), 'artifacts': artifacts,
                'vendor_libraries_copied': False, 'deployed_to_phone': False,
                'physical_gpu_test': False,
                'physical_gpu_render_verified': False, 'physical_gpu_compute_verified': False}
    manifest_path = output / 'NATIVE-GPU-BUILD.json'
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    files = sorted(path for path in output.rglob('*') if path.is_file())
    (output / 'SHA256SUMS').write_text(''.join(digest(path) + '  ' + path.relative_to(output).as_posix() + '\n'
                                             for path in files), encoding='ascii', newline='\n')
    print(json.dumps(manifest, indent=2))
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ndk-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ndk-archive', type=Path, help='optional original host archive to verify official size/SHA1')
    args = parser.parse_args()
    try:
        build(args.ndk_dir, args.output, args.ndk_archive)
    except (OSError, RuntimeError, ValueError, UnicodeError) as error:
        parser.exit(1, 'Native build failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
