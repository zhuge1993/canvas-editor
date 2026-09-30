DiorLinux V1 USB repair candidate: rootfs only, no kernel compilation

USE ONLY with the already installed boot repair:
boot bytes: 13113344 (must remain <= 16777216)
boot sha256: 65373f60e3171e677d79fa792c31b7bd28c4d094a096056d7dc537b76b978601
Original rootfs: aceca7ee, run 36665014260.

This candidate modifies only startup files in the original rootfs partition.
Kernel, ramdisk, QCDT, inner boot filesystem, filesystem UUIDs and the entire
FlowBoard application remain unchanged. /etc/passwd, /etc/shadow, /etc/group
are checked byte-for-byte; the original PRIVATE-LOGIN file remains valid.
This does NOT preserve new data/configuration created on the physical phone
after the original flash. Writing userdata again replaces that data. Back up
anything important first, or stop if you cannot recover data you need.

Why no kernel rebuild:
The pinned kernel enables CONFIG_USB_G_ANDROID and its android.c explicitly
registers ncm, rndis and acm. This is NOT a g_ether/configfs configuration.
The repair configures /sys/class/android_usb/android0 with ncm,acm, enables
ACM's required tty transport, checks sysfs readbacks, configures usb0, and
starts a password-required COM-port login before OpenRC startup.
No root/guest auto-login, no SSH authentication bypass, no public port 3000.

Windows 11:
Expected rootfs-stage USB IDs: 18d1:d002 (NCM+ACM).
Expected class drivers: UsbNcm.sys for CDC-NCM (02/0d/00), Usbser.sys for ACM.
A normal Windows 11 installation includes them; no third-party driver is
bundled or required by design. This exact candidate has NOT been USB-tested
on physical dior hardware or Windows 11 25H2. A driver file being present
is not proof that enumeration/data transfer will succeed.
If the kernel cannot bind NCM, the script tries 18d1:d003 RNDIS+ACM, then
18d1:d004 ACM-only. It does not silently fall back to Windows-incompatible ECM.
These fallbacks handle device-side binding errors, not host-side incompatibility.

If RNDIS appears without a network driver, inspect its actual interface IDs
first. Only for the RNDIS child interface (not Composite parent/Fastboot):
Device Manager > Update driver > Browse my computer > Let me pick > Network
adapters > Microsoft > Remote NDIS Compatible Device, if that signed in-box
option is actually available. Never force NCM/RNDIS drivers onto an ECM
interface; never disable signature enforcement or install unknown drivers.

After successful userdata write and reboot:
1. Allow the transient initramfs USB device to change to DiorLinux-NCM-ACM.
2. Check Windows Device Manager for the NCM network adapter and USB Serial COM.
3. DHCP should assign only the phone USB adapter 172.16.42.2/24.
   If DHCP does not work, set only that verified USB adapter to 172.16.42.2,
   mask 255.255.255.0, with NO default gateway or DNS. Do not alter the normal
   Internet adapter, enable Internet Sharing, or disable the firewall.
4. ssh dior@172.16.42.1 using the original private login file.
5. If SSH/network fails, use the enumerated ACM COM port, 115200 8N1,
   no flow control; press Enter and log in as dior using the same password.
   This is a real password prompt, not an automatic root console.
6. Collect uname -a, cat /proc/1/comm, ip addr, rc-status -a,
   cat /dev/dior-usb-early.log, sudo dmesg, nmcli device status,
   sudo rc-service wcnss-wlan status, sudo rc-service flowboard status.
   Do not share passwords, connection secrets or the private login file.

If d002/d003/d004 never appears, rootfs startup may not have reached inittab.
The earlier mass-storage -> ECM transition alone is NOT proof of switch_root.
Do not repeat flashes blindly; return the display and USB enumeration logs.
That result calls for early-boot diagnostics, not a fabricated success claim.

Do NOT run apk upgrade, mkinitfs or regenerate boot during this verification:
the original inner boot filesystem/package still contains the old large DT
image; this rootfs-only patch deliberately leaves the working flashed boot
alone. A future integrated boot/package repair must handle that separately.

This repair provides USB access for diagnosis. It does NOT certify working
Wi-Fi, Node on the physical kernel, or FlowBoard until checked on the phone.
