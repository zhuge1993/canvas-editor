#!/usr/bin/env python3
"""Package only these non-secret service files for a phone-side installation."""
import argparse
import gzip
import hashlib
import io
from pathlib import Path
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    directory = Path(__file__).parent
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        root = tarfile.TarInfo("always-on-tunnel")
        root.type, root.mode = tarfile.DIRTYPE, 0o755
        archive.addfile(root)
        for item in sorted(directory.iterdir()):
            if not item.is_file() or item.name.endswith((".pyc", ".tmp", ".tar.gz")):
                continue
            data = item.read_bytes()
            data.decode("utf-8")
            if data.startswith(b"\xef\xbb\xbf") or b"\r\n" in data:
                raise ValueError(f"Service source must be UTF-8 without BOM and LF: {item.name}")
            info = tarfile.TarInfo("always-on-tunnel/" + item.name)
            info.size = len(data)
            info.mode = 0o755 if item.name.endswith((".sh", ".py", ".initd")) or item.name == "dior-tunnel-run" else 0o644
            archive.addfile(info, io.BytesIO(data))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(gzip.compress(buffer.getvalue(), mtime=0))
    print(f"{hashlib.sha256(args.output.read_bytes()).hexdigest()}  {args.output}  ({args.output.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
