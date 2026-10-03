#!/usr/bin/env python3
"""Trim a dior Android boot image's Qualcomm QCDT to the H3-LTE DTB only.

The downstream dior boot partition is 16 MiB. pmbootstrap's master QCDT contains
many unrelated MSM8226/8926 boards and makes the otherwise valid boot image too
large. This tool preserves the compiled kernel, ramdisk, addresses and cmdline
byte-for-byte, keeps only the six selectors known to map to Xiaomi dior's
Qualcomm MSM 8926 H3-LTE DTB, updates dt_size, and recomputes the legacy Android
boot SHA-1 id.

It does not compile anything and never touches a device.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import struct

ANDROID_MAGIC = b"ANDROID!"
QCDT_MAGIC = b"QCDT"
BOOT_LIMIT = 16 * 1024 * 1024
EXPECTED_QCDT_VERSION = 2
ENTRY_WORDS = 6
ENTRY_SIZE = ENTRY_WORDS * 4
TARGET_SELECTORS = (
    (200, 12, 0, 0),
    (200, 12, 0, 65537),
    (200, 12, 0, 131072),
    (224, 12, 0, 0),
    (224, 12, 0, 65537),
    (224, 12, 0, 131072),
)
MODEL_MARKER = b"Qualcomm MSM 8926 H3-LTE"


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def align(value: int, page: int) -> int:
    return (value + page - 1) // page * page


def parse_boot(raw: bytes) -> dict:
    if len(raw) < 608 or raw[:8] != ANDROID_MAGIC:
        raise ValueError("not an Android legacy boot image")
    values = struct.unpack_from("<10I", raw, 8)
    kernel_size, kernel_addr, ramdisk_size, ramdisk_addr, second_size, second_addr, tags_addr, page_size, dt_size, unused = values
    if page_size < 512 or page_size > 65536 or page_size & (page_size - 1):
        raise ValueError("invalid Android boot page size")
    kernel_offset = page_size
    ramdisk_offset = kernel_offset + align(kernel_size, page_size)
    second_offset = ramdisk_offset + align(ramdisk_size, page_size)
    dt_offset = second_offset + align(second_size, page_size)
    if dt_size <= 0 or dt_offset + dt_size != len(raw):
        raise ValueError("unexpected boot layout or trailing bytes")
    return {
        "kernel_size": kernel_size, "kernel_addr": kernel_addr,
        "ramdisk_size": ramdisk_size, "ramdisk_addr": ramdisk_addr,
        "second_size": second_size, "second_addr": second_addr,
        "tags_addr": tags_addr, "page_size": page_size, "dt_size": dt_size,
        "unused": unused, "kernel_offset": kernel_offset,
        "ramdisk_offset": ramdisk_offset, "second_offset": second_offset,
        "dt_offset": dt_offset,
    }


def parse_qcdt(qcdt: bytes) -> tuple[int, list[tuple[int, ...]]]:
    if len(qcdt) < 12 or qcdt[:4] != QCDT_MAGIC:
        raise ValueError("boot DT payload is not QCDT")
    version, count = struct.unpack_from("<II", qcdt, 4)
    if version != EXPECTED_QCDT_VERSION:
        raise ValueError(f"unsupported QCDT version: {version}")
    table_end = 12 + count * ENTRY_SIZE
    if count <= 0 or table_end + 4 > len(qcdt):
        raise ValueError("invalid QCDT table size")
    entries = [
        struct.unpack_from("<6I", qcdt, 12 + i * ENTRY_SIZE)
        for i in range(count)
    ]
    for entry in entries:
        offset, size = entry[4], entry[5]
        if size <= 0 or offset < table_end or offset + size > len(qcdt):
            raise ValueError("QCDT entry points outside payload")
    return version, entries


def make_trimmed_qcdt(qcdt: bytes, page_size: int) -> tuple[bytes, dict]:
    version, entries = parse_qcdt(qcdt)
    wanted = [entry for entry in entries if tuple(entry[:4]) in TARGET_SELECTORS]
    if len(wanted) != len(TARGET_SELECTORS):
        found = [tuple(entry[:4]) for entry in wanted]
        raise ValueError(f"expected six dior H3-LTE selectors, found {found}")
    if {tuple(entry[:4]) for entry in wanted} != set(TARGET_SELECTORS):
        raise ValueError("dior selector set mismatch")
    blobs = {(entry[4], entry[5]) for entry in wanted}
    if len(blobs) != 1:
        raise ValueError("dior selectors do not reference one common DTB")
    old_offset, dtb_size = next(iter(blobs))
    dtb = qcdt[old_offset:old_offset + dtb_size]
    if MODEL_MARKER not in dtb:
        raise ValueError("selected DTB is not Qualcomm MSM 8926 H3-LTE")

    header_bytes = 12 + len(wanted) * ENTRY_SIZE + 4
    new_offset = align(header_bytes, page_size)
    out = bytearray()
    out += QCDT_MAGIC
    out += struct.pack("<II", version, len(wanted))
    for entry in wanted:
        out += struct.pack("<6I", *entry[:4], new_offset, dtb_size)
    out += struct.pack("<I", 0)
    out += bytes(new_offset - len(out))
    out += dtb

    info = {
        "old_qcdt_bytes": len(qcdt),
        "new_qcdt_bytes": len(out),
        "old_qcdt_entries": len(entries),
        "new_qcdt_entries": len(wanted),
        "old_unique_dtbs": len({(entry[4], entry[5]) for entry in entries}),
        "new_unique_dtbs": 1,
        "retained_model": MODEL_MARKER.decode(),
        "retained_selectors": [list(entry[:4]) for entry in wanted],
        "retained_dtb_padded_bytes": dtb_size,
        "retained_dtb_sha256": sha256(dtb),
        "old_dtb_offset": old_offset,
        "new_dtb_offset": new_offset,
    }
    return bytes(out), info


def legacy_boot_id(kernel: bytes, ramdisk: bytes, second: bytes, dt: bytes) -> bytes:
    digest = hashlib.sha1()
    for blob in (kernel, ramdisk, second, dt):
        digest.update(blob)
        digest.update(struct.pack("<I", len(blob)))
    return digest.digest()


def trim(source: Path, output: Path, verification: Path | None) -> dict:
    raw = source.read_bytes()
    boot = parse_boot(raw)
    ko, ro, so, dto = (
        boot["kernel_offset"], boot["ramdisk_offset"],
        boot["second_offset"], boot["dt_offset"],
    )
    kernel = raw[ko:ko + boot["kernel_size"]]
    ramdisk = raw[ro:ro + boot["ramdisk_size"]]
    second = raw[so:so + boot["second_size"]]
    old_qcdt = raw[dto:dto + boot["dt_size"]]
    new_qcdt, qinfo = make_trimmed_qcdt(old_qcdt, boot["page_size"])

    new = bytearray(raw[:dto])
    # Android boot v0 Qualcomm extension stores QCDT byte size in unused #1.
    struct.pack_into("<I", new, 8 + 8 * 4, len(new_qcdt))
    new[576:608] = bytes(32)
    new_id = legacy_boot_id(kernel, ramdisk, second, new_qcdt)
    new[576:576 + len(new_id)] = new_id
    new += new_qcdt

    if len(new) > BOOT_LIMIT:
        raise ValueError(f"trimmed boot still exceeds 16 MiB: {len(new)}")
    if bytes(new[ko:ko + boot["kernel_size"]]) != kernel:
        raise ValueError("kernel changed during QCDT trim")
    if bytes(new[ro:ro + boot["ramdisk_size"]]) != ramdisk:
        raise ValueError("ramdisk changed during QCDT trim")
    # Everything before dt_size/id fields must remain exactly the source header.
    mutable = set(range(40, 44)) | set(range(576, 608))
    if any(new[i] != raw[i] for i in range(boot["page_size"]) if i not in mutable):
        raise ValueError("boot header changed outside dt_size/id")

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(new)
    info = {
        **qinfo,
        "method": "QCDT-only repackage; compiled kernel and ramdisk preserved byte-for-byte",
        "source_boot_bytes": len(raw),
        "trimmed_boot_bytes": len(new),
        "boot_partition_limit_bytes": BOOT_LIMIT,
        "headroom_bytes": BOOT_LIMIT - len(new),
        "source_boot_sha256": sha256(raw),
        "trimmed_boot_sha256": sha256(bytes(new)),
        "kernel_sha256": sha256(kernel),
        "ramdisk_sha256": sha256(ramdisk),
        "kernel_byte_identical": True,
        "ramdisk_byte_identical": True,
        "boot_addresses_and_cmdline_byte_identical": True,
        "legacy_boot_sha1": new_id.hex(),
    }
    if verification:
        verification.write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    return info


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("output")
    parser.add_argument("--verification")
    args = parser.parse_args()
    info = trim(Path(args.source), Path(args.output),
                Path(args.verification) if args.verification else None)
    print(json.dumps(info, indent=2))


if __name__ == "__main__":
    main()
