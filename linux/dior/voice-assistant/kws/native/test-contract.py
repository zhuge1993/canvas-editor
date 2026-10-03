#!/usr/bin/env python3
"""Compile and run the real worker boundary with a fake API on Windows."""
import argparse
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--tokens",type=Path,required=True)
parser.add_argument("--output",type=Path,required=True)
args=parser.parse_args()
args.output.mkdir(parents=True,exist_ok=True)
vc = sorted(Path('C:/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC').glob('*'))[-1]
sdk = sorted(Path('C:/Program Files (x86)/Windows Kits/10/Include').glob('10.*'))[-1]
env = os.environ.copy()
env['PATH'] = str(vc/'bin/Hostx64/x64') + os.pathsep + env['PATH']
env['INCLUDE'] = os.pathsep.join(str(p) for p in [vc/'include',sdk/'ucrt',sdk/'shared',sdk/'um'])
env['LIB'] = os.pathsep.join(str(p) for p in [vc/'lib/x64',sdk.parent.parent/'Lib'/sdk.name/'ucrt/x64',sdk.parent.parent/'Lib'/sdk.name/'um/x64'])
subprocess.run([str(vc/'bin/Hostx64/x64/cl.exe'),'/nologo','/std:c11','/utf-8','/O2','/W3','/D_CRT_SECURE_NO_WARNINGS','/I'+str(HERE/'test-compat'),str(HERE/'test-contract.c'),'/Fe:'+str(args.output/'test-contract.exe'),'/Fo:'+str(args.output/'test-contract.obj')],check=True,env=env)
result = subprocess.run([str(args.output/'test-contract.exe'),str(args.tokens)],check=True,capture_output=True,text=True,encoding='utf-8')
print(result.stdout)
binary = args.output/'test-contract.exe'
worker_command = [str(binary),'--worker','--encoder','dummy','--decoder','dummy','--joiner','dummy','--tokens',str(args.tokens),'--keywords','n i :1.5 #0.35 @name']
requests = [b'{"op":"ping","id":7}\n',b'{"op":"set_keywords","keywords_string":"n i :1.5 #0.35 @new","id":8}\n',b'{"op":"feed","pcm16_hex":"'+b'00'*640+b'","id":9}\n',b'x'*16385+b'\n',b'{"op":"reset","id":10}\n',b'{"op":"quit","id":11}\n']
completed = subprocess.run(worker_command,input=b''.join(requests),capture_output=True)
if completed.returncode:
    print(completed.stdout.decode('utf-8',errors='replace'), completed.stderr.decode('utf-8',errors='replace'))
completed.check_returncode()
records = [json.loads(line) for line in completed.stdout.decode('utf-8').splitlines()]
assert len(records) == 7, records
assert records[0]['op'] == 'ready'
assert records[1]['id'] == 7 and records[1]['ok']
assert records[2]['id'] == 8 and records[2]['stream_generation'] == 2
assert records[3]['id'] == 9 and records[3]['samples_total'] == 320
assert records[4]['error'] == 'line_too_large_or_nul'
assert records[5]['id'] == 10 and records[5]['stream_generation'] == 3
assert records[6]['id'] == 11 and records[6]['ok']
print('JSONL ready/ping/set/feed/oversize/reset/quit sequence passed with fake C API.')
(args.output/'HOST-CONTRACT-RESULT.json').write_text(json.dumps({'passed':True,'fake_c_api':True,'actual_keyword_recognition_tested':False,'actual_phone_execution_tested':False,'protocol_sequence':records},indent=2)+'\n',encoding='utf-8',newline='\n')
