#!/usr/bin/env python3
"""Use the existing pmbootstrap/GCC4 recipe to build only the dior kernel."""
from __future__ import annotations

import configparser
import gzip
import importlib.util
import json
import lzma
import os
from pathlib import Path
import re
import shutil
import struct
import sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SPEC = importlib.util.spec_from_file_location("dior_image_ci", HERE / "ci-build-image.py")
CI = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CI)
KERNEL_COMMIT = "12f40d54ab4e34dabaeb8dd7979bedc3cc8fa064"


def verify_zimage(path: Path, destination: Path) -> dict:
    kernel = path.read_bytes()
    if len(kernel) < 48 or struct.unpack_from("<I", kernel, 36)[0] != 0x016F2818:
        raise ValueError("not an ARM zImage")
    start, end = struct.unpack_from("<II", kernel, 40)
    if end - start != len(kernel):
        raise ValueError("unexpected appended zImage data")
    # The locked config uses LZMA. Inspect the compiled image itself, rather
    # than trusting a copied config or a host compiler --version command.
    offset = kernel.find(bytes.fromhex("5d000000"))
    if offset < 0:
        raise ValueError("locked LZMA kernel payload absent")
    image = lzma.LZMADecompressor(format=lzma.FORMAT_ALONE).decompress(kernel[offset:])
    banner = re.search(rb"Linux version [^\x00]+", image)
    if not banner or not re.search(rb"gcc version 4\.", banner.group()):
        raise ValueError("compiled kernel is not GCC4")
    if b"Dior prima driver NV default version=%d" not in image:
        raise ValueError("compiled kernel has no Dior NV compatibility marker")
    if b"thermal_mc_grp\0" not in image or b"thermal_mc_group" in image:
        raise ValueError("compiled kernel lacks the thermal netlink name fix")
    begin = image.index(b"IKCFG_ST") + 8
    finish = image.index(b"IKCFG_ED", begin)
    config = gzip.decompress(image[begin:finish]).decode("ascii")
    for setting in ("CONFIG_PRONTO_WLAN=y", "CONFIG_MSM_KGSL=y", "CONFIG_RFKILL=y",
                    "CONFIG_DRM=y", "CONFIG_GENLOCK=y", "CONFIG_MSM_KGSL_DRM=y"):
        if setting not in config.splitlines():
            raise ValueError("effective compiled config missing " + setting)
    # Kconfig omits hidden disabled symbols entirely when DRM makes their
    # dependency false. Reject an enabled value rather than require a comment.
    if re.search(r"^CONFIG_KGSL_PER_PROCESS_PAGE_TABLE=[ym]$", config, re.M):
        raise ValueError("KGSL DRM requires global page tables")
    (destination / "kernel.config").write_bytes(config.encode("ascii"))
    return {"linux_banner": banner.group().decode().strip(), "gcc4_verified": True,
            "nv_patch_marker_present": True, "thermal_netlink_fix_verified": True,
            "effective_config_verified": True}


