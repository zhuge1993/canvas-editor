#!/usr/bin/env python3
"""Fetch pinned official clients; never install, configure, or start a tunnel."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import struct
import subprocess
import tarfile
import time
import urllib.error
import urllib.request
import zipfile


def download(item, destination):
    if not item["url"].startswith("https://github.com/"):
        raise ValueError("Only pinned official HTTPS release assets are allowed")
    expected = item["sha256"]
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == expected:
        return destination.read_bytes()
    request = urllib.request.Request(item["url"], headers={"User-Agent": "Dior-FlowBoard-client-verifier"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                data = response.read(100 * 1024 * 1024)
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
            time.sleep(2)
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Release SHA-256 mismatch: {destination.name}")
    temporary = destination.with_suffix(destination.suffix + ".part")
    temporary.write_bytes(data)
    temporary.replace(destination)
    return data


def elf_info(data):
    if data[:7] != b"\x7fELF\x01\x01\x01":
        raise ValueError("Client must be an ELF32 little-endian executable")
    machine = struct.unpack_from("<H", data, 18)[0]
    if machine != 40:
        raise ValueError("Client is not ARM")
    phoff = struct.unpack_from("<I", data, 28)[0]
    phentsize, phnum = struct.unpack_from("<HH", data, 42)
    types = [struct.unpack_from("<I", data, phoff + index * phentsize)[0] for index in range(phnum)]
    if 3 in types:
        raise ValueError("Client requires a dynamic loader; not verified for musl")
    return {"format": "ELF32", "endian": "little", "machine": "ARM", "dynamic_interpreter": False}


def extract_frp(data, archive_kind, output, windows=False):
    suffix = ".exe" if windows else ""
    names = ("frpc" + suffix, "frps" + suffix)
    if archive_kind == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = {Path(item.filename).name: item for item in archive.infolist()
                       if not item.is_dir() and Path(item.filename).name in names}
            if set(members) != set(names):
                raise ValueError("frp archive has unexpected client/server contents")
            for name, member in members.items():
                (output / name).write_bytes(archive.read(member))
    else:
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            members = {Path(item.name).name: item for item in archive.getmembers()
                       if item.isfile() and Path(item.name).name in names}
            if set(members) != set(names):
                raise ValueError("frp archive has unexpected client/server contents")
            for name, member in members.items():
                with archive.extractfile(member) as stream:
                    (output / name).write_bytes(stream.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--windows-check-tools", action="store_true")
    parser.add_argument("--provider", choices=("all", "cloudflared", "frp"), default="all")
    args = parser.parse_args()
    pins = json.loads(Path(__file__).with_name("clients.json").read_text(encoding="utf-8"))
    if args.provider != "all":
        pins = {args.provider: pins[args.provider]}
    args.output.mkdir(parents=True, exist_ok=True)
    arm = args.output / "linux-armhf"
    arm.mkdir(exist_ok=True)
    report = {"release_checksum_verification": "sha256_from_official_release_metadata",
              "signature_verification": "not_performed", "native_dior_execution": "not_performed", "clients": {}}
    for name, pin in pins.items():
        item = pin["linux_armhf"]
        asset = args.output / item["url"].rsplit("/", 1)[-1]
        data = download(item, asset)
        if name == "cloudflared":
            executable = arm / "cloudflared"
            executable.write_bytes(data)
        else:
            extract_frp(data, "tar", arm)
            executable = arm / "frpc"
        info = elf_info(executable.read_bytes())
        info.update(version=pin["version"], asset_sha256=item["sha256"],
                    executable_sha256=hashlib.sha256(executable.read_bytes()).hexdigest(), release=pin["release"])
        go = shutil.which("go")
        if go:
            result = subprocess.run([go, "version", "-m", str(executable)], capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise ValueError("Cannot inspect official client Go build information")
            for key, expected in (("CGO_ENABLED", "0"), ("GOARCH", "arm"), ("GOOS", "linux"), ("GOARM", "7")):
                if not re.search(rf"^\s*build\s+{key}={expected}\s*$", result.stdout, re.MULTILINE):
                    raise ValueError(f"Unexpected official ARM client build setting: {key}")
            info["go_build_info"] = result.stdout
        report["clients"][name] = info
    if args.windows_check_tools:
        windows = args.output / "windows-amd64"
        windows.mkdir(exist_ok=True)
        for name, pin in pins.items():
            item = pin["windows_amd64"]
            data = download(item, args.output / item["url"].rsplit("/", 1)[-1])
            if name == "cloudflared":
                (windows / "cloudflared.exe").write_bytes(data)
            else:
                extract_frp(data, "zip", windows, windows=True)
    (args.output / "CLIENT-VERIFICATION.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({name: {k: value for k, value in item.items() if k != "go_build_info"}
                      for name, item in report["clients"].items()}, indent=2))


if __name__ == "__main__":
    main()
