#!/usr/bin/env python3
"""Build dior V1 images on a disposable GitHub Linux VM; never flash a device.

The ordinary build-v1-first-flash.sh remains the only image build entry point.
This adapter prepares its non-interactive environment and publishes candidates
only after that entry point succeeds. No mock images are used by this program.
"""
from __future__ import annotations

import configparser
import hashlib
import os
from pathlib import Path
import secrets
import shlex
import shutil
import subprocess
import sys
import tarfile

REPO = Path(__file__).resolve().parents[2]
ALLOWED_PMB = {"--version", "config", "init", "checksum", "build", "install",
               "chroot", "export", "deviceinfo_parse", "shutdown"}


def state_dir() -> Path:
    return Path(os.environ["RUNNER_TEMP"]).resolve() / "flowboard-dior-v1"


def run(args: list[str], *, input_text: str | None = None,
        capture: bool = False, timeout: int | None = None) -> str:
    print("+ " + shlex.join(args), flush=True)
    result = subprocess.run(args, check=True, text=True, input=input_text,
                            stdout=subprocess.PIPE if capture else None,
                            timeout=timeout)
    return result.stdout.strip() if capture else ""


def checkout(url: str, ref: str, destination: Path) -> str:
    # Fetch official upstreams, record the resolved commits, never rewrite them.
    if ref == "HEAD":
        run(["git", "clone", "--depth=1", url, str(destination)])
    else:
        run(["git", "init", str(destination)])
        run(["git", "-C", str(destination), "remote", "add", "origin", url])
        run(["git", "-C", str(destination), "fetch", "--depth=1", "origin", ref])
        run(["git", "-C", str(destination), "checkout", "--detach", "FETCH_HEAD"])
    return run(["git", "-C", str(destination), "rev-parse", "HEAD"], capture=True)


def seed_missing_aports(snapshot: Path, aports: Path) -> None:
    # Only used in a fresh CI checkout, before pmbootstrap init resolves dior.
    # Never replace a current upstream aport; build-image.sh checks completeness.
    for name in ("device-xiaomi-dior", "linux-xiaomi-dior", "firmware-xiaomi-dior"):
        existing = list((aports / "device").glob("*/" + name))
        if existing:
            continue
        destination = aports / "device/testing" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(snapshot / "device/archived" / name, destination)
    if not any((aports / section / "wcnss-wlan").exists()
               for section in ("main", "community", "testing")):
        destination = aports / "main/wcnss-wlan"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(snapshot / "main/wcnss-wlan", destination)


def pmb_arguments(args: list[str], state: Path) -> list[str]:
    if not args or args[0] not in ALLOWED_PMB:
        raise ValueError("CI adapter permits build commands only; flashing is forbidden")
    if args[0] == "install":
        # V1 is always standard, regardless of upstream device split defaults.
        if any(arg.startswith(("--disk", "--sdcard", "--split", "--password"))
               for arg in args[1:]):
            raise ValueError("CI install cannot target a disk or override its V1 mode")
        password = (state / "login-password").read_text(encoding="utf-8").strip()
        if not password:
            raise ValueError("Missing generated device login password")
        args = ["install", "--no-split", "--password", password, *args[1:]]
    command = [sys.executable, str(state / "pmbootstrap/pmbootstrap.py"),
               "--config", str(state / "pmbootstrap_v3.cfg"),
               "--aports", str(state / "pmaports"),
               "--work", str(state / "work"),
               "--log", str(state / "pmbootstrap.log"), "--assume-yes"]
    # config output is consumed by the shell build scripts: keep it unadorned.
    if args[0] in {"checksum", "build", "install", "chroot", "export"}:
        command.append("--details-to-stdout")
    return [*command, *args]


def sha256(file: Path) -> str:
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_images(output: Path) -> None:
    manifest = (output / "BUILD-MANIFEST.txt").read_text(encoding="utf-8").splitlines()
    for setting in ("target_device=dior", "target_arch=armv7", "install_mode=standard"):
        if setting not in manifest:
            raise ValueError("Unexpected or incomplete image manifest: " + setting)
    # Current pmbootstrap exports boot.img; older versions appended the device.
    # These are explicit supported names, not a glob that can select another device.
    boot = output / "boot.img-xiaomi-dior"
    current_boot = output / "boot.img"
    if boot.is_file() and current_boot.is_file() and sha256(boot) != sha256(current_boot):
        raise ValueError("Conflicting current and historical dior boot exports")
    if not boot.is_file():
        boot = current_boot
    rootfs = output / "xiaomi-dior.img"
    if not boot.is_file() or boot.stat().st_size < 1024:
        raise ValueError("Missing or empty dior Android boot image")
    with boot.open("rb") as stream:
        if stream.read(8) != b"ANDROID!":
            raise ValueError("Boot image has no Android boot-image magic")
    if not rootfs.is_file() or rootfs.stat().st_size < 16 * 1024 * 1024:
        raise ValueError("Missing or implausibly small standard dior rootfs image")
    # Acceptance above is structural only, never proof of a real-device boot.
    run(["sh", "-c", 'cd "$1" && sha256sum -c SHA256SUMS', "sh", str(output)])


