#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ImageDirectory = (Join-Path $PSScriptRoot 'dior-v1'),
    [string]$FastbootPath = (Join-Path $PSScriptRoot 'platform-tools/fastboot.exe'),
    [switch]$Flash,
    [switch]$NoReboot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-DiorManifest([string]$Path) {
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($Path)) {
        if ($line -match '^([a-z_]+)=(.*)$') {
            if ($values.ContainsKey($Matches[1])) { throw "Duplicate manifest field: $($Matches[1])" }
            $values[$Matches[1]] = $Matches[2]
        }
    }
    return $values
}

function Get-DiorFile([string]$Directory, [string]$RelativePath) {
    if ($RelativePath.StartsWith('./')) { $RelativePath = $RelativePath.Substring(2) }
    if ($RelativePath -notmatch '^[A-Za-z0-9_./-]+$' -or
        @($RelativePath.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) {
        throw "Unsafe path in bundle: $RelativePath"
    }
    $current = [IO.Path]::GetFullPath($Directory)
    foreach ($part in $RelativePath.Split('/')) {
        $current = Join-Path $current $part
        $item = Get-Item -LiteralPath $current -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Links are not accepted in a flash bundle: $RelativePath"
        }
    }
    if (-not [IO.File]::Exists($current)) { throw "Missing bundle file: $RelativePath" }
    return $current
}

function Get-DiorImageSize([string]$Path, [switch]$Boot) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($Boot) {
            if ($stream.Length -lt 2048 -or
                [Text.Encoding]::ASCII.GetString($reader.ReadBytes(8)) -cne 'ANDROID!') {
                throw 'Invalid Android boot image.'
            }
            return [long]$stream.Length
        }
        if ($stream.Length -lt 28) { throw 'Truncated rootfs image.' }
        $magic = $reader.ReadUInt32()
        if ($magic -eq 0xed26ff3aL) {
            # Android sparse image: compare EXPANDED size, not compressed bytes.
            $major = $reader.ReadUInt16(); $null = $reader.ReadUInt16()
            $headerSize = $reader.ReadUInt16(); $chunkHeaderSize = $reader.ReadUInt16()
            $blockSize = $reader.ReadUInt32(); $blockCount = $reader.ReadUInt32()
            $chunkCount = $reader.ReadUInt32(); $null = $reader.ReadUInt32()
            if ($major -ne 1 -or $headerSize -lt 28 -or $chunkHeaderSize -lt 12 -or
                $blockSize -eq 0 -or ($blockSize % 4) -ne 0 -or $chunkCount -eq 0) {
                throw 'Unsupported sparse rootfs header.'
            }
            [long]$blocks = 0; $stream.Position = $headerSize
            for ([long]$i = 0; $i -lt $chunkCount; $i++) {
                if ($stream.Position + $chunkHeaderSize -gt $stream.Length) { throw 'Truncated sparse chunk.' }
                $chunkStart = $stream.Position
                $type = $reader.ReadUInt16(); $null = $reader.ReadUInt16()
                $count = $reader.ReadUInt32(); $total = $reader.ReadUInt32()
                [long]$payload = [long]$total - $chunkHeaderSize
                if ($payload -lt 0 -or $chunkStart + $total -gt $stream.Length) { throw 'Invalid sparse chunk size.' }
                switch ($type) {
                    0xcac1 { if ($payload -ne ([long]$count * $blockSize)) { throw 'Invalid raw sparse chunk.' } }
                    0xcac2 { if ($payload -ne 4) { throw 'Invalid fill sparse chunk.' } }
                    0xcac3 { if ($payload -ne 0) { throw 'Invalid skip sparse chunk.' } }
                    0xcac4 { if ($payload -ne 4 -or $count -ne 0) { throw 'Invalid CRC sparse chunk.' } }
                    default { throw 'Unknown sparse chunk type.' }
                }
                $blocks += $count
                $stream.Position = $chunkStart + $total
            }
            if ($blocks -ne $blockCount -or $stream.Position -ne $stream.Length) { throw 'Inconsistent sparse image.' }
            [long]$size = [long]$blockSize * $blockCount
        } else {
            [long]$size = $stream.Length
            if ($size -lt 512) { throw 'Truncated raw disk image.' }
            $stream.Position = 510
            if ($reader.ReadUInt16() -ne 0xaa55) { throw 'Standard rootfs is missing its partition-table signature.' }
        }
        if ($size -lt 16777216) { throw 'Rootfs image is implausibly small.' }
        return $size
    } finally { $reader.Dispose() }
}

