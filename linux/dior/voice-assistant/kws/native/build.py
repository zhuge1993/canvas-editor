#!/usr/bin/env python3
"""Build only the tiny worker against prebuilt GNU ARMhf sherpa libraries."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--clang', type=Path, required=True)
parser.add_argument('--binutils', type=Path, required=True)
parser.add_argument('--gnu-dev', type=Path, required=True)
parser.add_argument('--private-libs', type=Path, required=True)
parser.add_argument('--sherpa-libs', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output=args.output.resolve()
if args.output==HERE or args.output in HERE.parents:raise ValueError("Output must be outside source")
args.output.parent.mkdir(parents=True,exist_ok=True)
source_pin=json.loads((HERE.parent/"SOURCE-PINS.json").read_text())["native_source"]
for name in ("kws-worker.c","c-api.h"):
    if hashlib.sha256((HERE/name).read_bytes()).hexdigest()!=source_pin[name]:raise ValueError("Qualified source differs: "+name)
devlib = args.gnu_dev/'usr/lib/arm-linux-gnueabihf'
includes = args.gnu_dev/'usr/include'
obj = args.output.with_suffix('.o')
gccroot = args.binutils.parent/'lib/gcc/arm-linux-androideabi/4.9.x'
libgcc = gccroot/'armv7-a/hard/libgcc.a'
resource_dir = Path(subprocess.check_output([str(args.clang), '-print-resource-dir'], text=True).strip())
commands = [
    [str(args.clang), '-target', 'arm-linux-gnueabihf', '-march=armv7-a', '-mfpu=neon', '-mfloat-abi=hard', '-marm',
     '-std=c99', '-D_POSIX_C_SOURCE=200809L', '-O2', '-Wall', '-Wextra', '-Werror', '-fno-stack-protector', '-fno-pie',
     '-nostdinc', '-isystem', str(resource_dir/'include'),
     '-isystem', str(includes/'arm-linux-gnueabihf'), '-isystem', str(includes), '-I', str(HERE),
     '-c', str(HERE/'kws-worker.c'), '-o', str(obj)],
    [str(args.binutils/'arm-linux-androideabi-ld.exe'), '-m', 'armelf_linux_eabi', '--dynamic-linker', '/lib/ld-linux-armhf.so.3',
     '-z', 'noexecstack', '-z', 'relro', '-z', 'now', '--hash-style=both', '-o', str(args.output),
     str(devlib/'crt1.o'), str(devlib/'crti.o'), str(obj),
     '-L', str(args.sherpa_libs), '-L', str(args.private_libs), '-rpath-link', str(args.private_libs),
     '-rpath-link', str(args.sherpa_libs), '--no-as-needed', '-l:libsherpa-onnx-c-api.so',
     '--start-group', '-l:libc.so.6', str(devlib/'libc_nonshared.a'), str(libgcc), '--end-group', str(devlib/'crtn.o')]
]
for command in commands:
    subprocess.run(command, check=True)
readelf = args.binutils/'arm-linux-androideabi-readelf.exe'
proof = subprocess.check_output([str(readelf), '-h', '-l', '-A', '-d', '-V', str(args.output)], text=True, encoding='utf-8')
symbols = subprocess.check_output([str(readelf), '--dyn-syms', '--wide', str(args.output)], text=True, encoding='utf-8')
if 'hard-float ABI' not in proof or 'ARM' not in proof or '__libc_init' in symbols:
    raise RuntimeError('worker ABI/startup verification failed')
needed = re.findall(r'Shared library: \[([^\]]+)\]', proof)
if sorted(needed) != ['libc.so.6', 'libsherpa-onnx-c-api.so']:
    raise RuntimeError('unexpected direct dependencies: '+repr(needed))
(args.output.parent/'ELF-PROOF.txt').write_text(proof+'\nDYNAMIC SYMBOLS\n'+symbols, encoding='utf-8', newline='\n')
manifest = {'schema':1,'worker':str(args.output),'bytes':args.output.stat().st_size,'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),
            'architecture':'ARMv7-A NEON GNU EABI5 hard-float','interpreter':'/lib/ld-linux-armhf.so.3',
            'direct_needed':needed,'glibc_versions':sorted(set(re.findall(r'GLIBC_[0-9.]+',proof))),
            'runtime_recompiled':False,'phone_verified':False,
            'source_sha256':hashlib.sha256((HERE/'kws-worker.c').read_bytes()).hexdigest(),
            'header_sha256':hashlib.sha256((HERE/'c-api.h').read_bytes()).hexdigest(),'commands':commands}
(args.output.parent/'BUILD-MANIFEST.json').write_text(json.dumps(manifest, indent=2)+'\n', encoding='utf-8', newline='\n')
print(json.dumps({k:v for k,v in manifest.items() if k!='commands'}, indent=2))