def collect_logs() -> None:
    """Only upload sanitized logs, never a chroot or private package-signing key."""
    state = state_dir()
    destination = state / "diagnostics"
    destination.mkdir(parents=True, exist_ok=True)
    secret_file = state / "login-password"
    password = secret_file.read_text().strip() if secret_file.is_file() else ""
    sources = [state / "logs/build.log", state / "pmbootstrap.log",
               state / "UPSTREAM-REVISIONS.txt"]
    for source in sources:
        if not source.is_file():
            continue
        with source.open(encoding="utf-8", errors="replace") as src, \
                (destination / source.name).open("w", encoding="utf-8") as dst:
            for line in src:
                dst.write(line.replace(password, "[REDACTED]") if password else line)
    (destination / "README.txt").write_text(
        "Logs only. These files are not a successful-build or real-device-boot certificate.\n",
        encoding="utf-8")


def build() -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("Run this CI adapter as the ordinary user on a disposable GitHub Linux VM")
    state = state_dir()
    if state == REPO or REPO in state.parents:
        raise RuntimeError("CI state must be outside the clean source checkout")
    state.mkdir(parents=True, exist_ok=True)
    for child in ("work", "pmaports", "pmbootstrap", "images", "release", "login-password"):
        if (state / child).exists():
            raise RuntimeError("Refusing to reuse a previous CI build: " + child)
    if run(["git", "-C", str(REPO), "status", "--porcelain"], capture=True):
        raise RuntimeError("Source checkout must be clean")
    run(["sudo", "-n", "true"])
    run(["df", "-h", str(state)])
    (state / "work").mkdir()
    pmb_sha = checkout("https://gitlab.postmarketos.org/postmarketOS/pmbootstrap.git",
                       os.environ.get("PMBOOTSTRAP_REF", "HEAD"), state / "pmbootstrap")
    aports_sha = checkout("https://gitlab.postmarketos.org/postmarketOS/pmaports.git",
                          os.environ.get("PMAPORTS_REF", "HEAD"), state / "pmaports")
    source_sha = run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture=True)
    (state / "UPSTREAM-REVISIONS.txt").write_text(
        f"repository_revision={source_sha}\npmbootstrap_revision={pmb_sha}\n"
        f"pmaports_revision={aports_sha}\n", encoding="utf-8")

    # Hydrate a separate copy, keeping the checked-out source clean for V1.
    snapshot = state / "snapshot"
    shutil.copytree(REPO / "linux/dior/pmaports-snapshot", snapshot)
    run(["sh", str(snapshot / "hydrate-snapshot.sh")])
    run(["sh", str(snapshot / "check-snapshot.sh")])
    seed_missing_aports(snapshot, state / "pmaports")

    password = secrets.token_hex(16)
    (state / "login-password").write_text(password + "\n", encoding="utf-8")
    (state / "login-password").chmod(0o600)
    # Mask before any pmbootstrap process could include it in console output.
    print("::add-mask::" + password, flush=True)
    cfg = configparser.ConfigParser(interpolation=None)
    cfg["pmbootstrap"] = {
        "aports": str(state / "pmaports"), "work": str(state / "work"),
        "device": "xiaomi-dior", "ui": "console", "service_manager": "openrc",
        "user": "dior", "hostname": "dior-flowboard", "is_default_channel": "False",
        "ssh_keys": "False", "ui_extras": "False", "timezone": "Asia/Shanghai",
        # Size of the boot FILESYSTEM inside the standard rootfs disk image,
        # not the phone's Android boot partition. pmbootstrap rejects 64 MiB.
        "build_default_device_arch": "True", "boot_size": "512", "extra_space": "0",
        "extra_packages": "firmware-xiaomi-dior,wcnss-wlan,networkmanager,networkmanager-wifi,networkmanager-cli",
    }
    cfg["providers"] = {}
    with (state / "pmbootstrap_v3.cfg").open("w", encoding="utf-8") as file:
        cfg.write(file)
    (state / "bin").mkdir()
    wrapper = state / "bin/pmbootstrap"
    wrapper.write_text('#!/bin/sh\nexec python3 "$DIOR_CI_SCRIPT" --pmb "$@"\n', encoding="utf-8")
    wrapper.chmod(0o755)
    os.environ.update(
        DIOR_CI_SCRIPT=str(Path(__file__).resolve()), PMB_APORTS=str(state / "pmaports"),
        OUTPUT_DIR=str(state / "images"), PATH=str(state / "bin") + os.pathsep + os.environ["PATH"],
        PMB_SUDO="sudo", PYTHONDONTWRITEBYTECODE="1",
    )
    run(["pmbootstrap", "--version"])
    # Default answers are finite and time-bounded; a bad config cannot hang forever.
    run(["pmbootstrap", "init"], input_text="\n" * 80, timeout=600)
    for key, value in (("device", "xiaomi-dior"), ("ui", "console"), ("service_manager", "openrc")):
        if run(["pmbootstrap", "config", key], capture=True) != value:
            raise RuntimeError("Unexpected initialized pmbootstrap setting: " + key)
    try:
        run(["sh", str(REPO / "linux/dior/build-v1-first-flash.sh")])
        validate_images(state / "images")
        # Check the Qualcomm device tree too; do not package only a frontend tar.
        run(["pmbootstrap", "chroot", "-r", "--", "sh", "-ec",
             'test -s /boot/dt.img; test "$(head -c 4 /boot/dt.img)" = QCDT'])
        output = state / "images"
        # Original export hashes have passed above. Keep a byte-identical alias
        # for the existing download-only client; include it in new checksums below.
        if not (output / "boot.img-xiaomi-dior").is_file():
            shutil.copy2(output / "boot.img", output / "boot.img-xiaomi-dior")
        # pmbootstrap's parser/flasher reads the selected aport's deviceinfo.
        # Do not assume that modern rootfs still installs /etc/deviceinfo.
        manifest_values = dict(line.split("=", 1) for line in
                               (output / "BUILD-MANIFEST.txt").read_text().splitlines()
                               if "=" in line)
        device_aport = Path(manifest_values["device_aport"]).resolve()
        if not device_aport.is_relative_to((state / "pmaports/device").resolve()):
            raise ValueError("Device aport is outside this build's pmaports tree")
        shutil.copyfile(device_aport / "deviceinfo", output / "deviceinfo")
        shutil.copyfile(state / "pmbootstrap/pmb/flasher/variables.py",
                        output / "PMBOOTSTRAP-FLASHER-VARIABLES.py.txt")
        shutil.copy2(state / "UPSTREAM-REVISIONS.txt", output / "UPSTREAM-REVISIONS.txt")
        (output / "FIRST-LOGIN.txt").write_text(
            "PRIVATE: do not publish this artifact. Device OS login (not FlowBoard web login):\n"
            f"user=dior\npassword={password}\n"
            "Change with passwd after first login. No QQ SMTP secret is included.\n",
            encoding="utf-8")
        (output / "FIRST-LOGIN.txt").chmod(0o600)
        (output / "BUILD-STATUS.txt").write_text(
            "Complete build entry point and rootfs acceptance checks passed.\n"
            "Candidate only: no physical phone has been flashed or boot-tested by CI.\n"
            "Keep private: FIRST-LOGIN.txt contains this build's unique OS password.\n"
            "Do not use the same-workspace flash-v1-first.sh against a different PC.\n"
            "Cloud-download flashing instructions must be matched to these actual artifacts.\n",
            encoding="utf-8")
        files = sorted(file for file in output.rglob("*") if file.is_file() and file.name != "SHA256SUMS")
        (output / "SHA256SUMS").write_text("".join(
            f"{sha256(file)}  ./{file.relative_to(output).as_posix()}\n" for file in files), encoding="utf-8")
        validate_images(output)
        release = state / "release"
        release.mkdir()
        archive = release / f"DiorLinux-FlowBoard-V1-{source_sha[:12]}-candidate.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(output, arcname="dior-v1")
        (release / "SHA256SUMS").write_text(f"{sha256(archive)}  {archive.name}\n", encoding="utf-8")
        print("Complete image candidate prepared: " + archive.name, flush=True)
    finally:
        # Shutdown is build-host cleanup, not a reboot or flash of the phone.
        subprocess.run(["pmbootstrap", "shutdown"], check=False, timeout=60)


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["collect-logs"]:
            collect_logs()
        elif sys.argv[1:2] == ["--pmb"]:
            command = pmb_arguments(sys.argv[2:], state_dir())
            os.execv(command[0], command)
        elif len(sys.argv) == 1:
            build()
        else:
            raise ValueError("Unknown CI adapter command")
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        # Do not echo CalledProcessError.cmd: it may contain a generated password.
        print("Dior image build stopped: " + (type(error).__name__ if isinstance(error, subprocess.SubprocessError)
              else str(error)), file=sys.stderr)
        raise SystemExit(1)
