#!/usr/bin/env python3
"""Rebuild only Dior libdrm using a verified, previously compiled Mesa payload."""
import configparser
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import zlib

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
BASE_COMMIT = "7ed6c4abcc34bf67fa7452d64de58cf5af871da0"
BASE_RUN = "36974432126"
BASE_APK = "dior-graphics-17.3.9-r1.apk"
BASE_SHA256 = "769617c44f9509e7cf5e0d9194eae361992a34217edbe9301316ca69ac0cfb6f"
LOCAL_SOURCES = ("0001-libdrm-dior-kgsl-compat.patch", "test-kgsl-abi.c", "test-kgsl-map.c",
                 "test-kgsl-reloc.c", "test-kgsl-timestamps.c", "kernel-kgsl-drm-uapi.h",
                 "dior-gles-check", "dior-gles-probe.py", "test-kgsl-rings.c")
spec = importlib.util.spec_from_file_location("dior_ci", HERE / "ci-build-image.py")
CI = importlib.util.module_from_spec(spec)
spec.loader.exec_module(CI)


def sha(data, kind="sha256"):
    return hashlib.new(kind, data).hexdigest()


def gzip_streams(data):
    result = []
    while data:
        decoder = zlib.decompressobj(31)
        raw = decoder.decompress(data) + decoder.flush()
        if not decoder.eof:
            raise ValueError("Truncated base APK")
        used = len(data) - len(decoder.unused_data)
        result.append((data[:used], raw))
        data = decoder.unused_data
    return result


def verified_base(base):
    manifest = json.loads((base / "GRAPHICS-BUILD-VERIFICATION.json").read_text(encoding="utf-8"))
    if manifest["source_commit"] != BASE_COMMIT or manifest["package_sha256"] != BASE_SHA256:
        raise ValueError("Unexpected base build manifest")
    data = (base / BASE_APK).read_bytes()
    if sha(data) != BASE_SHA256:
        raise ValueError("Unexpected base APK checksum")
    streams = gzip_streams(data)
    if len(streams) != 3:
        raise ValueError("Expected signed APK v2 with three gzip streams")
    with tarfile.open(fileobj=io.BytesIO(streams[1][1]), mode="r:") as control:
        info = control.extractfile(".PKGINFO").read().decode("utf-8")
    if "datahash = " + sha(streams[2][0]) not in info.splitlines():
        raise ValueError("Base datahash mismatch")
    files = {}
    with tarfile.open(fileobj=io.BytesIO(streams[2][1]), mode="r:") as archive:
        for item in archive.getmembers():
            name = item.name.removeprefix("./")
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or not (name in ("opt", "opt/dior-graphics") or name.startswith("opt/dior-graphics/")):
                raise ValueError("Unexpected base payload path: " + name)
            if item.isfile() or item.islnk():
                files[name.removeprefix("opt/dior-graphics/")] = sha(archive.extractfile(item).read())
            elif item.issym():
                if item.linkname.startswith("/") or ".." in PurePosixPath(item.linkname).parts:
                    raise ValueError("Unexpected base symlink")
            elif not item.isdir():
                raise ValueError("Unexpected base payload member")
    return streams[2][0], {
        "source_commit": BASE_COMMIT, "ci_run": int(BASE_RUN), "apk_sha256": BASE_SHA256,
        "payload_gzip_sha256": sha(streams[2][0]), "files_sha256": files,
    }


