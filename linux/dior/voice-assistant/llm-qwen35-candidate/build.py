"""Reproducible Windows-host ARMv7/API19 Qwen3.5 probe build, without installation.

Only two pinned upstream filesystem includes/namespaces are patched. Supply
the fixed source and dependencies explicitly; no SDK/model downloads occur.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

PIN='99b95488cac0f00ce3f05af113a8c1e287753f87'
FS_PIN='8a2edd6d92ed820521d42c94d179462bf06b5ed3'
FS_SHA='522791c2a2f1959193fdff61f4668c5ba894459753170b2246971272ee8ddc47'
PATCHES={
    'ggml/src/ggml-backend-dl.h':('225bd83a197c4e8b5f985717176824d1144e2b74a79f04838f51b84115c14dc5',
                               'c056247c5f6da030c9c052dd390887c206fd66e2c96a93c02d49f1c2429740e7'),
    'ggml/src/ggml-backend-reg.cpp':('0f63c69ad083e0744872f57d59d049b069283303f5bbc646222907d779afe4d1',
                                  '6e605bb7a314f8bb6524a9aa846c1433078a1cfc744c6e71972b83fc7d451043')}
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def q(path):return str(path).replace('\\','/')
def main():
    here=Path(__file__).resolve().parent
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('ndk','support','source','json-include','output','cmake','ninja','filesystem-header'):
        parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--compiler',type=Path,help='Default: support/llvm/bin/clang.exe')
    parser.add_argument('--worker-source',type=Path,default=here/'qwen35-worker.cpp')
    parser.add_argument('--api19-compat',type=Path,default=here/'api19-compat.h')
    parser.add_argument('--jobs',type=int,default=4)
    args=parser.parse_args()
    if not 1<=args.jobs<=8:parser.error('jobs must be1..8')
    ndk=args.ndk.resolve();support=args.support.resolve();source=args.source.resolve()
    output=args.output.resolve();compiler=(args.compiler or support/'llvm/bin/clang.exe').resolve()
    tools=ndk/'toolchains/arm-linux-androideabi-4.9/prebuilt/windows-x86_64/bin'
    platform=ndk/'platforms/android-19/arch-arm';include=ndk/'sysroot/usr/include';stl=support/'llvm-stl'
    required=[args.cmake,args.ninja,compiler,args.filesystem_header,args.worker_source,args.api19_compat,
              args.json_include/'json.hpp',tools/'arm-linux-androideabi-gcc.exe',
              tools/'arm-linux-androideabi-ar.exe',source/'src/models/qwen35.cpp',support/'libatomic.a',
              stl/'llvm-libc++/libs/armeabi-v7a/libc++_static.a']
    for path in required:
        if not path.is_file():parser.error('required file missing: '+str(path))
    if digest(args.filesystem_header)!=FS_SHA:parser.error('filesystem header differs from pinned full bytes')
    output.mkdir(parents=True,exist_ok=True)
    compat=output/'compat/ghc';compat.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(args.filesystem_header,compat/'filesystem.hpp')
    compatibility=output/'api19-compat.h';shutil.copyfile(args.api19_compat,compatibility)
    patches=[]
    for name,(original_hash,patched_hash) in PATCHES.items():
        path=source/name;original=path.read_bytes();current=hashlib.sha256(original).hexdigest()
        if current not in (original_hash,patched_hash):parser.error('unexpected filesystem source bytes: '+name)
        if current==original_hash:
            text=original.decode('utf8').replace('#include <filesystem>','#include <ghc/filesystem.hpp>').replace(
                'namespace fs = std::filesystem;','namespace fs = ghc::filesystem;')
            data=text.encode('utf8')
            if hashlib.sha256(data).hexdigest()!=patched_hash:parser.error('filesystem patch did not match fixed result')
            path.write_bytes(data)
        patches.append({'file':name,'original_sha256':original_hash,'patched_sha256':patched_hash})
    (output/'filesystem-patch.json').write_text(json.dumps(patches,indent=2)+'\n',encoding='utf8',newline='\n')
    environment=dict(os.environ)
    def run(command,name):
        with (output/name).open('w',encoding='utf8',newline='\n') as log:
            result=subprocess.run([str(value) for value in command],env=environment,stdout=log,stderr=subprocess.STDOUT)
        print(name+': '+str(result.returncode),flush=True)
        if result.returncode:
            print((output/name).read_text(encoding='utf8',errors='replace')[-6000:],flush=True)
            raise SystemExit(result.returncode)
    flags=['-O3','-DNDEBUG','-D__ANDROID_API__=19','-D_GNU_SOURCE','-D_XOPEN_SOURCE=600',
           '-march=armv7-a','-mfloat-abi=softfp','-mfpu=neon-vfpv4','-fPIC','--sysroot='+q(platform),
           '-isystem',q(support/'android-support-include'),'-isystem',q(include),
           '-isystem',q(include/'arm-linux-androideabi'),'-I',q(stl/'llvm-libc++/include'),
           '-I',q(stl/'llvm-libc++abi/include'),'-I',q(compat.parent),'-include',q(compatibility)]
    cmake_flags=flags+['--gcc-toolchain='+q(tools.parent),'-fuse-ld='+q(tools/'arm-linux-androideabi-ld.exe')]
    toolchain=output/'api19-toolchain.cmake'
    toolchain.write_text('set(CMAKE_SYSTEM_NAME Linux)\nset(CMAKE_SYSTEM_PROCESSOR arm)\n'+
        'set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n'+
        'set(CMAKE_C_COMPILER "'+q(compiler)+'")\nset(CMAKE_CXX_COMPILER "'+q(compiler)+'")\n'+
        'set(CMAKE_C_COMPILER_TARGET armv7-none-linux-androideabi19)\n'+
        'set(CMAKE_CXX_COMPILER_TARGET armv7-none-linux-androideabi19)\n'+
        'set(CMAKE_AR "'+q(tools/'arm-linux-androideabi-ar.exe')+'")\n'+
        'set(CMAKE_RANLIB "'+q(tools/'arm-linux-androideabi-ranlib.exe')+'")\n',encoding='utf8',newline='\n')
    build=output/'core'
    disabled=('BUILD_SHARED_LIBS','LLAMA_BUILD_COMMON','LLAMA_BUILD_TESTS','LLAMA_BUILD_TOOLS',
              'LLAMA_BUILD_EXAMPLES','LLAMA_BUILD_SERVER','LLAMA_BUILD_APP','LLAMA_BUILD_MTMD',
              'LLAMA_OPENSSL','LLAMA_SUBPROCESS','LLAMA_ALL_WARNINGS','GGML_NATIVE','GGML_OPENMP',
              'GGML_LLAMAFILE','GGML_ALL_WARNINGS','GGML_RPC','GGML_BACKEND_DL','GGML_CPU_KLEIDIAI')
    run([args.cmake,'-S',source,'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+q(args.ninja),
         '-DCMAKE_TOOLCHAIN_FILE='+q(toolchain),'-DCMAKE_BUILD_TYPE=Release','-DCMAKE_HAVE_LIBC_PTHREAD=1',
         '-DCMAKE_C_FLAGS='+' '.join(cmake_flags),'-DCMAKE_CXX_FLAGS='+' '.join(cmake_flags),
         '-DGGML_CPU_ARM_ARCH=armv7-a',*['-D'+name+'=OFF' for name in disabled]],'configure.log')
    run([args.cmake,'--build',build,'--target','llama','-j',args.jobs],'compile-core.log')
    obj=output/'qwen35-worker.o';binary=output/'qwen35-worker'
    run([compiler,'-target','armv7-none-linux-androideabi19',*flags,'-std=c++17',
         '-I',source/'include','-I',source/'ggml/include','-I',args.json_include,
         '-c',args.worker_source,'-o',obj],'compile-worker.log')
    libraries=[build/'src/libllama.a',build/'ggml/src/libggml.a',build/'ggml/src/libggml-cpu.a',build/'ggml/src/libggml-base.a']
    run([tools/'arm-linux-androideabi-gcc.exe',*flags,'-pie','-Wl,--hash-style=sysv',
         '-Wl,--dynamic-linker,/opt/dior-android/system/bin/linker',obj,'-Wl,--start-group',*libraries,
         support/'libatomic.a',*[stl/'llvm-libc++/libs/armeabi-v7a'/name for name in
                                ('libc++_static.a','libc++abi.a','libandroid_support.a','libunwind.a')],
         '-Wl,--end-group','-lm','-ldl','-o',binary],'link-worker.log')
    run([tools/'arm-linux-androideabi-strip.exe','--strip-debug',binary],'strip-worker.log')
    proof=subprocess.check_output([str(tools/'arm-linux-androideabi-readelf.exe'),'-h','-l','-d','-A',str(binary)],text=True,encoding='utf8')
    (output/'ELF-PROOF.txt').write_text(proof,encoding='utf8',newline='\n')
    manifest={'engine_tag':'b11371','expected_source_pin':PIN,'filesystem_pin':FS_PIN,'filesystem_header_sha256':FS_SHA,
              'worker_source_sha256':digest(args.worker_source),'compatibility_header_sha256':digest(args.api19_compat),
              'binary_bytes':binary.stat().st_size,'binary_sha256':digest(binary),
              'compiler_version':subprocess.check_output([str(compiler),'--version'],text=True).splitlines()[0],
              'target':'ARMv7_CPU_NEON_API19','gpu_used':False,'phone_executed_by_build':False,
              'model_downloaded_by_build':False,'services_modified_by_build':False}
    (output/'BUILD.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf8',newline='\n')
    print(json.dumps(manifest),flush=True)
if __name__=='__main__':main()