def build() -> None:
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("requires an ordinary user on a disposable GitHub Linux runner")
    state = Path(os.environ["RUNNER_TEMP"]).resolve() / "dior-kernel-only"
    if state.exists() or state == REPO or REPO in state.parents:
        raise RuntimeError("requires a fresh external build directory")
    if CI.run(["git", "-C", str(REPO), "status", "--porcelain"], capture=True):
        raise RuntimeError("source checkout must be clean")
    state.mkdir()
    output = state / "artifact"
    output.mkdir()
    CI.run(["sudo", "-n", "true"])
    revisions = {
        "repository_revision": CI.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture=True),
        "kernel_repository": "msfkonsole/android_kernel_xiaomi_dior",
        "kernel_commit": KERNEL_COMMIT,
        "pmbootstrap_revision": CI.checkout("https://gitlab.postmarketos.org/postmarketOS/pmbootstrap.git",
                                              "HEAD", state / "pmbootstrap"),
        "pmaports_revision": CI.checkout("https://gitlab.postmarketos.org/postmarketOS/pmaports.git",
                                          "HEAD", state / "pmaports"),
    }
    snapshot = state / "snapshot"
    shutil.copytree(HERE / "pmaports-snapshot", snapshot)
    CI.run(["sh", str(snapshot / "hydrate-snapshot.sh")])
    CI.seed_missing_aports(snapshot, state / "pmaports")
    candidates = list((state / "pmaports/device").glob("*/linux-xiaomi-dior"))
    if len(candidates) != 1:
        raise ValueError("ambiguous dior kernel aport")
    # This is a fresh disposable upstream checkout. Always build the user's
    # locked recipe/patch, even if upstream now contains a different kernel.
    shutil.copytree(snapshot / "device/archived/linux-xiaomi-dior", candidates[0], dirs_exist_ok=True)
    recipe = (candidates[0] / "APKBUILD").read_text()
    release = re.search(r"^pkgrel=(\d+)$", recipe, re.M)
    if (f'_commit="{KERNEL_COMMIT}"' not in recipe or 'pkgver=3.4.0' not in recipe
            or not release or int(release.group(1)) < 4):
        raise ValueError("kernel recipe revision differs from the requested build")
    package_name = f"linux-xiaomi-dior-3.4.0-r{release.group(1)}.apk"
    cfg = configparser.ConfigParser(interpolation=None)
    cfg["pmbootstrap"] = {
        "aports": str(state / "pmaports"), "work": str(state / "work"),
        "device": "xiaomi-dior", "ui": "console", "service_manager": "openrc",
        "user": "dior", "hostname": "dior-flowboard", "is_default_channel": "False",
        "ssh_keys": "False", "ui_extras": "False", "timezone": "Asia/Shanghai",
        "build_default_device_arch": "True", "boot_size": "512", "extra_space": "0",
    }
    cfg["providers"] = {}
    with (state / "pmbootstrap_v3.cfg").open("w", encoding="utf-8") as stream:
        cfg.write(stream)
    # pmb_arguments accepts build commands only; there is no install/export/
    # flash invocation in this entry point, and no phone login is generated.
    pmb = lambda *args, **kwargs: CI.run(CI.pmb_arguments(list(args), state), **kwargs)
    try:
        pmb("init", input_text="\n" * 80, timeout=600)
        if pmb("config", "device", capture=True) != "xiaomi-dior":
            raise ValueError("pmbootstrap initialized the wrong device")
        pmb("build", "linux-xiaomi-dior")
        packages = list((state / "work/packages").glob("*/armv7/" + package_name))
        if len(packages) != 1:
            raise ValueError("expected exactly one freshly built kernel APK")
        package = packages[0]
        # Preserve the completed package for diagnosis even if payload
        # inspection fails later; it remains a candidate until verified.
        shutil.copy2(package, output / package.name)
        unpacked = state / "unpacked"
        unpacked.mkdir()
        CI.run(["tar", "--ignore-zeros", "-xzf", str(package), "-C", str(unpacked)])
        # Current devicepkg-dev installs an unflavored /boot/vmlinuz; the
        # flavor is recorded separately under /usr/share/kernel/.
        kernel = unpacked / "boot/vmlinuz"
        if not kernel.is_file():
            raise ValueError("kernel APK has no boot/vmlinuz")
        shutil.copy2(kernel, output / "zImage")
        proof = verify_zimage(output / "zImage", output)
        manifest = {**revisions, **proof, "kernel_sha256": CI.sha256(output / "zImage"),
                    "kernel_apk_sha256": CI.sha256(package), "package": package.name,
                    "physical_boot_verified": False, "boot_repack_required": True,
                    "ramdisk_and_dtb_source": "live-device boot backup"}
        (output / "BUILD-VERIFICATION.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (output / "SHA256SUMS").write_text("".join(f"{CI.sha256(p)}  {p.name}\n" for p in
              sorted(output.iterdir()) if p.is_file() and p.name != "SHA256SUMS"), encoding="utf-8")
        print(json.dumps(manifest, indent=2), flush=True)
    finally:
        pmb("shutdown")


if __name__ == "__main__":
    build()