function Test-DiorBundle([string]$Directory) {
    $root = (Get-Item -LiteralPath $Directory -Force).FullName
    if (((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Bundle directory must not be a link.'
    }
    $checksums = Get-DiorFile $root 'SHA256SUMS'
    $checked = @{}
    foreach ($line in [IO.File]::ReadAllLines($checksums)) {
        if ($line -notmatch '^([a-fA-F0-9]{64}) [ *](.+)$') { throw 'Malformed SHA256SUMS.' }
        $expected = $Matches[1]; $name = $Matches[2]
        if ($name.StartsWith('./')) { $name = $name.Substring(2) }
        if ($checked.ContainsKey($name)) { throw "Duplicate checksum: $name" }
        $file = Get-DiorFile $root $name
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $expected) {
            throw "Checksum mismatch: $name"
        }
        $checked[$name] = $true
    }
    foreach ($required in @('BUILD-MANIFEST.txt', 'BUILD-STATUS.txt', 'FLASH-PLAN.json',
                            'boot.img-xiaomi-dior', 'xiaomi-dior.img')) {
        if (-not $checked.ContainsKey($required)) { throw "Required file is not checksummed: $required" }
    }
    $manifest = Read-DiorManifest (Get-DiorFile $root 'BUILD-MANIFEST.txt')
    foreach ($key in @('target_device', 'target_arch', 'install_mode', 'repository_revision')) {
        if (-not $manifest.ContainsKey($key)) { throw "Missing manifest field: $key" }
    }
    if ($manifest.target_device -cne 'dior' -or $manifest.target_arch -cne 'armv7' -or
        $manifest.install_mode -cne 'standard') { throw 'Not a dior ARMv7 standard image.' }
    $plan = Get-Content -LiteralPath (Get-DiorFile $root 'FLASH-PLAN.json') -Raw | ConvertFrom-Json
    if ($plan.schema -cne 'dior-v1-flash-plan-1' -or $plan.repository -cne 'zhuge1993/canvas-editor' -or
        $plan.source_commit -cne $manifest.repository_revision -or $plan.source_commit -notmatch '^[a-f0-9]{40}$' -or
        $plan.build_conclusion -cne 'success' -or "$($plan.build_run_id)" -notmatch '^[1-9][0-9]+$' -or
        $plan.target_device -cne 'dior' -or $plan.install_mode -cne 'standard' -or
        $plan.boot_file -cne 'boot.img-xiaomi-dior' -or $plan.rootfs_file -cne 'xiaomi-dior.img' -or
        $plan.boot_partition -cne 'boot' -or $plan.rootfs_partition -cnotin @('userdata', 'system')) {
        throw 'Invalid or unverified flash plan. Do not guess the rootfs partition.'
    }
    return [pscustomobject]@{
        Root = $root; Plan = $plan
        Boot = (Get-DiorFile $root $plan.boot_file)
        Rootfs = (Get-DiorFile $root $plan.rootfs_file)
        BootBytes = (Get-DiorImageSize (Get-DiorFile $root $plan.boot_file) -Boot)
        RootfsBytes = (Get-DiorImageSize (Get-DiorFile $root $plan.rootfs_file))
    }
}

function Invoke-DiorFastboot([string]$Executable, [string[]]$Arguments) {
    # Windows paths cannot contain quotes. These are fixed commands and validated
    # serials, not shell expressions. No shell is used to invoke the executable.
    foreach ($arg in $Arguments) {
        if ($arg -match '["\r\n]' -or $arg.EndsWith('\')) { throw 'Unsafe Fastboot argument.' }
    }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = (($Arguments | ForEach-Object { '"' + $_ + '"' }) -join ' ')
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.CreateNoWindow = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        $null = $process.Start()
        $outTask = $process.StandardOutput.ReadToEndAsync()
        $errTask = $process.StandardError.ReadToEndAsync()
        # Never interrupt an active write with a read-query timeout.
        if ($Arguments -contains 'flash' -or $Arguments -contains 'flash:raw') {
            $process.WaitForExit()
        } elseif (-not $process.WaitForExit(20000)) {
            $process.Kill(); throw 'Fastboot query timed out. No further commands will run.'
        }
        $text = $outTask.Result + "`n" + $errTask.Result
        if ($process.ExitCode -ne 0) { throw "Fastboot failed: $text" }
        return $text.Trim()
    } finally { $process.Dispose() }
}

function Get-DiorSerial([string]$Executable) {
    $text = Invoke-DiorFastboot $Executable @('devices')
    $serials = @()
    foreach ($line in ($text -split "`r?`n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^([A-Za-z0-9_.:-]+)\s+fastboot\s*$') { throw "Unexpected Fastboot device output: $line" }
        $serials += $Matches[1]
    }
    if ($serials.Count -ne 1) { throw 'Connect exactly one phone in Fastboot mode.' }
    return $serials[0]
}

function Get-DiorVariable([string]$Executable, [string]$Serial, [string]$Name) {
    $text = Invoke-DiorFastboot $Executable @('-s', $Serial, 'getvar', $Name)
    $pattern = '^\s*(?:\(bootloader\)\s*)?' + [regex]::Escape($Name) + ':\s*(.*?)\s*$'
    $values = @()
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match $pattern) { $values += $Matches[1] }
    }
    if ($values.Count -ne 1 -or [string]::IsNullOrWhiteSpace($values[0])) { throw "Cannot read device variable: $Name" }
    return $values[0]
}

function Assert-DiorPhone([string]$Executable, [string]$Serial) {
    if ((Get-DiorSerial $Executable) -cne $Serial) { throw 'Connected phone changed. Stopped.' }
    if ((Get-DiorVariable $Executable $Serial 'product') -cne 'dior') { throw 'Phone product is not exactly dior.' }
}

function Assert-DiorCapacity([string]$Executable, [string]$Serial, [string]$Partition, [long]$Bytes) {
    $value = Get-DiorVariable $Executable $Serial ('partition-size:' + $Partition)
    if ($value -match '^0x[0-9a-fA-F]+$') { $capacity = [Convert]::ToInt64($value.Substring(2), 16) }
    elseif ($value -match '^[0-9]+$') { $capacity = [Convert]::ToInt64($value, 10) }
    else { throw "Unknown partition size: $Partition" }
    if ($capacity -le 0 -or $Bytes -gt $capacity) { throw "Image is larger than partition $Partition. Nothing has been written." }
}

function Read-DiorConfirmation { return (Read-Host 'This erases target partitions. Type DIOR only after backing up your phone') }

function Start-DiorFlash([string]$Directory, [string]$Executable, [bool]$Write, [bool]$KeepFastboot) {
    $bundle = Test-DiorBundle $Directory
    $exe = (Get-Item -LiteralPath $Executable).FullName
    $serial = Get-DiorSerial $exe
    Assert-DiorPhone $exe $serial
    # Both capacities must pass before the FIRST write.
    Assert-DiorCapacity $exe $serial 'boot' $bundle.BootBytes
    Assert-DiorCapacity $exe $serial $bundle.Plan.rootfs_partition $bundle.RootfsBytes
    Write-Host "Verified dior: $serial"
    Write-Host "boot <- $($bundle.Boot)"
    Write-Host "$($bundle.Plan.rootfs_partition) <- $($bundle.Rootfs)"
    if (-not $Write) { Write-Host 'CHECK ONLY: no partitions were written.'; return }
    if ((Read-DiorConfirmation) -cne 'DIOR') { throw 'Cancelled; no partitions were written.' }
    # Recheck files after the user has confirmed, before issuing writes.
    $bundle = Test-DiorBundle $Directory
    Assert-DiorPhone $exe $serial
    Assert-DiorCapacity $exe $serial 'boot' $bundle.BootBytes
    Assert-DiorCapacity $exe $serial $bundle.Plan.rootfs_partition $bundle.RootfsBytes
    Write-Host 'Writing boot. Do not unplug the phone.'
    Write-Host (Invoke-DiorFastboot $exe @('-s', $serial, 'flash:raw', 'boot', $bundle.Boot))
    Assert-DiorPhone $exe $serial
    Write-Host "Writing $($bundle.Plan.rootfs_partition). Do not unplug the phone."
    Write-Host (Invoke-DiorFastboot $exe @('-s', $serial, 'flash', $bundle.Plan.rootfs_partition, $bundle.Rootfs))
    if (-not $KeepFastboot) {
        Assert-DiorPhone $exe $serial
        Write-Host (Invoke-DiorFastboot $exe @('-s', $serial, 'reboot'))
    }
    Write-Host 'Fastboot writes completed. A successful Linux boot still needs to be checked on the phone.'
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Start-DiorFlash $ImageDirectory $FastbootPath ([bool]$Flash) ([bool]$NoReboot) }
    catch { Write-Host ("STOPPED: " + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
