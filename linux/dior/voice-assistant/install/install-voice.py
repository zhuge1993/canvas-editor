#!/usr/bin/env python3
"""Install/resume only the qualified voice service; never stop ASR or the tunnel."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import grp
import re
import shutil
import socket
import stat
import subprocess
import time
import uuid

ROOT=Path('/opt/dior-voice')
STATE=Path('/var/lib/dior-voice')
RUNTIME=Path('/run/dior-voice')
MARKER=Path('/opt/.dior-voice-installing.json')
BACKUP=Path('/opt/dior-voice.previous')
SERVICE=Path('/etc/init.d/dior-voice')
MODEL_SHA='7671c0c304e6ce5a7fc577bcb12aba01e2c155cc2efd29b2213c95b18edaf6ed'
WORKER_SHA='051f0fc03b465215258ba75f4dc039e6a805d5f22cc2e3b69fd578eb95afe984'
MODEL_NAME='qwen2.5-0.5b-instruct-q4_0.gguf'
MAX_PROGRAM=16*1024*1024
MAX_MARKER=256*1024
PROC_ROOT=Path('/proc')

def require(ok,message):
    if not ok:raise RuntimeError(message)
def sha(file):
    digest=hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda:stream.read(262144),b''):digest.update(block)
    return digest.hexdigest()
def plain(path,directory=False,budget=None):
    info=path.lstat()
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),'non_plain_path:'+str(path))
    require(info.st_uid==0 and not info.st_mode&0o022 and path.resolve()==path,'mutable_or_linked_path:'+str(path))
    if not directory:require(info.st_nlink==1 and (budget is None or info.st_size<=budget),'file_budget_or_links:'+str(path))
    return info
def call(*args,check=True):
    return subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=check,timeout=35)
def sync_dir(path):
    fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)
def blob(value):return (json.dumps(value,ensure_ascii=False,sort_keys=True,indent=2)+'\n').encode()
def managed_target(path):
    require(path.is_absolute() and path.resolve(strict=False)==path,'target_resolution')
    require(path in (MARKER,SERVICE) or path==ROOT/'INSTALL-MANIFEST.json'
            or path in (ROOT/'adapter.py',ROOT/'llm-worker')
            or path.parent==ROOT/'runtime' or path.is_relative_to(BACKUP),'unmanaged_program_target:'+str(path))
def put(target,data,mode=0o644,allowed_old=(),approved_prefixes=()):
    managed_target(target);require(len(data)<=MAX_PROGRAM,'program_file_budget')
    plain(target.parent,True)
    if target.exists() or target.is_symlink():plain(target,budget=MAX_PROGRAM)
    temp=target.with_name('.'+target.name+'.voice-stage')
    expected=hashlib.sha256(data).hexdigest()
    if temp.exists() or temp.is_symlink():
        plain(temp,budget=MAX_PROGRAM)
        residue=temp.read_bytes()
        qualified=sha(temp) in {expected,*allowed_old} or any(residue==candidate[:len(residue)] and len(residue)<=len(candidate) for candidate in (data,*approved_prefixes))
        require(qualified,'unknown_staged_content:'+str(temp))
        temp.unlink();sync_dir(temp.parent)
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'wb') as file:file.write(data);file.flush();os.fsync(file.fileno())
        plain(temp,budget=MAX_PROGRAM);require(sha(temp)==expected,'staged_hash_mismatch')
        temp.chmod(mode);temp.replace(target);sync_dir(target.parent)
    except BaseException:
        # Keep only our hash-qualified interrupted stage for the next run.
        raise

def read_json(path,budget):
    plain(path,budget=budget);return json.loads(path.read_text(encoding='utf8'))
def save_marker(transaction):
    data=blob(transaction);require(len(data)<=MAX_MARKER,'marker_budget')
    old=MARKER.read_bytes() if MARKER.exists() else b''
    put(MARKER,data,0o600,approved_prefixes=(old,) if old else ())
def tree_receipt(path):
    plain(path,True);rows=[];total=0
    for file in sorted(path.rglob('*')):
        if file.is_dir():plain(file,True);continue
        info=plain(file);total+=info.st_size
        require(total<=150*1024*1024 and len(rows)<256,'asset_tree_budget')
        rows.append({'path':str(file.relative_to(path)),'bytes':info.st_size,'sha256':sha(file)})
    return rows
def same_tree(path,rows):return tree_receipt(path)==rows

def voice_processes():
    result=[]
    try:shared_uid=pwd.getpwnam('dior-inference').pw_uid
    except KeyError:shared_uid=None
    for entry in PROC_ROOT.glob('[0-9]*'):
        try:
            if int(entry.name)==os.getpid():continue
            argv=(entry/'cmdline').read_bytes().split(b'\0')
            uid_line=next((line for line in (entry/'status').read_text().splitlines() if line.startswith('Uid:')),None)
            identities=[int(value) for value in uid_line.split()[1:]] if uid_line else []
            # Paths are shared readonly assets. Exempt only the authenticated
            # dedicated shared account, not root/voice/unknown stray processes.
            if shared_uid is not None and shared_uid!=0 and identities==[shared_uid]*4:continue
            if (b'/opt/dior-voice/runtime/run_assistant.py' in argv
                or b'/opt/dior-voice/llm-worker' in argv
                or any(value.startswith(b'/opt/dior-voice/tts/') for value in argv)):
                result.append(int(entry.name))
        except (OSError,ValueError):pass
    return result
def voice_listener():
    path=RUNTIME/'control.sock'
    if not path.exists():return False
    require(stat.S_ISSOCK(path.lstat().st_mode),'unexpected_control_path')
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as connection:
        connection.settimeout(.2)
        try:connection.connect(str(path));return True
        except (ConnectionRefusedError,FileNotFoundError):return False

def stop_voice():
    result=call('rc-service','--nodeps','dior-voice','stop',check=False)
    deadline=time.monotonic()+15
    while time.monotonic()<deadline:
        if not voice_processes() and not voice_listener():return
        time.sleep(.1)
    raise RuntimeError('old_voice_still_running_after_stop:'+str(result.returncode))

def program_rows():
    rows=[];total=0
    candidates=[]
    if (ROOT/'runtime').exists():
        plain(ROOT/'runtime',True)
        for p in (ROOT/'runtime').iterdir():
            if p.name=='__pycache__' and p.is_dir() and not p.is_symlink():continue
            require(p.is_file() and not p.is_symlink(),'unexpected_runtime_entry')
            candidates.append(('runtime/'+p.name,p))
    for name in ('adapter.py','llm-worker','INSTALL-MANIFEST.json'):
        p=ROOT/name
        if p.exists():candidates.append((name,p))
    if SERVICE.exists():candidates.append(('service.openrc',SERVICE))
    for name,p in candidates:
        info=plain(p,budget=MAX_PROGRAM);total+=info.st_size;require(total<=MAX_PROGRAM,'backup_budget')
        rows.append({'path':name,'bytes':info.st_size,'sha256':sha(p),'mode':stat.S_IMODE(info.st_mode)})
    return rows

def backup_name(name):
    parts=Path(name).parts
    require(name in ('adapter.py','llm-worker','INSTALL-MANIFEST.json','service.openrc')
            or len(parts)==2 and parts[0]=='runtime' and re.fullmatch(r'[A-Za-z0-9_.-]+',parts[1]) and '..' not in parts[1], 'unmanaged_backup_name')
    return BACKUP/name

def remove_backup(expected=None):
    if not BACKUP.exists():return
    plain(BACKUP,True)
    receipt_file=BACKUP/'BACKUP-MANIFEST.json'
    if receipt_file.exists():
        receipt=read_json(receipt_file,MAX_MARKER)
        require(receipt.get('format')=='dior-voice-program-backup-v1','backup_receipt_format')
        rows=receipt['files']
    else:
        require(expected is not None,'unknown_backup_without_receipt')
        rows=expected
    allowed={str(backup_name(row['path']).relative_to(BACKUP)):row for row in rows}
    total=0
    for path in BACKUP.rglob('*'):
        if path.is_dir():
            plain(path,True);require(path==BACKUP/'runtime','unexpected_backup_directory');continue
        info=plain(path,budget=MAX_PROGRAM);total+=info.st_size
        require(total<=MAX_PROGRAM+MAX_MARKER,'backup_cleanup_budget')
        name=str(path.relative_to(BACKUP))
        if name=='BACKUP-MANIFEST.json':continue
        if name not in allowed and path.name.startswith('.') and path.name.endswith('.voice-stage'):
            logical=str(path.with_name(path.name[1:-len('.voice-stage')]).relative_to(BACKUP))
            require(logical in allowed,'unrecognized_backup_stage')
            original=SERVICE if logical=='service.openrc' else ROOT/logical
            plain(original,budget=MAX_PROGRAM);require(sha(original)==allowed[logical]['sha256'],'backup_stage_source_changed')
            residue=path.read_bytes();qualified=original.read_bytes()
            require(residue==qualified[:len(residue)] and len(residue)<=len(qualified),'backup_stage_prefix_mismatch')
            continue
        require(name in allowed,'unrecognized_backup_file')
        require(info.st_size==allowed[name]['bytes'] and sha(path)==allowed[name]['sha256'],'backup_cleanup_hash')
    shutil.rmtree(BACKUP);sync_dir(BACKUP.parent)

def build_backup(transaction):
    if transaction.get('backup_ready'):
        receipt=read_json(BACKUP/'BACKUP-MANIFEST.json',MAX_MARKER)
        require(receipt['transaction']==transaction['transaction'],'backup_transaction_mismatch')
        for row in receipt['files']:
            target=backup_name(row['path']);plain(target,budget=MAX_PROGRAM)
            require(target.stat().st_size==row['bytes'] and sha(target)==row['sha256'],'backup_hash_mismatch')
        return receipt['files']
    rows=transaction.get('backup_files') or program_rows()
    transaction['backup_files']=rows;save_marker(transaction)
    remove_backup(rows);BACKUP.mkdir(mode=0o700)
    for row in rows:
        source=SERVICE if row['path']=='service.openrc' else ROOT/row['path']
        plain(source,budget=MAX_PROGRAM);require(sha(source)==row['sha256'],'backup_source_changed')
        target=backup_name(row['path']);target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        put(target,source.read_bytes(),row['mode'])
    put(BACKUP/'BACKUP-MANIFEST.json',blob({'format':'dior-voice-program-backup-v1',
        'transaction':transaction['transaction'],'files':rows}),0o600)
    transaction['backup_ready']=True;save_marker(transaction);return rows

def restore_backup(transaction,staged):
    rows=build_backup(transaction);stop_voice()
    old={row['path']:row for row in rows}
    for path,descriptor in staged.items():
        relative='service.openrc' if path==SERVICE else str(path.relative_to(ROOT))
        if relative not in old and path.exists():
            plain(path,budget=MAX_PROGRAM);require(sha(path)==descriptor['sha256'],'rollback_changed_new_file')
            path.unlink();sync_dir(path.parent)
    for row in rows:
        source=BACKUP/row['path'];target=SERVICE if row['path']=='service.openrc' else ROOT/row['path']
        target.parent.mkdir(mode=0o755,parents=True,exist_ok=True)
        prefix=()
        if target in staged:
            approved=staged[target]['source'];plain(approved,budget=MAX_PROGRAM)
            require(sha(approved)==staged[target]['sha256'],'rollback_stage_source_changed')
            prefix=(approved.read_bytes(),)
        put(target,source.read_bytes(),row['mode'],approved_prefixes=prefix)
    if transaction['was_enabled']:call('rc-update','add','dior-voice','default')
    else:call('rc-update','del','dior-voice','default',check=False)
    if transaction['was_started']:call('rc-service','--nodeps','dior-voice','start')
    MARKER.unlink();sync_dir(MARKER.parent)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--stage',type=Path,default=Path('/tmp/dior-kernel-test/voice-qa'))
    parser.add_argument('--repair-runtime',action='store_true',help='Require an existing complete installation; never move model assets')
    args=parser.parse_args();base=args.stage
    require(os.geteuid()==0,'root_required');plain(base,True);plain(ROOT.parent,True)
    manifest=read_json(base/'RUNTIME-MANIFEST.json',MAX_MARKER)
    require(manifest.get('format')=='dior-voice-runtime-v1' and 0<len(manifest.get('files',[]))<=32,'runtime_manifest')
    names=set();sources={};total=0
    for row in manifest['files']:
        name=row['path'];require(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9_.-]+',name) and '..' not in name and name not in names,'runtime_name')
        names.add(name);source=base/'runtime'/name;info=plain(source,budget=1024*1024);total+=info.st_size
        require(info.st_size==row['bytes'] and re.fullmatch('[a-f0-9]{64}',row['sha256']) and sha(source)==row['sha256'],'runtime_hash:'+name)
        sources[ROOT/'runtime'/name]={'source':source,'sha256':row['sha256'],'mode':0o644}
    require(total<=8*1024*1024,'runtime_total_budget')
    require({'run_assistant.py','voice_ctl.py','assistant.py','interfaces.py','control.py','asr_stream.py','skills.py','settings.py','audio_backend.py','dior_audio.py','audio_controls.py'}.issubset(names),'missing_required_runtime')
    for name,mode in [('adapter.py',0o644),('llm-worker',0o755)]:
        source=base/name;plain(source,budget=8*1024*1024)
        if name=='llm-worker':require(sha(source)==WORKER_SHA,'worker_hash')
        sources[ROOT/name]={'source':source,'sha256':sha(source),'mode':mode}
    source=base/'dior-voice.openrc';plain(source,budget=65536)
    sources[SERVICE]={'source':source,'sha256':sha(source),'mode':0o755}
    stage_sha=hashlib.sha256(blob({str(p):{'sha256':d['sha256'],'mode':d['mode']} for p,d in sources.items()})).hexdigest()
    pending_temp=MARKER.with_name('.'+MARKER.name+'.voice-stage')
    if not MARKER.exists() and (pending_temp.exists() or pending_temp.is_symlink()):
        candidate=read_json(pending_temp,MAX_MARKER)
        require(candidate.get('format')=='dior-voice-installing-v1' and candidate.get('stage_sha256')==stage_sha and type(candidate.get('first')) is bool and re.fullmatch('[a-f0-9]{32}',candidate.get('transaction','')),'unknown_marker_stage')
        pending_temp.replace(MARKER);sync_dir(MARKER.parent)
    if MARKER.exists() or MARKER.is_symlink():
        transaction=read_json(MARKER,MAX_MARKER)
        require(transaction.get('format')=='dior-voice-installing-v1' and transaction.get('stage_sha256')==stage_sha,'pending_transaction_requires_same_qualified_stage')
        require(type(transaction.get('first')) is bool and re.fullmatch('[a-f0-9]{32}',transaction.get('transaction','')),'pending_marker_schema')
    else:
        if ROOT.exists():
            plain(ROOT,True);current=read_json(ROOT/'INSTALL-MANIFEST.json',MAX_MARKER)
            require(current.get('format')=='dior-voice-installed-v1','unmanaged_partial_installation')
            first=False
        else:first=True
        require(not args.repair_runtime or not first,'repair_requires_installed_program')
        transaction={'format':'dior-voice-installing-v1','transaction':uuid.uuid4().hex,'first':first,
            'stage_sha256':stage_sha,'was_enabled':Path('/etc/runlevels/default/dior-voice').exists(),
            'was_started':bool(voice_processes() or voice_listener()),'backup_ready':False}
        if first:
            plain(base/'tts',True);tts=tree_receipt(base/'tts')
            require(sha(base/'tts/models/zh_CN-huayan-x_low.onnx')=='d30b143fac66d821a1285aa013295adf5cd129d3cc11d70334e51c7b20662c37','tts_model_hash')
            cache=read_json(base/'tts/fixed-cache/manifest.json',MAX_MARKER)
            require(cache['total_pcm_bytes']<=1024*1024 and len(cache['phrases'])<=10,'fixed_cache_budget')
            for record in cache['phrases'].values():
                require(Path(record['file']).name==record['file'] and sha(base/'tts/fixed-cache'/record['file'])==record['sha256'],'fixed_cache_hash')
            transaction['tts_files']=tts
        save_marker(transaction)
    first=transaction['first'];require(not args.repair_runtime or not first,'repair_partial_first_install_forbidden')
    model=ROOT/'models'/MODEL_NAME
    if model.exists():plain(model);require(sha(model)==MODEL_SHA,'installed_model_hash')
    else:
        require(first,'installed_model_missing');plain(base/MODEL_NAME);require(sha(base/MODEL_NAME)==MODEL_SHA,'staged_model_hash')
    try:
        stop_voice()
        if first:
            if not ROOT.exists():ROOT.mkdir(mode=0o755)
            plain(ROOT,True);(ROOT/'models').mkdir(mode=0o755,exist_ok=True);plain(ROOT/'models',True)
            if not model.exists():
                require((base/MODEL_NAME).stat().st_dev==(ROOT/'models').stat().st_dev,'model_rename_device')
                (base/MODEL_NAME).rename(model);model.chmod(0o444);sync_dir(model.parent)
            tts_target=ROOT/'tts'
            if not tts_target.exists():
                require(same_tree(base/'tts',transaction['tts_files']),'staged_tts_changed')
                require((base/'tts').stat().st_dev==ROOT.stat().st_dev,'tts_rename_device')
                (base/'tts').rename(tts_target);sync_dir(ROOT)
            else:require(same_tree(tts_target,transaction['tts_files']),'resumed_tts_changed')
        else:build_backup(transaction)
        for folder in (ROOT/'tts').rglob('*'):
            if folder.is_dir():plain(folder,True);folder.chmod(0o755)
        try:grp.getgrnam('dior-voice')
        except KeyError:call('addgroup','-S','dior-voice')
        try:account=pwd.getpwnam('dior-voice')
        except KeyError:
            call('adduser','-S','-D','-H','-s','/sbin/nologin','-G','dior-voice','dior-voice');account=pwd.getpwnam('dior-voice')
        require(account.pw_shell=='/sbin/nologin' and account.pw_uid!=0,'dedicated_account')
        call('addgroup','dior-voice','audio');call('addgroup','dior-voice','dior-asr');call('addgroup','dior','dior-voice')
        for folder,mode in ((STATE,0o700),(RUNTIME,0o750)):
            if folder.exists():require(folder.is_dir() and not folder.is_symlink(),'state_directory')
            else:folder.mkdir(mode=mode)
            os.chown(folder,account.pw_uid,grp.getgrnam('dior-voice').gr_gid);folder.chmod(mode)
        (ROOT/'runtime').mkdir(mode=0o755,exist_ok=True);plain(ROOT/'runtime',True)
        for target,descriptor in sources.items():
            plain(descriptor['source'],budget=MAX_PROGRAM);require(sha(descriptor['source'])==descriptor['sha256'],'source_changed_during_install')
            put(target,descriptor['source'].read_bytes(),descriptor['mode'])
        installed=[]
        for file in sorted(ROOT.rglob('*')):
            require(not file.is_symlink(),'installed_link')
            if file.is_file() and file.name!='INSTALL-MANIFEST.json':
                info=plain(file);installed.append({'path':str(file.relative_to(ROOT)),'bytes':info.st_size,'sha256':sha(file)})
        put(ROOT/'INSTALL-MANIFEST.json',blob({'format':'dior-voice-installed-v1','files':installed,
            'model_weights_in_git':False,'microphone_recordings_saved':False}))
        call('rc-service','--nodeps','dior-voice','start')
        ready=None
        for _ in range(90):
            try:
                probe=call('python3',str(ROOT/'runtime/voice_ctl.py'),check=False);ready=json.loads(probe.stdout)
                if ready.get('status',{}).get('ready'):break
            except (ValueError,subprocess.SubprocessError):pass
            time.sleep(1)
        require(ready and ready.get('status',{}).get('ready'),'voice_readiness_failed')
        call('rc-update','add','dior-voice','default');MARKER.unlink();sync_dir(MARKER.parent)
        print(json.dumps({'status':'PASS_INSTALLED','root':str(ROOT),'default_boot_enabled':True,
            'worker_sha256':WORKER_SHA,'model_sha256':MODEL_SHA,'assets_files':len(installed),
            'assets_bytes':sum(row['bytes'] for row in installed),'readiness':ready,
            'website_or_tunnel_restarted':False,'model_copied_for_backup':False},ensure_ascii=False),flush=True)
    except BaseException:
        if not first and transaction.get('backup_ready'):restore_backup(transaction,sources)
        elif not first and transaction['was_started']:
            # No program replace occurs before the bounded backup commits.
            call('rc-service','--nodeps','dior-voice','start',check=False)
        elif first:
            stop_voice()
        # First-install immutable model/TTS moves and marker remain for a
        # hash-qualified resume; user settings and microphone data are not touched.
        raise

if __name__=='__main__':main()