"""Fetch immutable upstream code and verified weights; no model inference."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
MANIFEST = json.loads((HERE / 'manifest.json').read_text(encoding='utf-8'))


def verify(file, expected):
    file = Path(file)
    if file.stat().st_size != expected['bytes']:
        raise ValueError(f'{file.name}: unexpected byte count')
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    if digest.hexdigest() != expected['sha256']:
        raise ValueError(f'{file.name}: SHA256 mismatch')


def prepare(root):
    from huggingface_hub import hf_hub_download, snapshot_download
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    source = root / 'upstream'
    if not source.exists():
        subprocess.run(['git', 'clone', '--no-checkout', MANIFEST['source'], str(source)], check=True)
    subprocess.run(['git', '-C', str(source), 'checkout', '--detach', MANIFEST['sourceRevision']], check=True)
    revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
    if revision != MANIFEST['sourceRevision']:
        raise ValueError('upstream revision mismatch')
    assets = root / 'assets'
    for name, expected in MANIFEST['files'].items():
        downloaded = hf_hub_download(MANIFEST['weightsRepo'], name, revision=MANIFEST['weightsRevision'], local_dir=assets)
        verify(downloaded, expected)
        print(f'{name}: release hash verified', flush=True)
    snapshot_download(MANIFEST['weightsRepo'], revision=MANIFEST['weightsRevision'], local_dir=assets,
                      allow_patterns=['config.json', 'tokenizer.json', 'tokenizer_config.json', 'vocab.json', 'merges.txt', 'special_tokens_map.json'])
    print(json.dumps({'status': 'assets_ready', 'model': MANIFEST['model'], 'root': str(root), 'phoneQualified': False}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE / 'runtime')
    prepare(parser.parse_args().root)
