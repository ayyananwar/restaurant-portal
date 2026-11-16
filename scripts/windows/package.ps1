param(
  [Parameter(Mandatory)][string]$NodeDirectory,
  [string]$Version
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$runtime = (Resolve-Path -LiteralPath $NodeDirectory).Path
$node = Join-Path $runtime 'node.exe'
$license = Join-Path $runtime 'LICENSE'
if (!(Test-Path -LiteralPath $node -PathType Leaf) -or !(Test-Path -LiteralPath $license -PathType Leaf)) {
  throw 'Supply an extracted official Windows Node.js release containing node.exe and LICENSE.'
}
$nodeVersion = (& $node -p 'process.version').Trim()
if ($LASTEXITCODE -or $nodeVersion -notmatch '^v22\.(\d+)\.\d+$' -or [int]$Matches[1] -lt 14) { throw 'Use a supported Node 22 Windows runtime.' }
if ((& $node -p 'process.arch').Trim() -ne 'x64') { throw 'This package requires the x64 Windows runtime.' }
if (!$Version) { $Version = (Get-Content (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Use a three-part release version.' }

$output = Join-Path $project 'dist/windows'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$archive = Join-Path $output "restaurant-portal-$Version-win-x64.zip"
if (Test-Path -LiteralPath $archive) { throw "A package for $Version already exists." }
$stage = Join-Path $output ('.package-' + [guid]::NewGuid().ToString('N'))
$app = Join-Path $stage 'app'
New-Item -ItemType Directory -Path (Join-Path $app 'dist'), (Join-Path $app 'runtime') -Force | Out-Null
Push-Location $project
try {
  & npm.cmd run build
  if ($LASTEXITCODE) { throw 'The production build failed.' }
  Copy-Item -LiteralPath 'dist/server', 'dist/shared', 'dist/client' -Destination (Join-Path $app 'dist') -Recurse
  Copy-Item -LiteralPath $node, $license -Destination (Join-Path $app 'runtime')
  '{"type":"module","private":true}' | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding ascii
  $dependencies = & npm.cmd ls --omit=dev --parseable --all
  if ($LASTEXITCODE) { throw 'Install the locked project dependencies before packaging.' }
  $prefix = $project + [IO.Path]::DirectorySeparatorChar
  foreach ($dependency in $dependencies) {
    if ($dependency -eq $project) { continue }
    if (!$dependency.StartsWith($prefix + 'node_modules' + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw 'The project contains a dependency outside its local node_modules directory.'
    }
    $target = Join-Path $app $dependency.Substring($prefix.Length)
    if (Test-Path -LiteralPath $target) { continue }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $dependency -Destination $target -Recurse
  }
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'launch.ps1') -Destination (Join-Path $app 'launch.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'install.ps1') -Destination (Join-Path $stage 'Install.ps1')
  $scratch = Join-Path $stage 'validation.sqlite'
  $check = & (Join-Path $app 'runtime/node.exe') (Join-Path $app 'dist/server/install-check.js') (Join-Path $stage 'empty.sqlite') $scratch
  if ($LASTEXITCODE) { throw 'The bundled runtime failed the installer check.' }
  Remove-Item -LiteralPath $scratch
  $schema = ($check | ConvertFrom-Json).schemaVersion
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $files = @(Get-ChildItem -LiteralPath $app -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
      $stream = $_.OpenRead()
      try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
      finally { $stream.Dispose() }
      @{ path = $_.FullName.Substring($app.Length + 1).Replace([char]92, [char]47); sha256 = $digest }
    })
  } finally { $sha.Dispose() }
  @{ version = $Version; node = $nodeVersion; schema = $schema; files = $files } | ConvertTo-Json -Depth 4 |
    Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding utf8
  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $partial = Join-Path $stage 'package.zip'
  $zip = [IO.Compression.ZipFile]::Open($partial, [IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse -Force | Where-Object FullName -ne $partial) {
      $name = $file.FullName.Substring($stage.Length + 1).Replace([char]92, [char]47)
      $null = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $name, [IO.Compression.CompressionLevel]::Fastest)
    }
  } finally { $zip.Dispose() }
  Move-Item -LiteralPath $partial -Destination $archive
  (Get-FileHash -LiteralPath $archive).Hash | Set-Content -LiteralPath "$archive.sha256" -Encoding ascii
  Write-Host "Created $archive"
} finally {
  Pop-Location
  $checked = (Resolve-Path -LiteralPath $stage).Path
  if ($checked -eq $stage -and $checked.StartsWith($output + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $checked -Recurse -Force
  }
}
