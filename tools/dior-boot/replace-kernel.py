#!/usr/bin/env python3
"""Replace only the kernel in a live dior boot backup; never accesses USB."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

BOOT_LIMIT = 16 * 1024 * 1024


def align(value: int, page: int) -> int:
    return (value + page - 1) // page * page


def sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def parse_boot(raw: bytes) -> tuple[int, list[bytes]]:
    if len(raw) < 608 or raw[:8] != b"ANDROID!":
        raise ValueError("expected an Android legacy boot image")
    fields = struct.unpack_from("<10I", raw, 8)
    page = fields[7]
    if page < 2048 or page > 65536 or page & (page - 1) or fields[9] != 0:
        raise ValueError("unsupported legacy boot header")
    sizes = [fields[0], fields[2], fields[4], fields[8]]
    if not sizes[0] or not sizes[1] or not sizes[3]:
        raise ValueError("kernel, ramdisk and QCDT must be present")
    offset = page
    blobs = []
    for size in sizes:
        if offset + size > len(raw):
            raise ValueError("boot component exceeds input")
        blobs.append(raw[offset:offset + size])
        end = offset + size
        next_offset = offset + align(size, page)
        if any(raw[end:min(next_offset, len(raw))]):
            raise ValueError("nonzero component padding")
        offset = next_offset
    if any(raw[offset:]):
        raise ValueError("nonzero boot trailer; refusing to discard it")
    if blobs[3][:4] != b"QCDT" or b"Qualcomm MSM 8926 H3-LTE" not in blobs[3]:
        raise ValueError("base boot is not dior H3-LTE")
    if raw[576:596] != boot_id(blobs):
        raise ValueError("boot component SHA1 ID mismatch")
    return page, blobs


def boot_id(blobs: list[bytes]) -> bytes:
    digest = hashlib.sha1()
    for blob in blobs:
        digest.update(blob)
        digest.update(struct.pack("<I", len(blob)))
    return digest.digest()


def replace(source: Path, kernel: Path, output: Path, verification: Path) -> dict:
    paths = [source, kernel, output, verification]
    for index, path in enumerate(paths):
        for other in paths[:index]:
            if path.resolve() == other.resolve() or (
                    path.exists() and other.exists() and path.samefile(other)):
                raise ValueError("input/output paths must be distinct")
    original = source.read_bytes()
    page, old = parse_boot(original)
    new_kernel = kernel.read_bytes()
    if len(new_kernel) < 48 or struct.unpack_from("<I", new_kernel, 36)[0] != 0x016F2818:
        raise ValueError("replacement is not an ARM zImage")
    start, end = struct.unpack_from("<II", new_kernel, 40)
    if end <= start or end - start != len(new_kernel):
        raise ValueError("zImage size mismatch or appended payload")
    if new_kernel == old[0]:
        raise ValueError("replacement kernel equals original")
    blobs = [new_kernel, *old[1:]]
    result = bytearray(original[:page])
    struct.pack_into("<I", result, 8, len(new_kernel))
    result[576:608] = boot_id(blobs) + bytes(12)
    for blob in blobs:
        result.extend(blob)
        result.extend(bytes(align(len(blob), page) - len(blob)))
    if len(result) > BOOT_LIMIT:
        raise ValueError("replacement boot exceeds the 16 MiB partition")
    mutable = set(range(8, 12)) | set(range(576, 608))
    if any(result[i] != original[i] for i in range(page) if i not in mutable):
        raise ValueError("boot header changed outside kernel_size/id")
    _, checked = parse_boot(result)
    if checked != blobs or checked[1:] != old[1:]:
        raise ValueError("component preservation check failed")
    info = {
        "method": "replace compiled ARM kernel in live boot backup",
        "source_boot_sha256": sha256(original),
        "boot_sha256": sha256(result),
        "original_kernel_sha256": sha256(old[0]),
        "kernel_sha256": sha256(new_kernel),
        "ramdisk_sha256": sha256(old[1]),
        "dtb_sha256": sha256(old[3]),
        "ramdisk_byte_identical": True,
        "dtb_byte_identical": True,
        "second_stage_byte_identical": True,
        "addresses_cmdline_header_preserved": True,
        "original_boot_bytes": len(original),
        "boot_bytes": len(result),
        "partition_limit_bytes": BOOT_LIMIT,
        "legacy_boot_sha1": boot_id(blobs).hex(),
        "physical_boot_verified": False,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(result)
    verification.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return info


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("kernel", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--verification", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(replace(args.source, args.kernel, args.output, args.verification), indent=2))


if __name__ == "__main__":
    main()
