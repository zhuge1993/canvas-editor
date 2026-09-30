"""Offline adapter tests. No network, pmbootstrap builds or USB operations."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "dior_ci", Path(__file__).resolve().parents[1] / "ci-build-image.py")
assert SPEC and SPEC.loader
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)


class CiBuildImageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="dior-ci-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / "flowboard-dior-v1"
        self.state.mkdir()
        (self.state / "login-password").write_text("TEST-ONLY-PASSWORD\n")

    def test_install_uses_standard_mode_and_private_password(self) -> None:
        args = CI.pmb_arguments(["install", "--add=flowboard-server"], self.state)
        self.assertIn("--no-split", args)
        self.assertEqual(args[args.index("--password") + 1], "TEST-ONLY-PASSWORD")
        self.assertIn("--add=flowboard-server", args)
        self.assertIn("--assume-yes", args)

    def test_no_flash_commands_permitted(self) -> None:
        for args in (["flasher", "flash_rootfs"], ["flasher", "boot"], ["sideload"], []):
            with self.subTest(args=args), self.assertRaises(ValueError):
                CI.pmb_arguments(args, self.state)

    def test_install_cannot_target_a_physical_disk(self) -> None:
        for option in ("--disk=/dev/sda", "--sdcard=/dev/sda", "--split", "--password=weak"):
            with self.subTest(option=option), self.assertRaises(ValueError):
                CI.pmb_arguments(["install", option], self.state)

    def test_config_stdout_is_not_polluted_by_verbose_build_logs(self) -> None:
        args = CI.pmb_arguments(["config", "device"], self.state)
        self.assertNotIn("--details-to-stdout", args)
        self.assertEqual(args[-2:], ["config", "device"])

    def test_empty_password_fails(self) -> None:
        (self.state / "login-password").write_text("\n")
        with self.assertRaises(ValueError):
            CI.pmb_arguments(["install"], self.state)

    def test_no_overwrite_of_current_aports(self) -> None:
        snapshot = self.root / "snapshot"
        aports = self.root / "aports"
        for name in ("device-xiaomi-dior", "linux-xiaomi-dior", "firmware-xiaomi-dior"):
            directory = snapshot / "device/archived" / name
            directory.mkdir(parents=True)
            (directory / "APKBUILD").write_text("snapshot")
        (snapshot / "main/wcnss-wlan").mkdir(parents=True)
        (snapshot / "main/wcnss-wlan/APKBUILD").write_text("snapshot")
        current = aports / "device/testing/device-xiaomi-dior"
        current.mkdir(parents=True)
        (current / "APKBUILD").write_text("current upstream")
        helper = aports / "community/wcnss-wlan"
        helper.mkdir(parents=True)
        (helper / "APKBUILD").write_text("current helper")
        CI.seed_missing_aports(snapshot, aports)
        self.assertEqual((current / "APKBUILD").read_text(), "current upstream")
        self.assertEqual((helper / "APKBUILD").read_text(), "current helper")
        self.assertFalse((aports / "main/wcnss-wlan").exists())
        self.assertTrue((aports / "device/testing/linux-xiaomi-dior/APKBUILD").is_file())

    def test_missing_images_cannot_be_released(self) -> None:
        output = self.root / "output"
        output.mkdir()
        (output / "BUILD-MANIFEST.txt").write_text(
            "target_device=dior\ntarget_arch=armv7\ninstall_mode=standard\n")
        with self.assertRaises(ValueError):
            CI.validate_images(output)

    def test_wrong_target_cannot_be_released(self) -> None:
        output = self.root / "output"
        output.mkdir()
        (output / "BUILD-MANIFEST.txt").write_text(
            "target_device=gucci\ntarget_arch=armv7\ninstall_mode=standard\n")
        with self.assertRaises(ValueError):
            CI.validate_images(output)

    def test_logs_redact_password(self) -> None:
        (self.state / "logs").mkdir()
        (self.state / "logs/build.log").write_text("args --password TEST-ONLY-PASSWORD\n")
        with patch.dict(os.environ, {"RUNNER_TEMP": str(self.root)}):
            CI.collect_logs()
        text = (self.state / "diagnostics/build.log").read_text()
        self.assertNotIn("TEST-ONLY-PASSWORD", text)
        self.assertIn("[REDACTED]", text)
        self.assertFalse((self.state / "diagnostics/login-password").exists())

    def test_build_refuses_non_ci_host(self) -> None:
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), self.assertRaises(RuntimeError):
            CI.build()


if __name__ == "__main__":
    unittest.main()
