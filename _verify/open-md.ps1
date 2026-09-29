param(
  [string]$Path,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$appDir = $PSScriptRoot
$payloadFile = Join-Path $appDir 'doc-payload.js'

if (-not [string]::IsNullOrWhiteSpace($Path)) {
  $mdPath = (Resolve-Path -LiteralPath $Path).Path
  $docName = [IO.Path]::GetFileName($mdPath)
  $utf8Strict = New-Object Text.UTF8Encoding($false, $true)
  $content = $null
  try {
    $sr = New-Object IO.StreamReader($mdPath, $utf8Strict, $true)
    try { $content = $sr.ReadToEnd() } finally { $sr.Close() }
  } catch {
    $sr = New-Object IO.StreamReader($mdPath, [Text.Encoding]::Default, $true)
    try { $content = $sr.ReadToEnd() } finally { $sr.Close() }
  }
  $json = @{ name = $docName; content = $content } | ConvertTo-Json -Compress
  $js = 'window.__MD_PAYLOAD__=' + $json + ';'
} else {
  $js = 'window.__MD_PAYLOAD__=null;'
}

[IO.File]::WriteAllText($payloadFile, $js, (New-Object Text.UTF8Encoding($false)))

if ($NoLaunch) { return }

$url = 'file:///' + ($appDir -replace '\\', '/') + '/index.html?auto=1'
$edge = @(
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edge) {
  Start-Process -FilePath $edge -ArgumentList ('--app=' + $url)
} else {
  Start-Process $url
}
