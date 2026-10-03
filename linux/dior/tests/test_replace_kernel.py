import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[3] / "tools/dior-boot/replace-kernel.py"
SPEC = importlib.util.spec_from_file_location("replace_kernel", SCRIPT)
REPACK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPACK)


def zimage(size, filler):
    blob = bytearray(bytes([filler]) * size)
    struct.pack_into("<III", blob, 36, 0x016F2818, 0, size)
    return bytes(blob)


def fixture():
    page = 2048
    blobs = [zimage(3000, 1), b"RAMDISK" * 500, b"", b"QCDTQualcomm MSM 8926 H3-LTE"]
    header = bytearray(page)
    header[:8] = b"ANDROID!"
    struct.pack_into("<10I", header, 8, len(blobs[0]), 32768, len(blobs[1]),
                     33554432, 0, 15728640, 31457280, page, len(blobs[3]), 0)
    header[64:71] = b"cmdline"
    header[576:608] = REPACK.boot_id(blobs) + bytes(12)
    raw = bytes(header)
    for blob in blobs:
        raw += blob + bytes(REPACK.align(len(blob), page) - len(blob))
    return raw + bytes(4096)


class ReplaceKernelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "backup.img"
        self.kernel = self.root / "zImage"
        self.output = self.root / "boot.img"
        self.report = self.root / "verification.json"
        self.source.write_bytes(fixture())
        self.kernel.write_bytes(zimage(5200, 2))

    def run_replace(self):
        return REPACK.replace(self.source, self.kernel, self.output, self.report)

    def test_changed_alignment_preserves_components_and_header(self):
        info = self.run_replace()
        page, before = REPACK.parse_boot(self.source.read_bytes())
        _, after = REPACK.parse_boot(self.output.read_bytes())
        self.assertEqual(after[1:], before[1:])
        self.assertEqual(after[0], self.kernel.read_bytes())
        old, new = self.source.read_bytes(), self.output.read_bytes()
        mutable = set(range(8, 12)) | set(range(576, 608))
        self.assertTrue(all(old[i] == new[i] for i in range(page) if i not in mutable))
        self.assertEqual(new[576:596], REPACK.boot_id(after))
        self.assertTrue(info["ramdisk_byte_identical"])
        self.assertFalse(info["physical_boot_verified"])

    def test_nonzero_trailer_rejected(self):
        self.source.write_bytes(fixture()[:-1] + b"!")
        with self.assertRaisesRegex(ValueError, "trailer"):
            self.run_replace()
        self.assertFalse(self.output.exists())

    def test_truncated_component_rejected(self):
        self.source.write_bytes(fixture()[:2200])
        with self.assertRaisesRegex(ValueError, "exceeds input"):
            self.run_replace()

    def test_wrong_device_rejected(self):
        self.source.write_bytes(fixture().replace(b"H3-LTE", b"OTHER!"))
        with self.assertRaisesRegex(ValueError, "dior"):
            self.run_replace()

    def test_appended_payload_rejected(self):
        self.kernel.write_bytes(zimage(5200, 2) + b"DTB")
        with self.assertRaisesRegex(ValueError, "appended payload"):
            self.run_replace()

    def test_damaged_ramdisk_rejected(self):
        raw = bytearray(fixture())
        raw[6144] ^= 1
        self.source.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "SHA1 ID mismatch"):
            self.run_replace()
        self.assertFalse(self.output.exists())

    def test_output_cannot_overwrite_backup_or_image_with_json(self):
        original = self.source.read_bytes()
        with self.assertRaisesRegex(ValueError, "distinct"):
            REPACK.replace(self.source, self.kernel, self.source, self.report)
        self.assertEqual(original, self.source.read_bytes())
        with self.assertRaisesRegex(ValueError, "distinct"):
            REPACK.replace(self.source, self.kernel, self.output, self.output)
        self.assertFalse(self.output.exists())

    def test_oversize_rejected_before_output(self):
        self.kernel.write_bytes(zimage(REPACK.BOOT_LIMIT, 2))
        with self.assertRaisesRegex(ValueError, "16 MiB"):
            self.run_replace()
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
