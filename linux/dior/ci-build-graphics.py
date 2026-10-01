#!/usr/bin/env python3
"""Build isolated armv7 legacy KGSL graphics; never install or flash a phone."""
import configparser
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

HERE=Path(__file__).resolve().parent
REPO=HERE.parents[1]
spec=importlib.util.spec_from_file_location('dior_ci',HERE/'ci-build-image.py')
CI=importlib.util.module_from_spec(spec)
spec.loader.exec_module(CI)

def build():
    if os.environ.get('GITHUB_ACTIONS')!='true' or sys.platform!='linux' or os.geteuid()==0:
        raise RuntimeError('Run as ordinary user on a disposable GitHub Linux runner')
    state=Path(os.environ['RUNNER_TEMP']).resolve()/'dior-graphics-only'
    if state.exists() or state==REPO or REPO in state.parents:
        raise RuntimeError('Requires a fresh external build directory')
    state.mkdir()
    output=state/'artifact'
    output.mkdir()
    source_sha=CI.run(['git','-C',str(REPO),'rev-parse','HEAD'],capture=True)
    pmb_sha=CI.checkout('https://gitlab.postmarketos.org/postmarketOS/pmbootstrap.git',
                       '39e9c17c1439b25f7aced54e03f19b0515cdb029',state/'pmbootstrap')
    aport_sha=CI.checkout('https://gitlab.postmarketos.org/postmarketOS/pmaports.git',
                         '07baef3332c46bd6c7cc3293b87ef5104fc56f5d',state/'pmaports')
    snapshot=state/'snapshot'
    shutil.copytree(HERE/'pmaports-snapshot',snapshot)
    CI.run(['sh',str(snapshot/'hydrate-snapshot.sh')])
    CI.seed_missing_aports(snapshot,state/'pmaports')
    target=state/'pmaports/main/dior-graphics'
    if target.exists():
        raise RuntimeError('Unexpected upstream graphics aport')
    shutil.copytree(HERE/'graphics-legacy-apk',target)
    cfg=configparser.ConfigParser(interpolation=None)
    cfg['pmbootstrap']={
        'aports':str(state/'pmaports'),'work':str(state/'work'),
        'device':'xiaomi-dior','ui':'console','service_manager':'openrc',
        'user':'dior','hostname':'dior-flowboard','is_default_channel':'False',
        'ssh_keys':'False','ui_extras':'False','timezone':'Asia/Shanghai',
        'build_default_device_arch':'True','boot_size':'512','extra_space':'0'}
    cfg['providers']={}
    with (state/'pmbootstrap_v3.cfg').open('w',encoding='utf-8') as stream:
        cfg.write(stream)
    pmb=lambda *args,**kwargs:CI.run(CI.pmb_arguments(list(args),state),**kwargs)
    try:
        pmb('init',input_text='\n'*80,timeout=600)
        pmb('build','dior-graphics')
        files=list((state/'work/packages').glob('*/armv7/dior-graphics-17.3.9-r0.apk'))
        if len(files)!=1:
            raise RuntimeError('Expected one armv7 isolated graphics package')
        package=files[0]
        shutil.copy2(package,output/package.name)
        manifest={'source_commit':source_sha,'pmbootstrap_commit':pmb_sha,'pmaports_commit':aport_sha,
                  'package':package.name,'package_sha256':CI.sha256(package),
                  'install_prefix':'/opt/dior-graphics','kernel_source_changed':False,
                  'physical_gpu_render_verified':False}
        (output/'GRAPHICS-BUILD-VERIFICATION.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
        (output/'SHA256SUMS').write_text(''.join(CI.sha256(p)+'  '+p.name+'\n'
            for p in sorted(output.iterdir()) if p.is_file() and p.name!='SHA256SUMS'),encoding='ascii')
        print(json.dumps(manifest,indent=2),flush=True)
    finally:
        pmb('shutdown')

if __name__=='__main__':
    build()
