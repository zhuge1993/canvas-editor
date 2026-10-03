#!/usr/bin/env python3
"""Build CPU ARMv7/API19 local LLM from pinned upstream source; no deployment."""
import argparse,hashlib,json,os,subprocess
from pathlib import Path
HERE=Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--ndk',type=Path,required=True)
parser.add_argument('--support',type=Path,required=True,help='Existing extracted NDK17c Clang/static-C++ support directory')
parser.add_argument('--source',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--cmake',type=Path,required=True)
parser.add_argument('--ninja',type=Path,required=True)
parser.add_argument('--json-include',type=Path,required=True,help='Pinned nlohmann3.12 single_include/nlohmann directory')
args=parser.parse_args()
NDK=args.ndk.resolve(strict=True);PREV=args.support.resolve(strict=True);SRC=args.source.resolve(strict=True);OUT=args.output.resolve()
if OUT==HERE or OUT in HERE.parents or OUT==SRC or SRC in OUT.parents or OUT==NDK or NDK in OUT.parents:raise ValueError('Output must be separate from source/NDK')
OUT.mkdir(parents=True,exist_ok=True)
for entry in json.loads((HERE/'SOURCE.json').read_text())['files']:
 path=SRC/entry['path']
 if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('Pinned source differs: '+entry['path'])
json_pin=json.loads((HERE/'DEPENDENCIES.json').read_text())['json_header']
if hashlib.sha256((args.json_include/'json.hpp').read_bytes()).hexdigest()!=json_pin['sha256']:raise ValueError('Pinned JSON header differs')
CMAKE=args.cmake.resolve(strict=True);NINJA=args.ninja.resolve(strict=True)
TOOLS=NDK/'toolchains/arm-linux-androideabi-4.9/prebuilt/windows-x86_64/bin'
CC=PREV/'llvm/bin/clang.exe';STL=PREV/'llvm-stl';PLATFORM=NDK/'platforms/android-19/arch-arm';INCLUDE=NDK/'sysroot/usr/include'
def run(args,log):
 with log.open('w',encoding='utf8') as f:
  p=subprocess.run([str(x) for x in args],stdout=f,stderr=subprocess.STDOUT)
 print(log.name+': '+str(p.returncode),flush=True)
 if p.returncode:
  print(log.read_text(encoding='utf8',errors='replace')[-15000:]);raise RuntimeError('command failed')

def q(p):return str(p).replace('\\','/')

flags=['-O3','-DNDEBUG','-D__ANDROID_API__=19','-D_GNU_SOURCE','-D_XOPEN_SOURCE=600','-march=armv7-a','-mfloat-abi=softfp','-mfpu=neon-vfpv4','-fPIC','--sysroot='+q(PLATFORM),'-isystem',q(PREV/'android-support-include'),'-isystem',q(INCLUDE),'-isystem',q(INCLUDE/'arm-linux-androideabi'),'-I',q(STL/'llvm-libc++/include'),'-I',q(STL/'llvm-libc++abi/include'),'-include',q(HERE/'api19-compat.h')]
cmake_flags=flags+['--gcc-toolchain='+q(TOOLS.parent),'-fuse-ld='+q(TOOLS/'arm-linux-androideabi-ld.exe')]
toolchain=OUT/'dior-toolchain.cmake'
toolchain.write_text('set(CMAKE_SYSTEM_NAME Linux)\nset(CMAKE_SYSTEM_PROCESSOR arm)\nset(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n'+
 'set(CMAKE_C_COMPILER "'+q(CC)+'")\nset(CMAKE_CXX_COMPILER "'+q(CC)+'")\n'+
 'set(CMAKE_C_COMPILER_TARGET armv7-none-linux-androideabi19)\nset(CMAKE_CXX_COMPILER_TARGET armv7-none-linux-androideabi19)\n'+
 'set(CMAKE_AR "'+q(TOOLS/'arm-linux-androideabi-ar.exe')+'")\nset(CMAKE_RANLIB "'+q(TOOLS/'arm-linux-androideabi-ranlib.exe')+'")\n',encoding='utf8')
run([CMAKE,'-S',SRC,'-B',OUT,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+q(NINJA),'-DCMAKE_TOOLCHAIN_FILE='+q(toolchain),'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_C_FLAGS='+' '.join(cmake_flags),'-DCMAKE_CXX_FLAGS='+' '.join(cmake_flags),'-DBUILD_SHARED_LIBS=OFF','-DLLAMA_BUILD_COMMON=OFF','-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_EXAMPLES=OFF','-DLLAMA_BUILD_SERVER=OFF','-DLLAMA_CURL=OFF','-DGGML_NATIVE=OFF','-DGGML_OPENMP=OFF','-DGGML_LLAMAFILE=OFF','-DGGML_ALL_WARNINGS=OFF','-DGGML_RPC=OFF'],OUT/'configure.log')
run([CMAKE,'--build',OUT,'--target','llama','-j','6'],OUT/'compile.log')
obj=OUT/'llm-worker.o'
run([CC,'-target','armv7-none-linux-androideabi19',*flags,'-std=c++11','-I',SRC/'include','-I',SRC/'ggml/include','-I',args.json_include,'-c',HERE/'llm-worker.cpp','-o',obj],OUT/'worker-compile.log')
libs=list(OUT.rglob('*.a'));binary=OUT/'llm-worker'
run([TOOLS/'arm-linux-androideabi-gcc.exe',*flags,'-pie','-Wl,--hash-style=sysv','-Wl,--dynamic-linker,/opt/dior-android/system/bin/linker',obj,'-Wl,--start-group',*libs,PREV/'libatomic.a',*[STL/'llvm-libc++/libs/armeabi-v7a'/n for n in ('libc++_static.a','libc++abi.a','libandroid_support.a','libunwind.a')],'-Wl,--end-group','-lm','-ldl','-o',binary],OUT/'link.log')
run([TOOLS/'arm-linux-androideabi-strip.exe','--strip-debug',binary],OUT/'strip.log')
proof=subprocess.check_output([str(TOOLS/'arm-linux-androideabi-readelf.exe'),'-h','-l','-d',str(binary)],text=True,encoding='utf8');(OUT/'ELF-PROOF.txt').write_text(proof,encoding='utf8')
manifest={'engine':'llama.cpp b3927','commit':'10433e8b457c4cfd759cbb41fc55fc398db4a5da','binary':str(binary),'bytes':binary.stat().st_size,'sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'backend':'CPU_ARMV7_NEON','gpu_used':False,'interpreter':'/opt/dior-android/system/bin/linker','phone_verified':False,'model_weights_not_in_git':True}
(OUT/'BUILD.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8');print(json.dumps(manifest,indent=2))