def generated_aport(target, payload, base_manifest, source_commit):
    source = HERE / "graphics-legacy-apk"
    text = (source / "APKBUILD").read_text(encoding="ascii")
    version = dict(re.findall(r"^(pkgname|pkgver|pkgrel)=([^\s]+)$", text, re.MULTILINE))
    if version != {"pkgname": "dior-graphics", "pkgver": "17.3.9", "pkgrel": "5"}:
        raise ValueError("Hotfix requires reviewed dior-graphics 17.3.9-r5 source")
    if 'sonameprefix="$pkgname:"' not in text:
        raise ValueError("Isolated SONAME provider namespace is mandatory")
    target.mkdir(parents=True)
    pairs = dict((name, digest) for digest, name in re.findall(r"([a-f0-9]{128})  (.+)", text))
    for name in LOCAL_SOURCES:
        data = (source / name).read_bytes().replace(b"\r\n", b"\n")
        if sha(data, "sha512") != pairs[name]:
            raise ValueError("Source pin mismatch: " + name)
        (target / name).write_bytes(data)
    for name, base_name in (("dior-gles-check", "bin/dior-gles-check"),
                            ("dior-gles-probe.py", "libexec/dior-gles-probe.py")):
        if sha((source / name).read_bytes().replace(b"\r\n", b"\n")) != base_manifest["files_sha256"][base_name]:
            raise ValueError("Hotfix must preserve the compiled base's probe scripts: " + name)
    (target / "base-payload.tar.gz").write_bytes(payload)
    base_manifest["hotfix_source_commit"] = source_commit
    (target / "base-payload-manifest.json").write_text(json.dumps(base_manifest, indent=2) + "\n", encoding="utf-8")
    start = text.index("\nbuild() {")
    end = text.index("\ncheck() {")
    original_build = text[start:end]
    lib_start = original_build.index('    cd "$srcdir/libdrm-2.4.89"')
    lib_end = original_build.index('    cd "$builddir"')
    lib_build = original_build[lib_start:lib_end]
    prefix = text[:start]
    sources = "\n\thttps://dri.freedesktop.org/libdrm/libdrm-2.4.89.tar.bz2\n\tbase-payload.tar.gz\n\tbase-payload-manifest.json\n"
    sources += "".join("\t" + name + "\n" for name in LOCAL_SOURCES)
    prefix = re.sub(r'^source="\n.*?^"', 'source="' + sources + '"', prefix, flags=re.MULTILINE | re.DOTALL)
    prefix = re.sub(r'^makedepends=.*$', 'makedepends="build-base pkgconf linux-headers zlib-dev libatomic_ops-dev python3"', prefix, flags=re.MULTILINE)
    prefix = prefix.replace('builddir="$srcdir/mesa-17.3.9"', 'builddir="$srcdir/libdrm-2.4.89"')
    build = '\nbuild() {\n    _set_compilers\n    mkdir -p "$_stage"\n    cp -a "$srcdir/opt" "$_stage/"\n'
    build += '    cp "$_stage$_prefix/share/GRAPHICS-BUILD-CHECKS.json" "$_stage$_prefix/share/GRAPHICS-BASE-BUILD-CHECKS.json"\n'
    build += lib_build
    build += '''    python3 - "$srcdir" "$_stage$_prefix" <<'PYBASE'
import json, sys
from pathlib import Path
source, prefix = map(Path, sys.argv[1:])
base = json.loads((prefix / "share/GRAPHICS-BASE-BUILD-CHECKS.json").read_text())
(source / "mesa-configure-flags.txt").write_text(base["mesa_configure_flags"])
PYBASE
}
'''
    check_end = text.index("\npackage() {")
    check = text[end:check_end]
    close = check.rfind("\n}")
    check = check[:close] + '''
    python3 - "$srcdir" "$_stage$_prefix" <<'PYHOTFIX'
import hashlib, json, struct, sys
from pathlib import Path
source, prefix = map(Path, sys.argv[1:])
origin = json.loads((source / "base-payload-manifest.json").read_text())
changes = {"lib/libdrm.so.2.4.0", "lib/libdrm_freedreno.so.1.0.0"}
metadata_changes = {"share/GRAPHICS-BUILD-CHECKS.json", "share/graphics-build-checks.txt"}
preserved = {}
for name, expected in origin["files_sha256"].items():
    if name in changes or name in metadata_changes:
        continue
    actual = hashlib.sha256((prefix / name).read_bytes()).hexdigest()
    assert actual == expected, name
    preserved[name] = actual
libraries = {}
for name in sorted(changes):
    data = (prefix / name).read_bytes()
    assert data[:6] == b"\\x7fELF\\x01\\x01"
    assert struct.unpack_from("<H", data, 18)[0] == 40
    libraries[name] = hashlib.sha256(data).hexdigest()
proof_path = source / "GRAPHICS-BUILD-CHECKS.json"
proof = json.loads(proof_path.read_text())
list_marker = "PASS production KGSL list termination: runtime pipe IDs 1/2; empty and 1/2 real BOs; pre/post/retire stop at head"
assert list_marker in (source / "test-kgsl-timestamps-results.txt").read_text()
assert list_marker in (source / "test-kgsl-timestamps-O2-results.txt").read_text()
ring_marker = "PASS KGSL command BO lifetime: child-first/parent-first, transitive nested, duplicate/multiple-parent fences, wrap-zero, rollback, wait-failure no FREE"
assert ring_marker in (source / "test-kgsl-rings-results.txt").read_text()
assert ring_marker in (source / "test-kgsl-rings-O2-results.txt").read_text()
proof["base_source_manifest_sha512"] = proof["local_source_sha512"].pop("base-payload-manifest.json")
assert len(proof["local_source_sha512"]) == 9
assert set(proof["local_source_sha512"]) == {
    "0001-libdrm-dior-kgsl-compat.patch", "test-kgsl-abi.c", "test-kgsl-map.c",
    "test-kgsl-reloc.c", "test-kgsl-timestamps.c", "kernel-kgsl-drm-uapi.h",
    "dior-gles-check", "dior-gles-probe.py", "test-kgsl-rings.c"}
proof.update({"build_mode": "libdrm_only_hotfix", "mesa_recompiled": False,
    "native_libdrm_tests_before_mesa": False, "native_libdrm_checks_with_verified_mesa_reuse": True,
    "mesa_payload_source_commit": origin["source_commit"],
    "libdrm_source_commit": origin["hotfix_source_commit"],
    "base_apk_sha256": origin["apk_sha256"], "base_payload_gzip_sha256": origin["payload_gzip_sha256"],
    "ion_wire_offsets_verified": True, "ion_wire_raw_word_mock": True,
    "production_list_termination_regressions": True, "timestamp_optimization_runs": ["-Os", "-O2"],
    "nested_command_buffer_lifetime_regressions": True, "ring_optimization_runs": ["-Os", "-O2"],
    "mesa_and_script_bytes_preserved": True, "preserved_files_sha256": preserved,
    "rebuilt_libdrm_sha256": libraries, "physical_gpu_render_verified": False})
proof_path.write_text(json.dumps(proof, indent=2) + "\\n")
(source / "GRAPHICS-LIBDRM-HOTFIX-CHECKS.json").write_text(json.dumps(proof, indent=2) + "\\n")
PYHOTFIX
}''' + check[close + 2:]
    package = text[check_end:text.index("\nsha512sums=")]
    package_marker = '    # The package\'s runtime'
    if package.count(package_marker) != 1:
        raise ValueError("Expected one original runtime packaging marker")
    package = package.replace(package_marker,
        '    install -Dm644 "$srcdir/GRAPHICS-LIBDRM-HOTFIX-CHECKS.json" "$pkgdir$_prefix/share/GRAPHICS-LIBDRM-HOTFIX-CHECKS.json"\n    # The package\'s runtime')
    sums = [pairs["libdrm-2.4.89.tar.bz2"] + "  libdrm-2.4.89.tar.bz2"]
    sums += [sha((target / name).read_bytes(), "sha512") + "  " + name
             for name in ("base-payload.tar.gz", "base-payload-manifest.json", *LOCAL_SOURCES)]
    (target / "APKBUILD").write_text(prefix + build + check + package + '\nsha512sums="\n' + "\n".join(sums) + '\n"\n', encoding="ascii")


