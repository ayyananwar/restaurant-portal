param(
  [string]$Root = $PSScriptRoot,
  [Parameter(Mandatory)][string]$Backup,
  [ValidateSet('review','restore')][string]$Mode = 'review',
  [string]$ConfirmHash,
  [string]$InvoiceSeries,
  [string]$CreditSeries,
  [switch]$PassphraseFromStdin
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path
$Backup = (Resolve-Path -LiteralPath $Backup).Path
$data = Join-Path $Root 'data'
foreach ($path in @($Root,$data,(Join-Path $data 'outlet.sqlite'))) {
  if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Recovery does not accept symbolic links or junctions in the installation paths.'
  }
}
$state = Get-Content -LiteralPath (Join-Path $Root 'active.json') -Raw | ConvertFrom-Json
if ($state.active -notmatch '^\d+\.\d+\.\d+$') { throw 'The installed release pointer is invalid.' }
$app = Join-Path $Root "versions/$($state.active)/app"
$node = Join-Path $app 'runtime/node.exe'
$entry = Join-Path $app 'dist/server/recovery-command.js'
if (!(Test-Path -LiteralPath $entry)) { throw 'Update to a release with recovery support first.' }
if ($Mode -eq 'restore' -and ($ConfirmHash -notmatch '^[a-f0-9]{64}$' -or $InvoiceSeries -notmatch '^[A-Z0-9]{1,4}$' -or $CreditSeries -notmatch '^[A-Z0-9]{1,4}$')) {
  throw 'Review the backup first, then supply its hash and two new financial series.'
}
try { $lock = [IO.File]::Open((Join-Path $data 'service.lock'),'OpenOrCreate','ReadWrite','None') }
catch { throw 'Stop the Restaurant Portal service and launcher before recovery.' }
$secret = $null
$pointer = [IntPtr]::Zero
try {
  # Reject an unmanaged process that still holds the database, in addition to the launcher lock.
  $database = Join-Path $data 'outlet.sqlite'
  if (Test-Path -LiteralPath $database) {
    try { $exclusive = [IO.File]::Open($database,'Open','ReadWrite','None'); $exclusive.Dispose() }
    catch { throw 'An outlet process still has the database open. Stop it before recovery.' }
  }
  if ($PassphraseFromStdin) {
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $plain = [Console]::In.ReadLine()
  }
  else {
    $secret = Read-Host 'Backup passphrase (not displayed)' -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  foreach ($name in @('NODE_OPTIONS','NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED')) {
    [Environment]::SetEnvironmentVariable($name,$null,'Process')
  }
  $env:RESTAURANT_RECOVERY_LOCK = 'held'
  $operator = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $arguments = @($entry,'--root',$Root,'--backup',$Backup,'--mode',$Mode,'--operator',$operator)
  if ($Mode -eq 'restore') { $arguments += @('--confirm-hash',$ConfirmHash,'--invoice-series',$InvoiceSeries,'--credit-series',$CreditSeries) }
  $plain | & $node @arguments
  if ($LASTEXITCODE) { throw 'Recovery did not complete. Keep the service stopped and review the error. The command reports success only after validation and replacement.' }
} finally {
  $plain = $null
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  if ($secret) { $secret.Dispose() }
  Remove-Item Env:RESTAURANT_RECOVERY_LOCK -ErrorAction SilentlyContinue
  $lock.Dispose()
}
