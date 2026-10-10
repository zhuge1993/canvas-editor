"""Remove the retired voice assistant installation; keep website and shared ASR."""
import argparse
from pathlib import Path
import os
import shutil
import subprocess
import pwd
import grp

SERVICES = ('dior-voice', 'dior-voice-candidate', 'dior-inference')
DIRECTORIES = ('/opt/dior-voice', '/opt/dior-voice.previous', '/opt/dior-voice-candidate', '/opt/dior-inference', '/var/lib/dior-voice', '/var/lib/dior-inference', '/run/dior-voice', '/run/dior-voice-candidate', '/run/dior-inference')
FILES = tuple(f'/etc/init.d/{name}' for name in SERVICES) + tuple(f'/etc/conf.d/{name}' for name in SERVICES) + ('/run/dior-voice-supervise.pid', '/run/dior-inference-supervise.pid')


def inspect(root=Path('/')):
    root = root.resolve()
    targets = []
    for relative in DIRECTORIES + FILES:
        target = root / relative.lstrip('/')
        # No directory or parent symlink may turn this into deletion elsewhere.
        if target.is_symlink() or not target.resolve().is_relative_to(root):
            raise ValueError(f'unsafe installation path: {relative}')
        parent = target.parent
        while parent != root:
            if parent.is_symlink():
                raise ValueError(f'unsafe parent path: {relative}')
            parent = parent.parent
        if target.exists():
            targets.append(target)
    return targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='stop, disable and remove the old installation')
    args = parser.parse_args()
    targets = inspect()
    if not args.apply:
        print('Retired services:', ', '.join(SERVICES))
        print('\n'.join(str(target) for target in targets))
        return
    if os.geteuid() != 0:
        raise SystemExit('Run with root privileges on the phone.')
    for service in SERVICES:
        if Path('/etc/init.d', service).exists():
            subprocess.run(['rc-service', '--nodeps', service, 'stop'], check=True)
            subprocess.run(['rc-update', 'del', service, 'default'], check=False)
    # Disable all runlevels, including custom runlevels, even if the init script
    # was already removed. Only unlink links named for the retired services.
    for service in SERVICES:
        for link in Path('/etc/runlevels').glob(f'*/{service}'):
            if not link.is_symlink():
                raise ValueError(f'unexpected runlevel entry: {link}')
            link.unlink()
    for target in inspect():
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    for service in SERVICES:
        if Path('/etc/init.d', service).exists() or list(Path('/etc/runlevels').glob(f'*/{service}')):
            raise RuntimeError(f'{service} still installed')
    for name in SERVICES:
        try: pwd.getpwnam(name)
        except KeyError: pass
        else: subprocess.run(['deluser',name],check=True)
        try: grp.getgrnam(name)
        except KeyError: pass
        else: subprocess.run(['delgroup',name],check=True)
    print('Retired assistant stopped, disabled and removed. Website and standalone ASR were preserved.')


if __name__ == '__main__':
    main()
