param([string]$Root = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$lock = [IO.File]::Open((Join-Path $Root 'data/service.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
  $state = Get-Content -LiteralPath (Join-Path $Root 'active.json') -Raw | ConvertFrom-Json
  if ($state.active -notmatch '^\d+\.\d+\.\d+$') { throw 'The installed release pointer is invalid.' }
  $app = Join-Path $Root "versions/$($state.active)/app"
  $config = Get-Content -LiteralPath (Join-Path $Root 'settings.json') -Raw | ConvertFrom-Json
  $allowed = @('RESTAURANT_BIND', 'RESTAURANT_PORT', 'RESTAURANT_ORIGIN', 'RESTAURANT_TLS_KEY', 'RESTAURANT_TLS_CERT',
    'RESTAURANT_PUBLISH_ORIGIN', 'RESTAURANT_PUBLISH_OUTLET', 'RESTAURANT_PUBLISH_TOKEN', 'NODE_EXTRA_CA_CERTS')
  foreach ($entry in Get-ChildItem Env: | Where-Object { $_.Name -like 'RESTAURANT_*' -or $_.Name -in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED') }) {
    [Environment]::SetEnvironmentVariable($entry.Name, $null, 'Process')
  }
  foreach ($setting in $config.PSObject.Properties) {
    if ($setting.Name -notin $allowed -or $setting.Value -isnot [string]) { throw 'The outlet settings contain an unsupported entry.' }
    [Environment]::SetEnvironmentVariable($setting.Name, $setting.Value, 'Process')
  }
  $env:RESTAURANT_DB = Join-Path $Root 'data/outlet.sqlite'
  Set-Location -LiteralPath $app
  $entry = Join-Path $app 'dist/server/main.js'
  $process = Start-Process -FilePath (Join-Path $app 'runtime/node.exe') -ArgumentList "`"$entry`"" -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput (Join-Path $Root 'data/service.log') -RedirectStandardError (Join-Path $Root 'data/service-errors.log')
  exit $process.ExitCode
} finally { $lock.Dispose() }
