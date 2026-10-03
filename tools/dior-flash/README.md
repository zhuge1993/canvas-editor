# Dior V1 Windows flash client

These are client source files, **not a ROM and not a ready-to-flash download**.
They need a successfully built and separately verified V1 `dior-v1/` directory.
No script invokes Git, Node, pnpm, pmbootstrap or a compiler on the user's PC.

The final assembled download will contain:

- `check-phone.cmd`: read-only validation; never writes a partition.
- `flash-phone.cmd`: validates again, asks the human to type `DIOR`, then writes.
- `flash-dior.ps1`: Windows PowerShell 5.1 client.
- `dior-v1/`: real boot/rootfs, original build evidence and `FLASH-PLAN.json`.
- `platform-tools/fastboot.exe`: obtain the official Android Platform-Tools.

**Do not fabricate FLASH-PLAN.json to enable this client.** It must be assembled
from a successful hosted image build, with the rootfs partition resolved from
that build's exact deviceinfo and pmbootstrap version. In modern pmbootstrap,
unspecified rootfs partitions can default to `userdata`, not `system`. Do not
infer a partition from an old wiki's system-partition size.

The client checks both partition capacities BEFORE the first write. Unknown
partition size, missing plans, wrong devices, changed serials, missing/corrupt
images and cancelled confirmation stop it. It does not unlock, repartition,
flash recovery, run `flashall`, or restore an original Android ROM. Back up the
phone and have a matching dior recovery route before a real first flash.

PowerShell execution-policy override in the CMD wrappers applies only to that
process; it does not change the computer's policy persistently.

Tests: `powershell -NoProfile -File tools/dior-flash/test-flash-client.ps1`
Tests replace every Fastboot call with an in-process mock. No USB device is used.
A client-test success is not kernel-build or physical-phone-boot success.
