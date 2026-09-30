#requires -Version 5.1
[CmdletBinding()]
param(
    [string]$ImageDirectory = (Join-Path $PSScriptRoot "dior-directroot"),
    [string]$FastbootPath = (Join-Path $PSScriptRoot "platform-tools\fastboot.exe"),
    [switch]$Flash,
    [switch]$NoReboot
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-DirectRootFastboot([string]$Exe, [string[]]$Arguments) {
    foreach ($arg in $Arguments) { if ($arg -match "[`r`n`"]") { throw "Unsafe fastboot argument" } }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = (($Arguments | ForEach-Object { "`"$($_)`"" }) -join " ")
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $p = New-Object Diagnostics.Process
    $p.StartInfo = $psi
    try {
        $null = $p.Start()
        $stdout = $p.StandardOutput.ReadToEndAsync()
        $stderr = $p.StandardError.ReadToEndAsync()
        if ($Arguments -contains "flash") { $p.WaitForExit() }
        elseif (-not $p.WaitForExit(20000)) { $p.Kill(); throw "Fastboot query timed out" }
        $text = $stdout.Result + [Environment]::NewLine + $stderr.Result
        if ($p.ExitCode -ne 0) { throw "Fastboot failed: $text" }
        return $text.Trim()
    } finally { $p.Dispose() }
}

function Get-DirectRootSerial([string]$Exe) {
    $serials = @()
    foreach ($line in ((Invoke-DirectRootFastboot $Exe @("devices")) -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch "^([A-Za-z0-9_.:-]+)\s+fastboot\s*$") { throw "Unexpected fastboot devices output: $line" }
        $serials += $Matches[1]
    }
    if ($serials.Count -ne 1) { throw "Connect exactly one phone in Fastboot mode" }
    return $serials[0]
}

function Get-DirectRootVar([string]$Exe, [string]$Serial, [string]$Name) {
    $text = Invoke-DirectRootFastboot $Exe @("-s",$Serial,"getvar",$Name)
    $pat = "^\s*(?:\(bootloader\)\s*)?" + [regex]::Escape($Name) + ":\s*(.*?)\s*$"
    $values = @()
    foreach ($line in ($text -split "\r?\n")) { if ($line -match $pat) { $values += $Matches[1] } }
    if ($values.Count -ne 1 -or [string]::IsNullOrWhiteSpace($values[0])) { throw "Cannot read fastboot variable: $Name" }
    return $values[0]
}

function Test-DirectRootBundle([string]$Dir) {
    $root = (Get-Item -LiteralPath $Dir -Force).FullName
    if (((Get-Item -LiteralPath $root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Bundle directory must not be a link" }
    $image = Join-Path $root "xiaomi-dior-pmOS-root-direct.img"
    $sums = Join-Path $root "SHA256SUMS"
    $receipt = Join-Path $root "VERIFICATION.json"
    foreach ($path in @($image,$sums,$receipt)) {
        if (-not [IO.File]::Exists($path)) { throw "Missing DirectRoot file: $path" }
        if (((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Links are not accepted in DirectRoot bundle" }
    }
    $verified = $false
    foreach ($line in [IO.File]::ReadAllLines($sums)) {
        if ($line -notmatch "^([a-fA-F0-9]{64})\s+[ *]([A-Za-z0-9_.-]+)$") { throw "Malformed SHA256SUMS" }
        if ($Matches[2] -eq "xiaomi-dior-pmOS-root-direct.img") {
            $actual = (Get-FileHash -LiteralPath $image -Algorithm SHA256).Hash
            if ($actual -ine $Matches[1]) { throw "DirectRoot SHA256 mismatch" }
            $verified = $true
        }
    }
    if (-not $verified) { throw "SHA256SUMS does not cover DirectRoot image" }
    $v = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($v.flash_partition -cne "userdata" -or -not $v.uuid_matches_boot -or -not $v.fits_fastboot_max_download -or $v.boot_image_change_required) {
        throw "VERIFICATION.json does not authorize userdata-only DirectRoot flashing"
    }
    return [pscustomobject]@{ Root=$root; Image=$image; Receipt=$v }
}

function Read-DirectRootConfirmation { return (Read-Host "This erases userdata. Type DIOR to continue") }

function Start-DiorDirectRootFlash([string]$Directory,[string]$Executable,[bool]$Write,[bool]$KeepFastboot) {
    $bundle = Test-DirectRootBundle $Directory
    $exe = (Get-Item -LiteralPath $Executable -Force).FullName
    $serial = Get-DirectRootSerial $exe
    if ((Get-DirectRootVar $exe $serial "product") -cne "dior") { throw "Connected phone is not product=dior" }
    $capText = Get-DirectRootVar $exe $serial "partition-size:userdata"
    if ($capText -match "^0x[0-9a-fA-F]+$") { $capacity = [Convert]::ToInt64($capText.Substring(2),16) }
    elseif ($capText -match "^[0-9]+$") { $capacity = [Convert]::ToInt64($capText,10) }
    else { throw "Cannot parse userdata capacity: $capText" }
    $bytes = (Get-Item -LiteralPath $bundle.Image).Length
    if ($bytes -gt $capacity) { throw "DirectRoot image is larger than userdata partition" }
    Write-Host "Verified Xiaomi dior: $serial"
    Write-Host "userdata <- $($bundle.Image)"
    Write-Host "boot/system/recovery will NOT be written"
    if (-not $Write) { Write-Host "CHECK ONLY: no partition was written"; return }
    if ((Read-DirectRootConfirmation) -cne "DIOR") { throw "Cancelled; nothing written" }
    $bundle = Test-DirectRootBundle $Directory
    if ((Get-DirectRootSerial $exe) -cne $serial) { throw "Connected phone changed" }
    if ((Get-DirectRootVar $exe $serial "product") -cne "dior") { throw "Product changed; stopped" }
    Write-Host "Writing userdata. Do not unplug the phone."
    Write-Host (Invoke-DirectRootFastboot $exe @("-s",$serial,"flash","userdata",$bundle.Image))
    if (-not $KeepFastboot) {
        if ((Get-DirectRootSerial $exe) -cne $serial) { throw "Connected phone changed after write" }
        Write-Host (Invoke-DirectRootFastboot $exe @("-s",$serial,"reboot"))
    }
    Write-Host "DirectRoot flash completed; boot was preserved."
}

if ($MyInvocation.InvocationName -ne ".") {
    try { Start-DiorDirectRootFlash $ImageDirectory $FastbootPath ([bool]$Flash) ([bool]$NoReboot) }
    catch { Write-Host ("STOPPED: " + $_.Exception.Message) -ForegroundColor Red; exit 1 }
}
