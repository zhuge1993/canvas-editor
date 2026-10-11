"""Build an ARMv7 NEON GNU hard-float worker with an existing cross toolchain."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
for argument in ['clang', 'binutils', 'gnu-dev', 'private-libs', 'onnx-libs', 'output']:
    parser.add_argument('--' + argument, type=Path, required=True)
args = parser.parse_args()
args.output.parent.mkdir(parents=True, exist_ok=True)
includes = args.gnu_dev / 'usr/include'
devlib = args.gnu_dev / 'usr/lib/arm-linux-gnueabihf'
resource = Path(subprocess.check_output([str(args.clang), '-print-resource-dir'], text=True).strip())
libgcc = args.binutils.parent / 'lib/gcc/arm-linux-androideabi/4.9.x/armv7-a/hard/libgcc.a'
obj = args.output.with_suffix('.o')
commands = [
    [str(args.clang), '-target', 'arm-linux-gnueabihf', '-march=armv7-a', '-mfpu=neon', '-mfloat-abi=hard', '-marm',
     '-std=c99', '-D_POSIX_C_SOURCE=200809L', '-O2', '-Wall', '-Wextra', '-Werror', '-fno-stack-protector', '-fno-pie',
     '-nostdinc', '-isystem', str(resource/'include'), '-isystem', str(includes/'arm-linux-gnueabihf'),
     '-isystem', str(includes), '-I', str(HERE), '-c', str(HERE/'worker.c'), '-o', str(obj)],
    [str(args.binutils/'arm-linux-androideabi-ld.exe'), '-m', 'armelf_linux_eabi', '--dynamic-linker', '/lib/ld-linux-armhf.so.3',
     '-z', 'noexecstack', '-z', 'relro', '-z', 'now', '--hash-style=both', '-o', str(args.output),
     str(devlib/'crt1.o'), str(devlib/'crti.o'), str(obj), '-L', str(args.onnx_libs), '-L', str(args.private_libs),
     '-rpath-link', str(args.private_libs), '-rpath-link', str(args.onnx_libs), '--no-as-needed', '-l:libonnxruntime.so',
     '--start-group', '-l:libc.so.6', str(devlib/'libc_nonshared.a'), str(libgcc), '--end-group', str(devlib/'crtn.o')]
]
for command in commands:
    subprocess.run(command, check=True)
proof = subprocess.check_output([str(args.binutils/'arm-linux-androideabi-readelf.exe'), '-h', '-l', '-d', '-V', str(args.output)], text=True)
if 'hard-float ABI' not in proof or '/lib/ld-linux-armhf.so.3' not in proof:
    raise ValueError('wrong worker ABI')
(args.output.parent/'worker-build.json').write_text(json.dumps({'architecture': 'ARMv7 NEON GNU hard-float', 'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest(), 'bytes': args.output.stat().st_size, 'phoneQualified': False, 'commands': commands}, indent=2)+'\n', encoding='utf-8')
print('ARMv7 worker built and ELF verified')
