#!/usr/bin/env python3
"""Offline native syntax checks. Never runs login/create/run or opens a tunnel."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


def run(command):
    result = subprocess.run([str(arg) for arg in command], capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise RuntimeError(f"Native syntax check failed ({result.returncode}): {result.stdout} {result.stderr}")
    return {"exit_code": result.returncode, "stdout": result.stdout.strip(), "stderr": result.stderr.strip()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=Path, required=True)
    parser.add_argument("--openssl", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    base = Path(__file__).parent
    suffix = ".exe" if (args.clients / "cloudflared.exe").is_file() else ""
    clients = {name: (args.clients / (name + suffix)).resolve() for name in ("cloudflared", "frpc", "frps")}
    report = {"scope": "offline_native_config_parser", "native_os": "windows" if suffix else "linux",
              "public_connectivity_verified": False, "account_or_tunnel_created": False, "checks": {}}
    for name, binary in clients.items():
        report["checks"][name + "_version"] = run([binary, "--version"])
    empty_config = "NUL" if suffix else "/dev/null"
    quick_help = run([clients["cloudflared"], "tunnel", "--config", empty_config, "--origincert", empty_config,
                      "--url", "http://127.0.0.1:3000", "--protocol", "http2", "--edge-ip-version", "4",
                      "--no-autoupdate", "--metrics", "127.0.0.1:20241", "--loglevel", "info",
                      "--grace-period", "10s", "--help"])
    report["checks"]["quick_arguments"] = {"exit_code": quick_help["exit_code"], "scope": "argument parser with --help; no provisioning"}
    with tempfile.TemporaryDirectory(prefix="dior-tunnel-parser-") as folder:
        temporary = Path(folder)
        token = temporary / "test-token"
        token.write_text("Dior-native-parser-test-only-no-account", encoding="utf-8")
        ca, key = temporary / "ca.crt", temporary / "test.key"
        run([args.openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
             "-out", ca, "-days", "1", "-subj", "/CN=Dior-parser-test-only"])
        cloud = (base / "cloudflare.yml.example").read_text(encoding="utf-8")
        cloud = cloud.replace("REPLACE_WITH_TUNNEL_UUID", "01234567-89ab-4def-8123-456789abcdef")
        cloud = cloud.replace("REPLACE_WITH_FIXED_HOSTNAME", "board.parser-test.invalid")
        # Native ingress validation does not need a real account credential.
        cloud = cloud.replace("/var/log/dior-tunnel", temporary.as_posix())
        cloud_path = temporary / "cloudflare.yml"
        cloud_path.write_text(cloud, encoding="utf-8", newline="\n")
        report["checks"]["cloudflare_ingress"] = run([clients["cloudflared"], "tunnel", "--config", cloud_path,
            "--no-autoupdate", "--protocol", "http2", "--edge-ip-version", "4", "--metrics", "127.0.0.1:20241",
            "--loglevel", "warn", "--log-directory", temporary, "ingress", "validate"])
        frpc = (base / "frpc.toml.example").read_text(encoding="utf-8")
        frpc = frpc.replace("REPLACE_WITH_VPS_HOSTNAME", "vps.parser-test.invalid")
        frpc = frpc.replace("/etc/dior-tunnel/frp-token", token.as_posix())
        frpc = frpc.replace("/etc/dior-tunnel/frp-ca.crt", ca.as_posix())
        frpc = frpc.replace("/var/log/dior-tunnel/frpc.log", (temporary / "frpc.log").as_posix())
        frpc_path = temporary / "frpc.toml"
        frpc_path.write_text(frpc, encoding="utf-8", newline="\n")
        report["checks"]["frpc_configuration"] = run([clients["frpc"], "verify", "-c", frpc_path])
        frps = (base / "frps.toml.example").read_text(encoding="utf-8")
        frps = frps.replace("/etc/frp/dior-token", token.as_posix()).replace("/etc/frp/server.crt", ca.as_posix())
        frps = frps.replace("/etc/frp/server.key", key.as_posix()).replace("/var/log/frp/frps.log", (temporary / "frps.log").as_posix())
        frps_path = temporary / "frps.toml"
        frps_path.write_text(frps, encoding="utf-8", newline="\n")
        report["checks"]["frps_configuration"] = run([clients["frps"], "verify", "-c", frps_path])
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"scope": report["scope"], "native_os": report["native_os"],
                      "checks": {key: value["exit_code"] for key, value in report["checks"].items()},
                      "public_connectivity_verified": False}))


if __name__ == "__main__":
    main()
