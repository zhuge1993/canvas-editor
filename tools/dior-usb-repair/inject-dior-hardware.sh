#!/bin/sh
set -eu

ROOT="${1:?usage: inject-dior-hardware.sh ROOTFS_MOUNT}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
COMMIT="421527f4e54d645adaf762b4f14cc5fd4d19a5b5"
FW_BASE="https://raw.githubusercontent.com/msfkonsole/proprietary_vendor_xiaomi/$COMMIT/dior/proprietary/etc/firmware"
ACDB_BASE="https://raw.githubusercontent.com/msfkonsole/proprietary_vendor_xiaomi/$COMMIT/dior/proprietary/etc/acdbdata/MTP"

need(){ command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
need curl
need sha512sum
need install
need mkdir
need cp

fetch_checked() {
	url="$1"; expected="$2"; dest="$3"
	tmp="$dest.tmp.$$"
	mkdir -p "$(dirname "$dest")"
	curl -fL --retry 3 --connect-timeout 20 --max-time 180 -o "$tmp" "$url"
	printf '%s  %s\n' "$expected" "$tmp" | sha512sum -c -
	mv "$tmp" "$dest"
}

install -Dm755 "$REPO_ROOT/tools/dior-hw/dior-hw-probe" "$ROOT/usr/local/sbin/dior-hw-probe"
install -Dm755 "$REPO_ROOT/tools/dior-hw/dior-touch-test" "$ROOT/usr/local/sbin/dior-touch-test"
install -Dm755 "$REPO_ROOT/tools/dior-hw/dior-hw-verify" "$ROOT/usr/local/sbin/dior-hw-verify"
install -Dm755 "$REPO_ROOT/linux/dior/flowboard-apk/dior-firmware.initd" "$ROOT/etc/init.d/dior-firmware"
install -Dm755 "$REPO_ROOT/linux/dior/flowboard-apk/dior-adsp.initd" "$ROOT/etc/init.d/dior-adsp"
mkdir -p "$ROOT/etc/runlevels/default"
ln -sf /etc/init.d/dior-firmware "$ROOT/etc/runlevels/default/dior-firmware"
ln -sf /etc/init.d/dior-adsp "$ROOT/etc/runlevels/default/dior-adsp"

# Mirror WCNSS/Prima already present in the verified historical rootfs.
test -s "$ROOT/lib/firmware/postmarketos/wcnss.mdt"
for fw in "$ROOT"/lib/firmware/postmarketos/wcnss.*; do
	cp -a "$fw" "$ROOT/lib/firmware/$(basename "$fw")"
done
test -s "$ROOT/lib/firmware/postmarketos/wlan/prima/WCNSS_qcom_wlan_nv.bin"
mkdir -p "$ROOT/lib/firmware/wlan/prima" "$ROOT/etc/firmware/wlan/prima"
cp -a "$ROOT"/lib/firmware/postmarketos/wlan/prima/* "$ROOT/lib/firmware/wlan/prima/"
cp -a "$ROOT"/lib/firmware/postmarketos/wlan/prima/* "$ROOT/etc/firmware/wlan/prima/"

# Dior-specific Venus and camera CPP firmware, locked to the same proprietary commit.
while read -r hash name; do
	[ -n "$hash" ] || continue
	fetch_checked "$FW_BASE/$name" "$hash" "$ROOT/lib/firmware/$name"
	install -Dm644 "$ROOT/lib/firmware/$name" "$ROOT/etc/firmware/$name"
done <<'EOF'
f2938fef8bfb25780bcab1d614643493c99bb62b91ac5f97a25aac214a2570adb9924b1c1fa684b18eb15087a7dd38082e68809ee00f22031a84f4855c480337 venus.b00
4c9a4dc1f342297afb57d0589089934d286d3ff09761bb5cb167e226d614f01483ff915cb6301634f269c8c8e780eb45330d48986e0c0c4e54d59a8c65717b14 venus.b01
6cd7fbb759957e13d5a490f679c8b8384ff742da7880c1cb7558198e46db8908ba18ed5fef1cd1b24ee608940592ce2025dd0ed0c829f5e4dca787e5ac09374f venus.b02
e5ddd216db23f71dd9cb97377c9458b2112437dbc4e83cdb9043e1f21bc9cf4a8bbed6dae17a5bbe335d1208dbefda391287258d5a689585fb12e2cab329ce37 venus.b03
7a2d29ff9398c5584e8a2267f1916b4ed16f662dd134fb8a04be38c332646e4df6b792b65b1f5caa35e492c84c4a26f018d258ac937ad0896e0f76f44f6df300 venus.b04
cf17bd7293a25ae84153ee0686a70ec36272eceebb1796f63cd2fbffdc5fe40a412de3e006fdc54be305f18fb5224f137db3bacfeb7c7a9b5a6509cc79aedea5 venus.mbn
4f293009d2606b6548b537ab018a7c64afaae3c2b90cc48e6c441cc9f0c79cf6de0e1bb9587ccbe1128a0d77b86f0f63648ec5c57219c754a363eb45a5edde71 venus.mdt
e4caa5e980eaa3e1f33f233ec2dd0643f61c5984690539311e092dcb0165612dffe2b7d0876e80abc8b710aeff11dd4e557c4b958ecf2b44b155e0f8685b6638 cpp_firmware_v1_1_1.fw
a024e20b0212392aa744245e675fe7ffd2e71b70e108f74684140fb9ffcf78b871af0d883ecc14daedc9146ef89bc997420ae80dab0c5db0fc919416cb03fd11 cpp_firmware_v1_1_6.fw
b3ee274b8de7b4a371be4c54c7fb948a96b117dfc844612afa69c807a831922203c2611a84a1710db630f2986e256d656cc3c1f257b17794b7ee3e5a6542f267 cpp_firmware_v1_2_0.fw
EOF

# Dior MTP audio calibration database.
while read -r hash name; do
	[ -n "$hash" ] || continue
	fetch_checked "$ACDB_BASE/$name" "$hash" "$ROOT/etc/acdbdata/MTP/$name"
done <<'EOF'
a722ba855a74b241dcfe4cd8e48ea2298b4668bebc290ab1ebd72fbc51542fd9fb67bb5a665d11764f643a1ad694f36b5c0dc464d345404c9e490caeb1eb0b2a MTP_Bluetooth_cal.acdb
982f30d96e8f8ecbc143ddd8d9513392b2c98061cf3299da38b04bc5c652576ade178fa8eae215394063f196d5c4e1fa29db082ce9f7a5e61d895fb0d17a71dd MTP_General_cal.acdb
463006ece611ddbcfa9a216297b306b582b9a236565d5362c4fd8025c17eef5272374336d2d39ffb94a3ac35f3a6b4332ca43207ad6959a50ba4817e45ebbf77 MTP_Global_cal.acdb
dda88b4535c1d5eba83022ed7ab62594a39fd3ed2fc65d88031f30ffd79ab886b52000faa437f21492943b5f7d92e5f252a9b7a63957b7d10c7b598142230ab1 MTP_Handset_cal.acdb
81fcc532b4f9482be73d80e49766143d4e082884effbc2968e1aefb4bec3cf93803c587d4a18af9725d3c61744cb5a37c5371117785e152a65f854c0f5927d19 MTP_Hdmi_cal.acdb
518f58d17c9da47ae62b02dfe9df1caefd536037638a82c633eb3d80d1ed35c82232a5e394c721186bb681b1b3dada14dd7f4a09db185a477fe42e6f65078f7e MTP_Headset_cal.acdb
0d91dbf95a0472210ad94703410571941328e8eea5cbf9b0423bee4ef4304045084b9aebfbdeaac1793ea41eafc9663899af93cd8bb6dd19c54250a6968a5f05 MTP_Speaker_cal.acdb
EOF

test -s "$ROOT/lib/firmware/wcnss.mdt"
test -s "$ROOT/lib/firmware/venus.mdt"
test -s "$ROOT/etc/firmware/cpp_firmware_v1_2_0.fw"
test -s "$ROOT/etc/acdbdata/MTP/MTP_Speaker_cal.acdb"
test -x "$ROOT/etc/init.d/dior-firmware"
test -x "$ROOT/etc/init.d/dior-adsp"
test -x "$ROOT/usr/local/sbin/dior-hw-verify"

echo "Dior hardware userspace/firmware injection complete."
