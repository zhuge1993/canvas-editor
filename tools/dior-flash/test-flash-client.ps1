# Offline tests: all Fastboot calls are replaced with an in-process mock.
# No USB devices, pmbootstrap, network or actual image builds are used.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'flash-dior.ps1')
$script:TestRoot = Join-Path ([IO.Path]::GetTempPath()) ('dior-client-test-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $script:TestRoot
$script:Passed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Assert-Fails([scriptblock]$Action) {
    $failed = $false
    try { & $Action } catch { $failed = $true }
    Assert-True $failed 'Expected operation to be rejected.'
}
function Update-Checksums {
    $lines = @(Get-ChildItem -LiteralPath $script:Images -File | Where-Object { $_.Name -ne 'SHA256SUMS' } |
        Sort-Object Name | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower() + '  ./' + $_.Name })
    [IO.File]::WriteAllLines((Join-Path $script:Images 'SHA256SUMS'), [string[]]$lines)
}
function New-Fixture {
    $script:Images = Join-Path $script:TestRoot ([guid]::NewGuid().ToString())
    $null = New-Item -ItemType Directory -Path $script:Images
    $script:Executable = Join-Path $script:TestRoot 'never-executed-fastboot.exe'
    [IO.File]::WriteAllText($script:Executable, 'TEST STUB ONLY; THIS IS NOT AN EXECUTABLE')
    $stream = [IO.File]::Create((Join-Path $script:Images 'boot.img-xiaomi-dior'))
    $bytes = [Text.Encoding]::ASCII.GetBytes('ANDROID!')
    $stream.Write($bytes, 0, $bytes.Length); $stream.SetLength(4096); $stream.Dispose()
    $stream = [IO.File]::Create((Join-Path $script:Images 'xiaomi-dior.img'))
    $stream.SetLength(16777216); $stream.Position = 510; $stream.WriteByte(0x55); $stream.WriteByte(0xaa); $stream.Dispose()
    [IO.File]::WriteAllText((Join-Path $script:Images 'BUILD-MANIFEST.txt'),
        "target_device=dior`ntarget_arch=armv7`ninstall_mode=standard`nrepository_revision=$('a' * 40)`n")
    [IO.File]::WriteAllText((Join-Path $script:Images 'BUILD-STATUS.txt'), 'TEST FIXTURE ONLY. NOT A REAL BUILD.')
    $script:Plan = @{
        schema = 'dior-v1-flash-plan-1'; repository = 'zhuge1993/canvas-editor'
        source_commit = ('a' * 40); build_run_id = 123; build_conclusion = 'success'
        target_device = 'dior'; install_mode = 'standard'; boot_partition = 'boot'
        rootfs_partition = 'userdata'; boot_file = 'boot.img-xiaomi-dior'; rootfs_file = 'xiaomi-dior.img'
    }
    Save-Plan
    $script:Calls = New-Object 'Collections.Generic.List[string]'
    $script:Product = 'dior'; $script:Devices = "TEST-SERIAL`tfastboot"
    $script:Capacity = '0x10000000'; $script:Answer = 'DIOR'; $script:FailRoot = $false
    $script:ChangeAfterBoot = $false; $script:BootWritten = $false
}
function Save-Plan {
    [IO.File]::WriteAllText((Join-Path $script:Images 'FLASH-PLAN.json'), ($script:Plan | ConvertTo-Json))
    Update-Checksums
}
function Invoke-DiorFastboot([string]$Executable, [string[]]$Arguments) {
    $script:Calls.Add(($Arguments -join '|'))
    if ($Arguments[0] -eq 'devices') {
        if ($script:ChangeAfterBoot -and $script:BootWritten) { return "DIFFERENT-SERIAL`tfastboot" }
        return $script:Devices
    }
    if ($Arguments[2] -eq 'getvar') {
        if ($Arguments[3] -eq 'product') { return "(bootloader) product: $script:Product`nFinished. Total time: 0.000s" }
        return "$($Arguments[3]): $script:Capacity"
    }
    if ($Arguments[2] -eq 'flash:raw') { $script:BootWritten = $true }
    if ($Arguments[2] -eq 'flash' -and $script:FailRoot) { throw 'TEST: rootfs write failure' }
    return 'OKAY (TEST MOCK ONLY)'
}
function Read-DiorConfirmation { return $script:Answer }
function Get-Writes { return @($script:Calls | Where-Object { $_ -match '\|(flash:raw|flash|reboot)(\||$)' }) }
function Invoke-Test([string]$Name, [scriptblock]$Action) {
    New-Fixture
    & $Action
    $script:Passed++
    Write-Host "PASS $Name"
}
try {
    Invoke-Test 'Default check never writes' {
        Start-DiorFlash $script:Images $script:Executable $false $false
        Assert-True ((Get-Writes).Count -eq 0) 'Check mode wrote a partition.'
    }
    Invoke-Test 'Boot, rootfs, reboot sequence' {
        Start-DiorFlash $script:Images $script:Executable $true $false
        $writes = Get-Writes
        Assert-True ($writes.Count -eq 3) 'Unexpected writes.'
        Assert-True ($writes[0] -match '\|flash:raw\|boot\|') 'Boot must be first.'
        Assert-True ($writes[1] -match '\|flash\|userdata\|') 'Rootfs partition must follow verified plan.'
        Assert-True ($writes[2] -eq '-s|TEST-SERIAL|reboot') 'Reboot must be last.'
    }
    Invoke-Test 'Reboot can be disabled' {
        Start-DiorFlash $script:Images $script:Executable $true $true
        Assert-True ((Get-Writes).Count -eq 2) 'Unexpected reboot.'
    }
    Invoke-Test 'Wrong product rejected before writes' {
        $script:Product = 'gucci'
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 0) 'Wrong phone was written.'
    }
    Invoke-Test 'Multiple devices rejected' {
        $script:Devices += "`nOTHER`tfastboot"
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 0) 'Multiple devices were written.'
    }
    Invoke-Test 'Human cancellation respected' {
        $script:Answer = 'NO'
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 0) 'Cancellation was ignored.'
    }
    Invoke-Test 'Missing flash plan rejected without USB calls' {
        Remove-Item -LiteralPath (Join-Path $script:Images 'FLASH-PLAN.json'); Update-Checksums
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ($script:Calls.Count -eq 0) 'Incomplete bundle accessed Fastboot.'
    }
    Invoke-Test 'Changed image rejected without USB calls' {
        [IO.File]::AppendAllText((Join-Path $script:Images 'boot.img-xiaomi-dior'), 'corrupt')
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ($script:Calls.Count -eq 0) 'Corrupt image accessed Fastboot.'
    }
    Invoke-Test 'Rootfs capacity checked before boot write' {
        $script:Capacity = '0x2000'
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 0) 'Oversize rootfs did not prevent boot write.'
    }
    Invoke-Test 'Unexpected target partition rejected' {
        $script:Plan.rootfs_partition = 'recovery'; Save-Plan
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ($script:Calls.Count -eq 0) 'Wrong target accessed Fastboot.'
    }
    Invoke-Test 'Rootfs failure prevents reboot' {
        $script:FailRoot = $true
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 2) 'Reboot occurred after failed rootfs.'
    }
    Invoke-Test 'Device change prevents second write' {
        $script:ChangeAfterBoot = $true
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 1) 'Different device received second write.'
    }
    Invoke-Test 'Sparse expanded size used' {
        $path = Join-Path $script:Images 'xiaomi-dior.img'
        $stream = [IO.File]::Create($path); $w = New-Object IO.BinaryWriter($stream)
        $w.Write([uint32]0xed26ff3aL); $w.Write([uint16]1); $w.Write([uint16]0)
        $w.Write([uint16]28); $w.Write([uint16]12); $w.Write([uint32]4096)
        $w.Write([uint32]8192); $w.Write([uint32]1); $w.Write([uint32]0)
        $w.Write([uint16]0xcac3); $w.Write([uint16]0); $w.Write([uint32]8192); $w.Write([uint32]12); $w.Dispose()
        Assert-True ((Get-DiorImageSize $path) -eq 33554432) 'Sparse expanded size was wrong.'
        Update-Checksums; $script:Capacity = '0x1000000'
        Assert-Fails { Start-DiorFlash $script:Images $script:Executable $true $false }
        Assert-True ((Get-Writes).Count -eq 0) 'Compressed size bypassed capacity check.'
    }
    Invoke-Test 'Checksummed path traversal rejected' {
        [IO.File]::AppendAllText((Join-Path $script:Images 'SHA256SUMS'), "$('a' * 64)  ../outside`n")
        Assert-Fails { Test-DiorBundle $script:Images }
    }
    Write-Host "$script:Passed/14 offline tests passed. No real phone or image build was used."
} finally {
    Remove-Item -LiteralPath $script:TestRoot -Recurse -Force
}
