# Dior local streaming ASR installation

This package contains the selected CPU model, a bounded local Unix-socket broker,
the ARMv7 worker, client, source changes and build provenance. It does not contain
or modify the private Android SDK, kernel, GPU driver, website, tunnel, microphone
configuration or any boot partition. It does not record or store audio.

The package must be built after `asr-broker.py`, `asr-client.py` and `dior-asr.json`
are finalized. From the public source root, provide the qualified binary and
the externally downloaded standard model directory:

```sh
python3 runtime/package-runtime.py \
  --worker /path/to/qualified/stream-worker \
  --model-dir /path/to/standard-bilingual32-model \
  --output /path/to/package-output --verify-only
# Remove --verify-only to write the deterministic tarball.
```

The selected output's `PACKAGE.json` contains the complete archive SHA256.
Tar ordering, ownership, timestamps and gzip timestamps are deterministic. The
package includes only seven inference files from the root bilingual32 model;
test recordings, alternate models and large archived dependencies are excluded.
The public source tree has portable build parameters and pinned provenance;
no personal build paths are required. Reproduction requires the fixed upstream
sources, NDK and dependencies at caller-selected paths, as documented in
`../BUILDING.md`; these tools/dependencies are not installed on the phone.

On the authorized phone, as root, use the freshly verified digest:

```sh
sh install-asr.sh --archive /path/to/dior-asr-runtime.tar.gz --sha256 DIGEST --validate-only
sh install-asr.sh --archive /path/to/dior-asr-runtime.tar.gz --sha256 DIGEST
rc-service --nodeps dior-asr status
python3 /opt/dior-asr/asr-client.py --ready
```

`--validate-only` reads the package without modifying accounts, files or services.
The installer requires the existing root-owned `/opt/dior-android` runtime and
Alpine Python 3/OpenRC. It verifies the archive, every file and the config before
stopping the ASR service. It never uses `tar.extractall()` or follows package
links. Only the fixed `/opt/dior-asr`, `/etc/dior-asr.json` and
`/etc/init.d/dior-asr` install paths are written.

The service uses its own `dior-asr` system account with `/sbin/nologin`, without
wheel/audio/video or other supplemental groups. Existing `dior` and `flowboard`
accounts are added only to the ASR client group. Newly added group membership is
effective for their next login/process launch; installing ASR does not restart
FlowBoard. The socket directory is `dior-asr:dior-asr` mode 0750, and the broker
uses a group-readable/writable socket with mode 0660. Client-group members can
call ASR but cannot replace files in the socket directory. Program/model files
are root-owned and non-writable by the service account.

OpenRC uses `supervise-daemon`; the broker remains in the foreground. Only
`localmount` is required. It waits 5 seconds between crashes and allows at most
5 respawns in a 60-second period. The broker and worker run with passive OpenMP
waiting. Supervisor stdout/stderr go to `/dev/null`, so they cannot create an
append-only disk log. The worker stays CPU-only and the broker's active request,
queue, chunk and stream limits provide the run-time bounds.

Every start performs a read-only config and model hash check through
`asr-broker.py --check-config`. Installation then requires a successful real
`asr-client.py --ready` response before enabling the default boot runlevel.
Only `rc-service --nodeps dior-asr` is controlled, avoiding dependency-driven
changes to unrelated website/tunnel services.

An upgrade verifies the installed model and refuses to change it. The previous
program, source/config and service script are saved under
`/opt/dior-asr.previous`, with a maximum 16MiB program backup. The large model is
not duplicated. Only one committed program backup is kept; incomplete upgrades
are restored on the next installer invocation. A failed start/readiness check
restores the previous code/config and prior service/runlevel state. Dedicated
system account and group additions are retained even if installation rolls back.

The benchmark/source build records distinguish the actual source commit
`c794e1439fce79932e989220aa1c2848ecbdcdcf` from the upstream release getter's
parent SHA. They are provenance, not evidence of accuracy or real microphone
latency; the parent task's phone comparison and service regressions provide that
evidence. The frozen package was actually installed and validated on the phone;
37 immutable files, dedicated account/socket permissions, ordinary client
access and an ASR-only restart passed. See `../evidence/phone-result.json`.
Future rebuilt source packages must undergo their own installation/device gate.

OpenRC behavior was checked against the official
[supervise-daemon guide](https://github.com/OpenRC/openrc/blob/master/supervise-daemon-guide.md)
and [shell implementation](https://github.com/OpenRC/openrc/blob/master/sh/supervise-daemon.sh).
