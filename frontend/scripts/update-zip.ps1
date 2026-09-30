$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$tmp = 'zip-stage'
if (Test-Path $tmp) {
    [System.IO.Directory]::Delete((Resolve-Path $tmp), $true)
}
New-Item -ItemType Directory -Path $tmp | Out-Null
Copy-Item -Recurse -Path 'dist' -Destination (Join-Path $tmp 'dist')
$files = @('allow-firewall.cmd', 'BUILD.txt', 'configure-smtp.cmd', 'flowboard.env.cmd', 'flowboard.env.cmd.example', 'FlowBoard.exe', 'start-server.cmd')
foreach ($f in $files) { Copy-Item -Path $f -Destination (Join-Path $tmp $f) }
Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath 'FlowBoard-build.zip' -Update
[System.IO.Directory]::Delete((Resolve-Path $tmp), $true)
Get-Item 'FlowBoard-build.zip' | Select-Object Name, @{ n = 'SizeMB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime
