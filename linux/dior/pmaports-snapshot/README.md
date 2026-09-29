# dior pmaports snapshot

This directory is pinned as a **hardware/kernel provenance snapshot** for Xiaomi Redmi Note 4G (`xiaomi-dior`).

It is **not currently a standalone buildable pmaports tree**.

The pinned `linux-xiaomi-dior/APKBUILD` references these six patch files, which are not present in this snapshot yet:

- `gcc10-extern_YYLOC_global_declaration.patch`
- `linux3.4-vfs-Fix-proc-tid-fdinfo-fd-file-handling.patch`
- `kernel-use-the-gnu89-standard-explicitly.patch`
- `linux3.4-ARM-8933-1-replace-Sun-Solaris-style-flag-on-section.patch`
- `0001-fix-refresh-rate.patch`
- `0001-framebuffer-fixes.patch`

Do not claim that this directory alone can build a bootable image until all referenced sources are present and their hashes match the APKBUILD.

The production image path in this repository uses `linux/dior/build-image.sh`, which injects FlowBoard into a pmbootstrap/pmaports checkout that already contains a complete `xiaomi-dior` device/kernel package. The script validates the device package before starting the expensive build.

The old device definition confirms the important hardware facts used by the build:

- codename: `xiaomi-dior`
- architecture: `armv7`
- flash method: fastboot
- downstream kernel: Linux 3.4 / MSM8226 family
- boot image: qcdt Android boot image
