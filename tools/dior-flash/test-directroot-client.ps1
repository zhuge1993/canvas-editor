# Offline DirectRoot flasher tests. Fastboot is fully mocked; no USB is touched.
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "flash-directroot.ps1")
$script:Root = Join-Path ([IO.Path]::GetTempPath()) ("dior-directroot-test-" + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $script:Root
$script:Passed = 0

function Assert-True([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-Fails([scriptblock]$Action) { $failed=$false; try { & $Action } catch { $failed=$true }; Assert-True $failed "Expected rejection" }
function Write-Sums {
    $img = Join-Path $script:Images "xiaomi-dior-pmOS-root-direct.img"
    $hash = (Get-FileHash -LiteralPath $img -Algorithm SHA256).Hash.ToLower()
    [IO.File]::WriteAllText((Join-Path $script:Images "SHA256SUMS"), "$hash  xiaomi-dior-pmOS-root-direct.img`n")
}
function Write-Receipt([bool]$BootChange = $false,[string]$Digest = "") {
    $img = Join-Path $script:Images "xiaomi-dior-pmOS-root-direct.img"
    if ([string]::IsNullOrWhiteSpace($Digest)) { $Digest = (Get-FileHash -LiteralPath $img -Algorithm SHA256).Hash.ToLowerInvariant() }
    $obj = @{
        flash_partition="userdata"
        uuid_matches_boot=$true
        fits_fastboot_max_download=$true
        boot_image_change_required=$BootChange
        output_sha256=$Digest
        filesystem_uuid="2b3bcea5-5043-47de-a4f3-4959104f4762"
        boot_pmos_root_uuid="2b3bcea5-5043-47de-a4f3-4959104f4762"
        filesystem_label="pmOS_root"
    }
    [IO.File]::WriteAllText((Join-Path $script:Images "VERIFICATION.json"),($obj | ConvertTo-Json))
}
function New-Fixture {
    $script:Images = Join-Path $script:Root ([guid]::NewGuid().ToString())
    $null = New-Item -ItemType Directory -Path $script:Images
    $img = Join-Path $script:Images "xiaomi-dior-pmOS-root-direct.img"
    $stream=[IO.File]::Create($img); $stream.SetLength(1048576); $stream.Dispose()
    Write-Sums; Write-Receipt
    $script:Executable = Join-Path $script:Root "mock-fastboot.exe"
    [IO.File]::WriteAllText($script:Executable,"mock only")
    $script:Calls = New-Object "Collections.Generic.List[string]"
    $script:Devices = "TEST-SERIAL`tfastboot"
    $script:Product = "dior"
    $script:Capacity = "0x40000000"
    $script:Answer = "DIOR"
    $script:SerialChecks = 0
    $script:ChangeDeviceAfterFirst = $false
}
function Invoke-DirectRootFastboot([string]$Exe,[string[]]$Arguments) {
    $script:Calls.Add(($Arguments -join "|"))
    if ($Arguments[0] -eq "devices") {
        $script:SerialChecks++
        if ($script:ChangeDeviceAfterFirst -and $script:SerialChecks -gt 1) { return "OTHER`tfastboot" }
        return $script:Devices
    }
    if ($Arguments[2] -eq "getvar") {
        if ($Arguments[3] -eq "product") { return "(bootloader) product: $script:Product" }
        if ($Arguments[3] -eq "partition-size:userdata") { return "(bootloader) partition-size:userdata: $script:Capacity" }
    }
    return "OKAY"
}
function Read-DirectRootConfirmation { return $script:Answer }
function Get-Writes { return ,@($script:Calls | Where-Object { $_ -match "\|(flash|reboot)(\||$)" }) }
function Run-Test([string]$Name,[scriptblock]$Body) { New-Fixture; & $Body; $script:Passed++; Write-Host "PASS $Name" }

try {
    Run-Test "check mode never writes" {
        Start-DiorDirectRootFlash $script:Images $script:Executable $false $false
        Assert-True ((Get-Writes).Count -eq 0) "check mode wrote data"
    }
    Run-Test "success writes userdata only then reboots" {
        Start-DiorDirectRootFlash $script:Images $script:Executable $true $false
        $w=Get-Writes
        Assert-True ($w.Count -eq 2) "unexpected write count"
        Assert-True ($w[0] -match "\|flash\|userdata\|") "first write was not userdata"
        Assert-True ($w[0] -notmatch "\|boot\||\|system\||\|recovery\|") "forbidden partition write"
        Assert-True ($w[1] -eq "-s|TEST-SERIAL|reboot") "reboot sequence wrong"
    }
    Run-Test "no reboot mode writes userdata once" {
        Start-DiorDirectRootFlash $script:Images $script:Executable $true $true
        $w=Get-Writes; Assert-True ($w.Count -eq 1) "unexpected extra write"; Assert-True ($w[0] -match "\|flash\|userdata\|") "wrong partition"
    }
    Run-Test "wrong product rejected before write" {
        $script:Product="gucci"; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ((Get-Writes).Count -eq 0) "wrong phone written"
    }
    Run-Test "multiple devices rejected before write" {
        $script:Devices="A`tfastboot`nB`tfastboot"; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ((Get-Writes).Count -eq 0) "multiple phones written"
    }
    Run-Test "human cancellation rejected before write" {
        $script:Answer="NO"; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ((Get-Writes).Count -eq 0) "cancellation ignored"
    }
    Run-Test "tampered image rejected before USB query" {
        [IO.File]::AppendAllText((Join-Path $script:Images "xiaomi-dior-pmOS-root-direct.img"),"tamper")
        Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ($script:Calls.Count -eq 0) "bad checksum reached fastboot"
    }
    Run-Test "undersized userdata rejected before write" {
        $script:Capacity="0x80000"; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ((Get-Writes).Count -eq 0) "oversize image was written"
    }
    Run-Test "receipt requesting boot change is rejected" {
        Write-Receipt $true; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ($script:Calls.Count -eq 0) "unsafe receipt reached fastboot"
    }
    Run-Test "receipt digest mismatch is rejected" {
        Write-Receipt $false ("0" * 64)
        Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }
        Assert-True ($script:Calls.Count -eq 0) "mismatched receipt reached fastboot"
    }
    Run-Test "device change after confirmation prevents write" {
        $script:ChangeDeviceAfterFirst=$true; Assert-Fails { Start-DiorDirectRootFlash $script:Images $script:Executable $true $false }; Assert-True ((Get-Writes).Count -eq 0) "changed device was written"
    }
    Run-Test "fastboot falls back to PATH" {
        $pathDir = Join-Path $script:Root ("path-" + [guid]::NewGuid().ToString())
        $null = New-Item -ItemType Directory -Path $pathDir
        $fake = Join-Path $pathDir "fastboot.exe"
        [IO.File]::WriteAllText($fake,"mock only")
        $oldPath = $env:PATH
        try {
            $env:PATH = $pathDir + [IO.Path]::PathSeparator + $oldPath
            $resolved = Resolve-DirectRootFastboot (Join-Path $script:Root "missing-platform-tools\fastboot.exe")
            Assert-True ([IO.Path]::GetFullPath($resolved) -eq [IO.Path]::GetFullPath($fake)) "PATH fastboot was not selected"
        } finally {
            $env:PATH = $oldPath
        }
    }
    Write-Host "$script:Passed/12 DirectRoot offline tests passed. No real phone was used."
} finally { Remove-Item -LiteralPath $script:Root -Recurse -Force }
