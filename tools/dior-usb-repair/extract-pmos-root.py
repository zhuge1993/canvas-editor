#!/usr/bin/env python3
"""Extract the pmOS_root ext filesystem from a raw GPT postmarketOS image.

This is intentionally generic: it reads and CRC-validates the GPT, locates the
single partition whose GPT name is exactly "pmOS_root", copies that partition,
and verifies the copied filesystem's ext superblock identity. It never guesses
hard-coded offsets from an older build.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct
import uuid
import zlib

SECTOR_SIZE = 512
GPT_SIGNATURE = b"EFI PART"
EXT_MAGIC = 0xEF53
MAX_FASTBOOT_DOWNLOAD = 838_860_800


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def read_gpt(source: Path) -> tuple[int, int, str]:
    size = source.stat().st_size
    if size < 2 * SECTOR_SIZE:
        raise ValueError("source image is too small for GPT")
    with source.open("rb") as f:
        f.seek(SECTOR_SIZE)
        header_sector = f.read(SECTOR_SIZE)
        if header_sector[:8] != GPT_SIGNATURE:
            raise ValueError("source image has no primary GPT header")
        header_size = struct.unpack_from("<I", header_sector, 12)[0]
        if not 92 <= header_size <= SECTOR_SIZE:
            raise ValueError("invalid GPT header size")
        expected_header_crc = struct.unpack_from("<I", header_sector, 16)[0]
        header = bytearray(header_sector[:header_size])
        struct.pack_into("<I", header, 16, 0)
        if zlib.crc32(header) & 0xFFFFFFFF != expected_header_crc:
            raise ValueError("GPT header CRC mismatch")
        entries_lba = struct.unpack_from("<Q", header_sector, 72)[0]
        entries_count = struct.unpack_from("<I", header_sector, 80)[0]
        entry_size = struct.unpack_from("<I", header_sector, 84)[0]
        expected_entries_crc = struct.unpack_from("<I", header_sector, 88)[0]
        if not 1 <= entries_count <= 4096 or not 128 <= entry_size <= 1024 or entry_size % 8:
            raise ValueError("invalid GPT partition entry geometry")
        entries_bytes = entries_count * entry_size
        entries_offset = entries_lba * SECTOR_SIZE
        if entries_offset + entries_bytes > size:
            raise ValueError("GPT partition entry array extends past source image")
        f.seek(entries_offset)
        entries = f.read(entries_bytes)
        if len(entries) != entries_bytes:
            raise ValueError("truncated GPT partition entry array")
        if zlib.crc32(entries) & 0xFFFFFFFF != expected_entries_crc:
            raise ValueError("GPT partition entry CRC mismatch")

    matches: list[tuple[int, int, str]] = []
    for i in range(entries_count):
        entry = entries[i * entry_size:(i + 1) * entry_size]
        if entry[:16] == b"\0" * 16:
            continue
        first_lba, last_lba = struct.unpack_from("<QQ", entry, 32)
        if first_lba == 0 or last_lba < first_lba:
            raise ValueError("invalid GPT partition LBA range")
        name_raw = entry[56:min(entry_size, 128)]
        name = name_raw.decode("utf-16le", errors="strict").split("\0", 1)[0]
        if name == "pmOS_root":
            matches.append((first_lba, last_lba, name))
    if len(matches) != 1:
        raise ValueError(f"expected exactly one pmOS_root GPT partition, found {len(matches)}")
    first_lba, last_lba, name = matches[0]
    offset = first_lba * SECTOR_SIZE
    length = (last_lba - first_lba + 1) * SECTOR_SIZE
    if offset + length > size:
        raise ValueError("pmOS_root partition extends past source image")
    return offset, length, name


def inspect_ext(path: Path) -> dict[str, object]:
    with path.open("rb") as f:
        f.seek(1024)
        sb = f.read(1024)
    if len(sb) != 1024 or struct.unpack_from("<H", sb, 0x38)[0] != EXT_MAGIC:
        raise ValueError("extracted pmOS_root is not an ext filesystem")
    fs_uuid = str(uuid.UUID(bytes=sb[0x68:0x78]))
    label = sb[0x78:0x88].split(b"\0", 1)[0].decode("ascii", errors="strict")
    blocks_lo = struct.unpack_from("<I", sb, 0x04)[0]
    log_block_size = struct.unpack_from("<I", sb, 0x18)[0]
    block_size = 1024 << log_block_size
    return {
        "filesystem_uuid": fs_uuid,
        "filesystem_label": label,
        "filesystem_bytes_low32": blocks_lo * block_size,
    }


def extract(source: Path, output: Path) -> dict[str, object]:
    offset, length, name = read_gpt(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, output.open("wb") as dst:
        src.seek(offset)
        left = length
        while left:
            chunk = src.read(min(left, 4 * 1024 * 1024))
            if not chunk:
                raise ValueError("source image truncated while extracting pmOS_root")
            dst.write(chunk)
            left -= len(chunk)
    if output.stat().st_size != length:
        raise ValueError("extracted pmOS_root size mismatch")
    ext = inspect_ext(output)
    if ext["filesystem_label"] != "pmOS_root":
        raise ValueError("extracted filesystem label is not pmOS_root")
    return {
        "source_image": source.name,
        "source_bytes": source.stat().st_size,
        "source_sha256": sha256(source),
        "partition_name": name,
        "root_offset_bytes": offset,
        "root_partition_bytes": length,
        "output_file": output.name,
        "output_bytes": output.stat().st_size,
        "output_sha256": sha256(output),
        "max_fastboot_download_bytes": MAX_FASTBOOT_DOWNLOAD,
        "fits_fastboot_max_download": output.stat().st_size <= MAX_FASTBOOT_DOWNLOAD,
        **ext,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("output")
    ap.add_argument("--verification")
    args = ap.parse_args()
    result = extract(Path(args.source), Path(args.output))
    payload = json.dumps(result, indent=2) + "\n"
    if args.verification:
        Path(args.verification).write_text(payload, encoding="utf-8")
    print(payload, end="")
    if not result["fits_fastboot_max_download"]:
        raise SystemExit("extracted pmOS_root exceeds the verified dior fastboot max-download size")


if __name__ == "__main__":
    main()