def verified_hotfix_package(package, origin, source_commit):
    parts = gzip_streams(package.read_bytes())
    if len(parts) != 3:
        raise ValueError("Expected newly signed APK v2")
    with tarfile.open(fileobj=io.BytesIO(parts[1][1]), mode="r:") as control:
        lines = control.extractfile(".PKGINFO").read().decode("utf-8").splitlines()
    for setting in ("pkgname = dior-graphics", "pkgver = 17.3.9-r5", "arch = armv7",
                    "datahash = " + sha(parts[2][0])):
        if setting not in lines:
            raise ValueError("Unexpected candidate metadata: " + setting)
    providers = [line.removeprefix("provides = ") for line in lines if line.startswith("provides = ")]
    if len(providers) != 6 or any(not value.startswith("so:dior-graphics:") for value in providers):
        raise ValueError("Candidate must not provide the system graphics SONAMEs")
    with tarfile.open(fileobj=io.BytesIO(parts[2][1]), mode="r:") as payload:
        proof = json.loads(payload.extractfile("opt/dior-graphics/share/GRAPHICS-LIBDRM-HOTFIX-CHECKS.json").read())
        if proof["libdrm_source_commit"] != source_commit or not proof["ion_wire_offsets_verified"]:
            raise ValueError("Missing current native hotfix proof")
        if set(proof["local_source_sha512"]) != set(LOCAL_SOURCES):
            raise ValueError("Hotfix proof must contain all nine reviewed local source pins")
        if (not proof["nested_command_buffer_lifetime_regressions"] or
                proof["ring_optimization_runs"] != ["-Os", "-O2"] or
                proof["physical_gpu_render_verified"] is not False):
            raise ValueError("Missing native ring lifetime checks or invalid physical GPU claim")
        for name, expected in proof["preserved_files_sha256"].items():
            if sha(payload.extractfile("opt/dior-graphics/" + name).read()) != expected:
                raise ValueError("Packaged Mesa/script coherence mismatch: " + name)
        for name, expected in proof["rebuilt_libdrm_sha256"].items():
            if sha(payload.extractfile("opt/dior-graphics/" + name).read()) != expected:
                raise ValueError("Packaged libdrm checksum mismatch: " + name)
        old_proof = payload.extractfile("opt/dior-graphics/share/GRAPHICS-BASE-BUILD-CHECKS.json").read()
        if sha(old_proof) != origin["files_sha256"]["share/GRAPHICS-BUILD-CHECKS.json"]:
            raise ValueError("Original Mesa proof was not preserved")
    return {"providers": providers, "dependencies": [line.removeprefix("depend = ") for line in lines
            if line.startswith("depend = ")], "native_hotfix_checks": proof,
            "packaged_payload_coherence_verified": True}


