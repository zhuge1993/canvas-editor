# dior pmaports snapshot

This directory pins hardware/kernel provenance for Xiaomi Redmi Note 4G (`xiaomi-dior`).

The original `linux-xiaomi-dior/APKBUILD` references six patch files. They are intentionally verified by the original APKBUILD SHA-512 values before this snapshot may be used as a fallback.

The archived `firmware-xiaomi-dior` package also depends on the downstream `wcnss-wlan` helper. A fixed historical copy of that helper is pinned under `main/wcnss-wlan`, so a future pmaports cleanup cannot silently break the dior Wi-Fi dependency closure.

## Verify

```sh
sh linux/dior/pmaports-snapshot/check-snapshot.sh
```

The verifier checks:

- `config-xiaomi-dior.armv7`
- `gcc10-extern_YYLOC_global_declaration.patch`
- `linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch`
- `kernel-use-the-gnu89-standard-explicitly.patch`
- `linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch`
- `0001-fix-refresh-rate.patch`
- `0001-framebuffer-fixes.patch`
- `main/wcnss-wlan/wcnss-wlan.initd` against its APKBUILD SHA-512
- presence of `main/wcnss-wlan/wcnss-wlan-openrc.post-install`

No file is trusted only because its filename matches.

## Hydrate missing historical patches

On a networked Linux build host:

```sh
sh linux/dior/pmaports-snapshot/hydrate-snapshot.sh
```

The downloader uses fixed postmarketOS historical/raw sources and a 2025 pmaports mirror, then immediately runs the strict SHA-512 verifier. A wrong or changed mirror file fails the build.

`linux/dior/build-image.sh` automatically runs hydration when the active pmbootstrap pmaports no longer contains the dior device/kernel aport. Set:

```sh
HYDRATE_SNAPSHOT=0 ./linux/dior/build-image.sh
```

to forbid network hydration and require the snapshot to already be complete.

## Hardware provenance

The pinned device definition records:

- codename: `xiaomi-dior`
- architecture: `armv7`
- flash method: fastboot
- downstream kernel: Linux 3.4 / MSM8226 family
- qcdt Android boot image layout

This is why the project uses a modern postmarketOS/Alpine userspace on top of a device-specific downstream boot/kernel instead of pretending the phone can boot an arbitrary current Debian kernel.
