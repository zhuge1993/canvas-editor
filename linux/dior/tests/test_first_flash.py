"""Offline control-flow tests, NOT a kernel build or real-device flash.

Run: python3 -m unittest discover -s linux/dior/tests -v
The script under test only sees stub pmbootstrap/fastboot executables. The
stubs record arguments and never invoke the real tools or open USB devices.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


FLASH_SCRIPT = Path(__file__).resolve().parents[1] / "flash-v1-first.sh"
STUB = r'''
import json
import os
from pathlib import Path
import sys

root = Path(os.environ["DIOR_TEST_ROOT"])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / "calls.jsonl").open("a", encoding="utf-8") as log:
    log.write(json.dumps([name, *args]) + "\n")

def fail():
    raise SystemExit("unexpected stub command: " + repr([name, *args]))

if name == "pmbootstrap":
    if args == ["config", "device"]:
        print("xiaomi-dior")
    elif args and args[0] == "export":
        # Documented export behavior: without --no-install, kernel/initfs
        # may be updated. Model that by modifying only a test fixture.
        if "--no-install" not in args and os.environ.get("DIOR_TEST_UPDATE", "1") == "1":
            with (root / "workspace" / "boot.img-xiaomi-dior").open("ab") as image:
                image.write(b"updated initfs fixture\n")
        target = Path(args[-1])
        for image in (root / "workspace").iterdir():
            (target / image.name).symlink_to(image)
    elif args and args[0] == "flasher" and args[-1] == "flash_rootfs":
        if os.environ.get("DIOR_TEST_ROOTFS_FAIL") == "1":
            raise SystemExit(1)
        if "--no-reboot" not in args:
            (root / "rebooted").touch()
    else:
        fail()
elif name == "fastboot":
    if args == ["devices"]:
        if not (root / "rebooted").exists():
            for serial in os.environ.get("DIOR_TEST_SERIALS", "TEST-SERIAL").split():
                print(serial + "\tfastboot")
    elif args[:2] == ["-s", "TEST-SERIAL"]:
        if args[2:] == ["getvar", "product"]:
            print("product: " + os.environ.get("DIOR_TEST_PRODUCT", "dior"), file=sys.stderr)
        elif args[2:4] == ["flash:raw", "boot"] and len(args) == 5:
            pass  # Record only. Never execute a real flash.
        elif args[2:] == ["reboot"]:
            (root / "rebooted").touch()
        else:
            fail()
    else:
        fail()
else:
    fail()
'''


class FirstFlashTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="dior-first-flash-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / "output"
        workspace = self.root / "workspace"
        mockbin = self.root / "bin"
        for directory in (self.output, workspace, mockbin):
            directory.mkdir()
        for name in ("boot.img-xiaomi-dior", "xiaomi-dior.img"):
            data = b"TEST FIXTURE ONLY - NOT A FLASHABLE IMAGE\n" + name.encode()
            (self.output / name).write_bytes(data)
            (workspace / name).write_bytes(data)
        (self.output / "BUILD-MANIFEST.txt").write_text(
            "target_device=dior\ninstall_mode=standard\n", encoding="utf-8"
        )
        (self.output / "SHA256SUMS").write_text("".join(
            f"{hashlib.sha256(file.read_bytes()).hexdigest()}  {file.name}\n"
            for file in sorted(self.output.iterdir())
        ), encoding="utf-8")
        for name in ("pmbootstrap", "fastboot"):
            stub = mockbin / name
            stub.write_text(f"#!{sys.executable}\n{STUB}", encoding="utf-8")
            stub.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(mockbin) + os.pathsep + os.environ.get("PATH", ""),
            "DIOR_TEST_ROOT": str(self.root),
            "OUTPUT_DIR": str(self.output),
            "REBOOT_AFTER_FLASH": "1",
            "DIOR_TEST_UPDATE": "1",
            "DIOR_TEST_SERIALS": "TEST-SERIAL",
            "DIOR_TEST_PRODUCT": "dior",
            "DIOR_TEST_ROOTFS_FAIL": "0",
        }
        # Fail closed if a stub was not installed: never fall back to host tools.
        for name in ("pmbootstrap", "fastboot"):
            self.assertEqual(shutil.which(name, path=self.env["PATH"]), str(mockbin / name))

    def run_flash(self, answer: str = "DIOR\n") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["/bin/sh", str(FLASH_SCRIPT)], input=answer, env=self.env,
            capture_output=True, text=True, timeout=15, check=False,
        )

    def calls(self) -> list[list[str]]:
        log = self.root / "calls.jsonl"
        return [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []

    def writes(self) -> list[list[str]]:
        return [call for call in self.calls()
                if "flash:raw" in call or "flash_rootfs" in call or "reboot" in call]

    def assert_denied_without_flash(self, answer: str = "DIOR\n") -> None:
        result = self.run_flash(answer)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.writes(), [])

    def test_verification_does_not_rebuild_boot(self) -> None:
        boot = self.root / "workspace" / "boot.img-xiaomi-dior"
        before = boot.read_bytes()
        result = self.run_flash()
        self.assertEqual(boot.read_bytes(), before, "verification changed kernel/initfs")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        exports = [call for call in self.calls() if call[:2] == ["pmbootstrap", "export"]]
        self.assertEqual(len(exports), 1)
        self.assertIn("--no-install", exports[0])
        self.assertFalse(Path(exports[0][-1]).exists(), "temporary export was not removed")

    def test_only_script_reboots_after_both_writes(self) -> None:
        self.env["DIOR_TEST_UPDATE"] = "0"  # Isolate automatic-reboot behavior.
        result = self.run_flash()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.writes(), [
            ["fastboot", "-s", "TEST-SERIAL", "flash:raw", "boot", str(self.output / "boot.img-xiaomi-dior")],
            ["pmbootstrap", "flasher", "--no-reboot", "flash_rootfs"],
            ["fastboot", "-s", "TEST-SERIAL", "reboot"],
        ])

    def test_reboot_can_be_disabled(self) -> None:
        self.env.update(REBOOT_AFTER_FLASH="0", DIOR_TEST_UPDATE="0")
        result = self.run_flash()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.root / "rebooted").exists())
        self.assertEqual(len(self.writes()), 2)

    def test_wrong_confirmation_never_flashes(self) -> None:
        self.assert_denied_without_flash("NO\n")

    def test_wrong_product_never_flashes(self) -> None:
        self.env["DIOR_TEST_PRODUCT"] = "gucci"
        self.assert_denied_without_flash()

    def test_multiple_devices_never_flash(self) -> None:
        self.env["DIOR_TEST_SERIALS"] = "TEST-SERIAL SECOND-DEVICE"
        self.assert_denied_without_flash()

    def test_checksum_mismatch_never_flashes(self) -> None:
        (self.output / "boot.img-xiaomi-dior").write_bytes(b"corrupt fixture")
        self.assert_denied_without_flash()

    def test_workspace_mismatch_never_flashes(self) -> None:
        (self.root / "workspace" / "xiaomi-dior.img").write_bytes(b"different fixture")
        self.assert_denied_without_flash()

    def test_rootfs_failure_never_reboots(self) -> None:
        self.env["DIOR_TEST_ROOTFS_FAIL"] = "1"
        result = self.run_flash()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.writes()), 2)
        self.assertFalse((self.root / "rebooted").exists())


if __name__ == "__main__":
    unittest.main()