def build():
    if os.environ.get("GITHUB_ACTIONS") != "true" or sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("Run as ordinary user on a disposable GitHub Linux runner")
    state = Path(os.environ["RUNNER_TEMP"]).resolve() / "dior-graphics-libdrm-hotfix"
    if state.exists() or state == REPO or REPO in state.parents:
        raise RuntimeError("Requires a fresh external build directory")
    state.mkdir()
    output = state / "artifact"
    output.mkdir()
    source_commit = CI.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture=True)
    base = state / "base"
    CI.run(["gh", "run", "download", BASE_RUN, "--repo", "zhuge1993/canvas-editor",
            "--name", "Dior-graphics-legacy-" + BASE_COMMIT, "--dir", str(base)])
    payload, origin = verified_base(base)
    pmb = CI.checkout("https://gitlab.postmarketos.org/postmarketOS/pmbootstrap.git",
        "39e9c17c1439b25f7aced54e03f19b0515cdb029", state / "pmbootstrap")
    aports = CI.checkout("https://gitlab.postmarketos.org/postmarketOS/pmaports.git",
        "07baef3332c46bd6c7cc3293b87ef5104fc56f5d", state / "pmaports")
    CI.run(["git", "-C", str(state / "pmaports"), "update-ref", "refs/remotes/origin/main", aports])
    snapshot = state / "snapshot"
    shutil.copytree(HERE / "pmaports-snapshot", snapshot)
    CI.run(["sh", str(snapshot / "hydrate-snapshot.sh")])
    CI.seed_missing_aports(snapshot, state / "pmaports")
    generated_aport(state / "pmaports/main/dior-graphics", payload, origin, source_commit)
    cfg = configparser.ConfigParser(interpolation=None)
    cfg["pmbootstrap"] = {"aports": str(state / "pmaports"), "work": str(state / "work"),
        "device": "xiaomi-dior", "ui": "console", "service_manager": "openrc", "user": "dior",
        "hostname": "dior-flowboard", "is_default_channel": "False", "ssh_keys": "False",
        "ui_extras": "False", "timezone": "Asia/Shanghai", "build_default_device_arch": "True",
        "boot_size": "512", "extra_space": "0"}
    cfg["providers"] = {}
    with (state / "pmbootstrap_v3.cfg").open("w", encoding="utf-8") as stream:
        cfg.write(stream)
    command = lambda *args, **kwargs: CI.run(CI.pmb_arguments(list(args), state), **kwargs)
    try:
        command("init", input_text="\n" * 80, timeout=600)
        command("build", "dior-graphics")
        packages = list((state / "work/packages").glob("*/armv7/dior-graphics-17.3.9-r5.apk"))
        if len(packages) != 1:
            raise RuntimeError("Expected exactly one hotfix APK")
        package = packages[0]
        acceptance = verified_hotfix_package(package, origin, source_commit)
        shutil.copy2(package, output / package.name)
        manifest = {"build_mode": "libdrm_only_hotfix", "source_commit": source_commit,
            "base_source_commit": BASE_COMMIT, "base_ci_run": int(BASE_RUN), "base_apk_sha256": BASE_SHA256,
            "pmbootstrap_commit": pmb, "pmaports_commit": aports,
            "package": package.name, "package_sha256": CI.sha256(package),
            "mesa_recompiled": False, "kernel_source_changed": False,
            "install_prefix": "/opt/dior-graphics", "soname_provider_prefix": "dior-graphics:",
            "physical_gpu_render_verified": False, **acceptance}
        (output / "GRAPHICS-HOTFIX-BUILD-VERIFICATION.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        (output / "SHA256SUMS").write_text("".join(CI.sha256(p) + "  " + p.name + "\n"
            for p in sorted(output.iterdir()) if p.is_file() and p.name != "SHA256SUMS"), encoding="ascii")
        print(json.dumps(manifest, indent=2), flush=True)
    finally:
        command("shutdown")


if __name__ == "__main__":
    build()
