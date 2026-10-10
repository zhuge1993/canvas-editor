"""Fetch pinned general ARMhf libraries; install no speech functionality."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
import urllib.request

HERE=Path(__file__).resolve().parent
PINNED=json.loads((HERE/'RUNTIME-SOURCES.json').read_text(encoding='utf-8'))
LIBRARIES={
    'ld-linux-armhf.so.3':'ld-2.31.so',
    'libc.so.6':'libc-2.31.so',
    'libm.so.6':'libm-2.31.so',
    'libdl.so.2':'libdl-2.31.so',
    'libpthread.so.0':'libpthread-2.31.so',
    'librt.so.1':'librt-2.31.so',
    'libstdc++.so.6':'libstdc++.so.6.0.28',
    'libgcc_s.so.1':'libgcc_s.so.1',
    'libonnxruntime.so':'libonnxruntime.so.1.14.1',
}


def deb_payload(data):
    if data[:8]!=b'!<arch>\n':raise ValueError('invalid Debian archive')
    offset=8
    while offset+60<=len(data):
        header=data[offset:offset+60]
        if header[58:60]!=b'`\n':raise ValueError('invalid archive header')
        size=int(header[48:58]); start=offset+60; end=start+size
        if end>len(data):raise ValueError('truncated archive')
        if header[:16].decode().strip().rstrip('/').startswith('data.tar'):
            return io.BytesIO(data[start:end])
        offset=end+(size&1)
    raise ValueError('Debian payload missing')


def prepare(root):
    root=Path(root).resolve()
    downloads=root/'downloads'; downloads.mkdir(parents=True,exist_ok=True)
    library=root/'runtime/lib'; library.mkdir(parents=True,exist_ok=True)
    collected={}
    for asset in PINNED['assets']:
        file=downloads/Path(asset['path']).name
        if not file.exists():
            temporary=file.with_suffix(file.suffix+'.download')
            total=0
            try:
                with urllib.request.urlopen(asset['url'],timeout=60) as response, temporary.open('wb') as output:
                    while block:=response.read(256*1024):
                        total+=len(block)
                        if total>asset['bytes']:raise ValueError('download exceeds pinned size')
                        output.write(block)
                temporary.replace(file)
            finally:temporary.unlink(missing_ok=True)
        data=file.read_bytes()
        if len(data)!=asset['bytes'] or hashlib.sha256(data).hexdigest()!=asset['sha256']:
            raise ValueError('pinned archive mismatch: '+file.name)
        payload=deb_payload(data) if file.suffix=='.deb' else io.BytesIO(data)
        with tarfile.open(fileobj=payload,mode='r:*') as package:
            for member in package.getmembers():
                basename=Path(member.name).name
                if not member.isfile() or basename not in LIBRARIES.values():continue
                if not 0<member.size<20*1024*1024:raise ValueError('library size outside bounds')
                with package.extractfile(member) as stream:blob=stream.read()
                if not blob.startswith(b'\x7fELF'):raise ValueError('library is not ELF')
                if basename in collected and collected[basename][0]!=blob:raise ValueError('ambiguous library')
                collected[basename]=(blob,asset['url'])
    records={}
    for alias,name in LIBRARIES.items():
        if name not in collected:raise ValueError('required library missing: '+name)
        blob,url=collected[name]
        # Retain the versioned SONAME too: the worker's DT_NEEDED references
        # libonnxruntime.so.1.14.1 even though linking uses libonnxruntime.so.
        for filename in {alias,name}:
            target=library/filename
            if target.is_symlink():raise ValueError('symlink destination rejected')
            target.write_bytes(blob);target.chmod(0o755)
            records[filename]={'source':url,'bytes':len(blob),'sha256':hashlib.sha256(blob).hexdigest()}
    (root/'runtime/provenance.json').write_text(json.dumps(records,indent=2)+'\n',encoding='utf-8')
    print('Pinned GNU and ONNX libraries prepared in private directory')


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,required=True)
    prepare(parser.parse_args().root)
