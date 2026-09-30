"""Offline tests for generic Dior pmOS_root GPT extraction."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest
import uuid
import zlib

SCRIPT = Path(__file__).resolve().parents[2] / "tools/dior-usb-repair/extract-pmos-root.py"
SPEC = importlib.util.spec_from_file_location("extract_pmos_root", SCRIPT)
assert SPEC and SPEC.loader
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


def make_image(path: Path, *, name: str = "pmOS_root", corrupt_crc: bool = False) -> str:
    sector = 512
    sectors = 8192
    first = 2048
    last = 6143
    entry_size = 128
    entry_count = 128
    entries_lba = 2
    data = bytearray(sectors * sector)

    # Protective MBR signature.
    data[510:512] = b"\x55\xaa"

    entries = bytearray(entry_count * entry_size)
    # Linux filesystem data GUID bytes; the extractor only requires a used entry.
    entries[0:16] = bytes.fromhex("af3dc60f838472478e793d69d8477de4")
    entries[16:32] = bytes.fromhex("00112233445566778899aabbccddeeff")
    struct.pack_into("<QQQ", entries, 32, first, last, 0)
    raw_name = name.encode("utf-16le")
    entries[56:56 + len(raw_name)] = raw_name
    entries_crc = zlib.crc32(entries) & 0xFFFFFFFF
    off = entries_lba * sector
    data[off:off + len(entries)] = entries

    header = bytearray(sector)
    header[:8] = b"EFI PART"
    struct.pack_into("<I", header, 8, 0x00010000)
    struct.pack_into("<I", header, 12, 92)
    struct.pack_into("<I", header, 16, 0)
    struct.pack_into("<Q", header, 24, 1)
    struct.pack_into("<Q", header, 32, sectors - 1)
    struct.pack_into("<Q", header, 40, 34)
    struct.pack_into("<Q", header, 48, sectors - 34)
    header[56:72] = bytes.fromhex("ffeeddccbbaa99887766554433221100")
    struct.pack_into("<Q", header, 72, entries_lba)
    struct.pack_into("<I", header, 80, entry_count)
    struct.pack_into("<I", header, 84, entry_size)
    struct.pack_into("<I", header, 88, entries_crc)
    crc = zlib.crc32(header[:92]) & 0xFFFFFFFF
    struct.pack_into("<I", header, 16, crc ^ (1 if corrupt_crc else 0))
    data[sector:sector * 2] = header

    root_off = first * sector
    sb = bytearray(1024)
    struct.pack_into("<I", sb, 0x04, last - first + 1)
    struct.pack_into("<I", sb, 0x18, 0)  # 1024-byte blocks
    struct.pack_into("<H", sb, 0x38, 0xEF53)
    fs_uuid = uuid.UUID("2b3bcea5-5043-47de-a4f3-4959104f4762")
    sb[0x68:0x78] = fs_uuid.bytes
    sb[0x78:0x88] = b"pmOS_root" + b"\0" * 7
    data[root_off + 1024:root_off + 2048] = sb
    path.write_bytes(data)
    return str(fs_uuid)


class ExtractPmosRootTests(unittest.TestCase):
    def test_extracts_named_root_and_preserves_ext_identity(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            src = root / "disk.img"
            out = root / "root.img"
            expected_uuid = make_image(src)
            result = MOD.extract(src, out)
            self.assertEqual(result["partition_name"], "pmOS_root")
            self.assertEqual(result["filesystem_uuid"], expected_uuid)
            self.assertEqual(result["filesystem_label"], "pmOS_root")
            self.assertEqual(result["root_offset_bytes"], 2048 * 512)
            self.assertEqual(result["output_bytes"], (6143 - 2048 + 1) * 512)
            self.assertTrue(result["fits_fastboot_max_download"])

    def test_rejects_missing_pmos_root(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "disk.img"
            make_image(src, name="not_root")
            with self.assertRaisesRegex(ValueError, "exactly one pmOS_root"):
                MOD.extract(src, Path(td) / "root.img")

    def test_rejects_corrupt_gpt_header_crc(self):
        with tempfile.TemporaryDirectory() as td:
            src = Path(td) / "disk.img"
            make_image(src, corrupt_crc=True)
            with self.assertRaisesRegex(ValueError, "GPT header CRC mismatch"):
                MOD.extract(src, Path(td) / "root.img")


if __name__ == "__main__":
    unittest.main()
