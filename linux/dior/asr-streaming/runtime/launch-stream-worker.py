#!/usr/bin/env python3
"""Run the bounded CPU stdin JSON worker using the existing private Bionic SDK.

No GPU is loaded by the ASR worker; the SDK transport is used solely to obtain
the already provisioned, read-only KitKat property workspace file descriptor.
No system properties, SDK files, audio files, or website data are written.
"""
import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import stat
import sys
sys.dont_write_bytecode=True

WORKER_SHA256='0d2206ee5fe10e63979a5f959883b5e414136f346e42e2b5eb0c4aeeee3b5dbd'

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worker',default=str(Path(__file__).resolve().with_name('stream-worker')))
    parser.add_argument('--model',required=True)
    parser.add_argument('--threads',type=int,choices=range(1,5),default=2)
    parser.add_argument('--decoder',choices=['greedy_search','modified_beam_search'],default='greedy_search')
    parser.add_argument('--beam',type=int,choices=range(1,9),default=4)
    parser.add_argument('--endpoint',type=int,choices=[0,1],default=1)
    parser.add_argument('--memory-mib',type=int,metavar='256..1024',default=512)
    args=parser.parse_args()
    if not 256<=args.memory_mib<=1024:parser.error('memory-mib must be between 256 and 1024')
    import resource
    worker=Path(args.worker)
    info=worker.lstat()
    if not stat.S_ISREG(info.st_mode) or not 0<info.st_size<=8*1024*1024:
        raise ValueError('Expected bounded regular worker file')
    worker=worker.resolve(strict=True)
    if hashlib.sha256(worker.read_bytes()).hexdigest()!=WORKER_SHA256:
        raise ValueError('Worker SHA256 does not match the qualified build')
    model=Path(args.model).resolve(strict=True)
    if not model.is_dir():raise ValueError('Expected model directory')
    sdk=Path('/opt/dior-android')
    launcher=sdk/'run-native.py'
    info=launcher.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022:
        raise ValueError('Expected the existing root-owned immutable SDK launcher')
    if not (sdk/'system/bin/linker').is_file() or not all((sdk/'system/lib'/n).is_file() for n in ('libc.so','libm.so','libdl.so','liblog.so')):
        raise ValueError('Existing private Bionic runtime is incomplete')
    spec=importlib.util.spec_from_file_location('dior_readonly_property_transport',launcher)
    transport=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(transport)
    _unused_gpu_program,sdk_env,descriptor=transport.runtime_environment('opencl',[])
    env={k:sdk_env[k] for k in ('LD_LIBRARY_PATH','ANDROID_PROPERTY_WORKSPACE')}
    env.update(PATH='/usr/bin:/bin',LANG='C.UTF-8',OMP_NUM_THREADS=str(args.threads),OMP_THREAD_LIMIT=str(args.threads),OMP_WAIT_POLICY='PASSIVE',KMP_BLOCKTIME='0')
    resource.setrlimit(resource.RLIMIT_CORE,(0,0))
    resource.setrlimit(resource.RLIMIT_AS,(args.memory_mib*1024*1024,)*2)
    resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
    try:
        os.set_inheritable(descriptor,True)
        command=[str(worker),str(model),str(args.threads),args.decoder,str(args.beam),str(args.endpoint)]
        os.execve(worker,command,env)
    finally:
        os.close(descriptor)

if __name__=='__main__':main()
