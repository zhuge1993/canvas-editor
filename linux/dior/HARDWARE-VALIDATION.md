# Dior Linux 3.4 hardware validation

The kernel source remains `msfkonsole/android_kernel_xiaomi_dior` at
`12f40d54ab4e34dabaeb8dd7979bedc3cc8fa064`. Kernel candidates are compiled
with GCC4. A candidate boot image must reuse the device's original ramdisk,
QCDT/DTB, command line and header settings. Only the boot partition is flashed.

The earlier 33 passing checks covered interfaces and services. They did not
establish sound, camera frames, a GPS fix, motion samples, hardware GLES,
Bluetooth transfers, WiFi authentication or external storage transfers.

## Audio measurements on the r6 kernel

The `3.4.0-msf #7-postmarketOS` kernel can deliver sound with the verified
Tapan RX4 speaker route when writes are aligned to the 1200-frame DSP period.
The initial 2048-frame transfer exposed a driver bug: one DSP buffer was
copied while ALSA accounted for the entire request. The r7 PCM patch addresses
that contract and the associated per-stream cursors, completion lengths,
startup, stop and worker lifetime. Its host tests do not establish physical
playback on the new kernel; boot and arbitrary-chunk regression remain required.

The acoustic test uses the phone's AMIC1/ADC1/DEC1 capture route, not the
codec's digital RX4 loopback. It plays a 440 Hz segment, a silent interval and
an 880 Hz segment and retains frequency-window statistics only. No recording
is saved. Both playback and capture must complete, detected frequencies must
follow the expected order, and a muted-speaker control must lose both tones.

| r6 measurement | Result |
| --- | --- |
| COMP0 disabled; AMIC1 capture 115200 frames | Both tones detected; peak 5085 |
| COMP0 enabled; AMIC1 capture 115200 frames | Both tones detected; peak 5963 |
| Speaker DAC disabled; same PCM test | Neither tone detected; peak 576 |
| Mixer restoration | Every changed value restored and read back |
| Human hearing confirmation | Not available for these measurements |

The standalone microphone test also captured 48000 frames with nonzero
signal. The separate RX4 digital loopback confirmed that PCM data reaches the
codec, but it alone cannot prove sound output.

The probes in `tools/` require root, `libasound.so.2`, Python 3, and the
explicitly verified device serial and sound card. Inspect first:

```sh
python3 dior-audio-functional-test.py --mode inspect
python3 dior-audio-functional-test.py --mode both
python3 dior-audio-acoustic-test.py --compander 0
python3 dior-audio-acoustic-test.py --compander 1
python3 dior-audio-acoustic-test.py --compander 0 --speaker-mute
```

The functional test deliberately uses 2048-frame requests to exercise the
new copy contract. The acoustic test uses period-aligned requests to separate
the acoustic path from that driver regression. Both roll back mixer values
on failure and keep audible confirmation separate from transfer completion.

## Other current limits

WiFi scanning and association were observed; the authorized 5 GHz network
did not complete authentication or DHCP on r6. An invalid NV MAC still
caused the old INI fallback. The r7 MAC patch selects valid existing addresses
first and otherwise derives a stable, locally administered address from the
full bootloader serial, without modifying any NV file. It does not recover a
factory MAC or prove an authenticated connection.

Starting the existing modem through IPC lookup brought the subsystem online
but subsequently triggered `subsys-restart: Resetting the SoC - modem crashed`.
The phone rebooted and recovered; the previous log was read from
`/proc/last_kmsg`. No partition or firmware was flashed. The IPC patches bound
security initialization waits and fix the repeated-lookup subsystem-reference
leak. They do not establish a GPS fix or resolve the modem crash.

The SENSOR SMD node returned ENODEV. Native AF_MSM_IPC reached QMI services,
but the actual SMGR metadata request timed out. Service 0x100 instance 0x100
is a loopback service and its echoed request is not a sensor response.
Actual motion samples remain unverified.

The camera-init patch exposes previously suppressed invalid-command and
sensor-probe errors. `/dev/video0` is the MSM configuration endpoint;
its presence does not establish capture frames. Hardware sensor probing,
mode tables, CSI/ISP configuration and buffers still require validation.

The system Mesa rendered through llvmpipe. The isolated legacy graphics
package and KGSL DRM configuration are candidates for a hardware path;
the locked KGSL DRM Kconfig requires global page tables, so the candidate
enables DRM/GENLOCK/MSM_KGSL_DRM and disables per-process page tables.
actual Adreno renderer identification and matching rendered pixels are
required. Bluetooth pairing/data transfer and OTG/TF read/write testing
require connected test partners or media.
