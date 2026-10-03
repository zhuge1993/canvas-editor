#!/usr/bin/env python3
"""Isolated Qwen candidate experiment; restore the existing inference service."""
import argparse,ctypes,hashlib,importlib.util,json,os,queue,resource,signal,subprocess,threading,time
from pathlib import Path

def thermal():
    values=[]
    for p in Path('/sys/class/thermal').glob('thermal_zone*/temp'):
        try:
            v=float(p.read_text().strip());v=v/1000 if abs(v)>200 else v
            if -20<=v<=150:values.append(v)
        except (ValueError,OSError):pass
    return max(values) if values else None

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True);parser.add_argument('--report',required=True)
    parser.add_argument('--threads',type=int,choices=(2,3),default=3)
    parser.add_argument('--cache',action='store_true');parser.add_argument('--dialog',action='store_true')
    parser.add_argument('--diag',action='store_true');args=parser.parse_args()
    root=Path(args.root);report=Path(args.report)
    data={'status':'RUNNING','gpu_used':False,'microphone_used':False,'skills_executed':False,'cases':[],'threads':args.threads}
    process=None;stopped=False;messages=queue.Queue(maxsize=256);errors=bytearray();cancel_stop=threading.Event()
    def save():report.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    def emit(event,**fields):print(json.dumps({'event':event,**fields},ensure_ascii=False),flush=True)
    def recv(deadline):
        while time.monotonic()<deadline:
            try:
                value=messages.get(timeout=.1)
                if isinstance(value,Exception):raise value
                return value
            except queue.Empty:
                if process.poll() is not None:raise RuntimeError('native_exit_'+str(process.returncode))
        raise TimeoutError('native_response_timeout')
    def send(value):process.stdin.write((json.dumps(value,ensure_ascii=False)+'\n').encode());process.stdin.flush()
    try:
        assert os.getuid()==0
        model=root/'Qwen3.5-0.8B-Q4_0.gguf';binary=root/('qwen35-worker-samplingdiag' if args.diag else 'qwen35-worker-dialog' if args.dialog else 'qwen35-worker-cache' if args.cache else 'qwen35-worker')
        manifest=json.loads((root/'MODEL.json').read_text())
        assert model.stat().st_size==563036064
        digest=hashlib.sha256()
        with model.open('rb') as stream:
            for block in iter(lambda:stream.read(1048576),b''):digest.update(block)
        assert digest.hexdigest()==manifest['sha256']=='57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf'
        data['model_sha256']=digest.hexdigest();data['binary_sha256']=hashlib.sha256(binary.read_bytes()).hexdigest()
        # This is the existing verified private Bionic environment, no GPU handle.
        spec=importlib.util.spec_from_file_location('transport','/opt/dior-android/run-native.py')
        transport=importlib.util.module_from_spec(spec);spec.loader.exec_module(transport)
        unused,private,fd=transport.runtime_environment('opencl',[])
        env={k:private[k] for k in ('LD_LIBRARY_PATH','ANDROID_PROPERTY_WORKSPACE')}
        env.update(PATH='/usr/bin:/bin',LANG='C.UTF-8')
        stopped=True;subprocess.run(['rc-service','--nodeps','dior-inference','stop'],check=True)
        cool_until=time.monotonic()+120
        while thermal() is not None and thermal()>42 and time.monotonic()<cool_until:time.sleep(1)
        assert thermal() is not None and thermal()<=45,'thermal_admission'
        parent=os.getpid()
        def limits():
            resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_AS,(1400*1024*1024,)*2)
            resource.setrlimit(resource.RLIMIT_NOFILE,(64,64))
            os.setgroups([109,111]);os.setgid(111);os.setuid(108)
            libc=ctypes.CDLL(None,use_errno=True)
            if libc.prctl(1,signal.SIGTERM,0,0,0)!=0:raise OSError('pdeathsig')
            if os.getppid()!=parent:os.kill(os.getpid(),signal.SIGTERM)
        begin=time.monotonic()
        try:process=subprocess.Popen([str(binary),str(model),str(args.threads)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,pass_fds=(fd,),env=env,start_new_session=True,preexec_fn=limits,bufsize=0)
        finally:os.close(fd)
        def output():
            try:
                while True:
                    line=process.stdout.readline(32769)
                    if not line:return
                    if len(line)>32768 or not line.endswith(b'\n'):raise ValueError('native_frame_limit')
                    messages.put_nowait(json.loads(line))
            except Exception as error:messages.put_nowait(error)
        def stderr():
            for block in iter(lambda:process.stderr.read(1024),b''):
                errors.extend(block)
                if len(errors)>16384:del errors[:-16384]
        threading.Thread(target=output,daemon=True).start();threading.Thread(target=stderr,daemon=True).start()
        ready=recv(time.monotonic()+120);assert ready.get('type')=='ready',str(ready)
        data['ready']=ready;data['load_seconds']=time.monotonic()-begin;emit('ready',ready=ready,load_seconds=data['load_seconds']);save()
        system={'role':'system','content':'你是这部手机上的中文语音助手，名字叫二狗。自然、准确地回答用户，用一两句简短中文。不编造已经执行的操作。'}
        cases=[
            ('identity',[system,{'role':'user','content':'你叫什么名字？'}]),
            ('followup',[system,{'role':'user','content':'我叫小林，请记住我的称呼。'},{'role':'assistant','content':'好的，小林。'},{'role':'user','content':'我刚才让你怎么称呼我？'}]),
            ('conversation',[system,{'role':'user','content':'今天有点累，鼓励我一下吧。'}]),
        ]
        if args.cache or args.dialog or args.diag:
            # Use the actual controller's system identity, then compare the
            # same model/template both with and without checkpoint restoration.
            system={'role':'system','content':'你是手机上的中文语音助手。自然、简洁地交流，不声称已执行未经工具确认的操作。\n当前助手名和唤醒词：二狗。'}
            cases=[
                ('verify_state',[{'role':'system','content':'你叫二狗，简短中文回答。'},{'role':'user','content':'你好'}]),
                ('plain_identity',[system,{'role':'user','content':'你叫什么名字？'}]),
                ('cold_identity',[system,{'role':'user','content':'你叫什么名字？'}]),
                ('warm_identity',[system,{'role':'user','content':'你叫什么名字？'}]),
                ('followup',[system,{'role':'user','content':'我叫小林，请记住我的称呼。'},{'role':'assistant','content':'好的，小林。'},{'role':'user','content':'我刚才让你怎么称呼我？'}]),
            ]
        dialog_history=[]
        if args.dialog:
            cases=[('verify_state',[{'role':'system','content':'你叫二狗，简短中文回答。'},{'role':'user','content':'你好'}]),
                   ('identity',[system,{'role':'user','content':'你叫什么名字？'}]),
                   ('set_name',None),('web_interleave',[{'role':'system','content':'你是FlowBoard网站助手，简短中文回答。'},{'role':'user','content':'你好'}]),
                   ('recall_name',None)]
        if args.diag:
            cases=[('verify_state',[system,{'role':'user','content':'你叫什么名字？'},{'role':'assistant','content':'你好，我是二狗。'},{'role':'user','content':'请叫我小林。'}]),
                   ('identity',[system,{'role':'user','content':'你叫什么名字？'}]),('set_name',None),('recall_name',None)]
        for name,context in cases:
            if (args.dialog or args.diag) and name in ('set_name','recall_name'):
                context=[system]+list(dialog_history)+[{'role':'user','content':'请叫我小林。' if name=='set_name' else '我叫什么名字？'}]
            cool_until=time.monotonic()+90
            while thermal() is not None and thermal()>42 and time.monotonic()<cool_until:time.sleep(1)
            if thermal() is None or thermal()>45:raise RuntimeError('thermal_admission')
            started=time.monotonic();deadline=started+125;peak=thermal();sent_cancel=False
            request={'op':'generate','id':name,'messages':context,'max_tokens':1 if name in ('verify_state','web_interleave') else 96,'deadline_ms':120000}
            if args.cache or args.dialog or args.diag:request.update(use_prefix_cache=name not in ('plain_identity','web_interleave'),verify_cache=name=='verify_state')
            if args.diag:
                request.update(sampling='greedy' if name=='verify_state' else 'qwen_recommended',seed=1234)
                if name=='verify_state':request['verify_cooldown']=True
            send(request)
            while True:
                now_temp=thermal();peak=max(peak,now_temp) if now_temp is not None else peak
                if now_temp is not None and now_temp>65 and not sent_cancel:
                    send({'op':'cancel','id':name});sent_cancel=True
                try:value=recv(min(deadline,time.monotonic()+.25))
                except TimeoutError:
                    if time.monotonic()>=deadline:raise
                    continue
                if value.get('type')=='error':raise RuntimeError(str(value))
                if value.get('id')==name and value.get('type')=='done':break
            row={'name':name,'messages':context,'native':value,'wall_seconds':time.monotonic()-started,'peak_thermal_c':peak,'thermal_cancel':sent_cancel}
            data['cases'].append(row);save();emit('case',**row)
            if sent_cancel:break
            if (args.dialog or args.diag) and name in ('identity','set_name','recall_name') and value.get('status')=='complete':
                dialog_history.extend([context[-1],{'role':'assistant','content':value['text']}])
                data['canonical_history_scope']='synthetic full-playback receipt for native benchmark; not actual microphone or speaker test'
        if args.dialog or args.diag:
            send({'op':'clear_cache','id':'clear_after_probe'})
            while True:
                cleared=recv(time.monotonic()+3)
                if cleared.get('id')=='clear_after_probe':break
            assert cleared.get('type')=='cache_cleared' and cleared.get('checkpoint_bytes')==0
            data['cache_clear']=cleared
        data['status']='PASS_GENERATION_ONLY' if len(data['cases'])==len(cases) and all(x['native'].get('status')=='complete' and x['native'].get('text') for x in data['cases']) else 'PARTIAL'
    except Exception as error:data['status']='FAIL';data['error']=type(error).__name__+': '+str(error);emit('error',error=data['error'])
    finally:
        if process:
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGTERM)
                try:process.wait(timeout=3)
                except subprocess.TimeoutExpired:os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=3)
            data['native_exit']=process.returncode
        data['native_stderr_tail']=errors.decode('utf8','replace')
        if stopped:
            restore=subprocess.run(['rc-service','--nodeps','dior-inference','start'])
            data['old_service_restored']=restore.returncode==0
        save();emit('finished',status=data['status'],old_service_restored=data.get('old_service_restored'))
    return 0 if data['status']=='PASS_GENERATION_ONLY' else 1

if __name__=='__main__':raise SystemExit(main())
