param(
  [string]$Root = (Join-Path $env:ProgramData 'RestaurantPortal'),
  [switch]$RegisterStartup,
  [switch]$Demo,
  [switch]$Rollback
)
$ErrorActionPreference = 'Stop'
$Root = [IO.Path]::GetFullPath($Root).TrimEnd([char]92)
$taskName = 'RestaurantPortal'
$versionPattern = '^\d+\.\d+\.\d+$'
if ($Root -eq [IO.Path]::GetPathRoot($Root).TrimEnd([char]92)) { throw 'Choose an installation directory beneath the drive root.' }
if ($RegisterStartup) {
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -or $Root -ne (Join-Path $env:ProgramData 'RestaurantPortal')) {
    throw 'Open an administrator PowerShell window and use the default installation directory to enable startup.'
  }
  $existingTask = Get-ScheduledTask -TaskName $taskName -TaskPath '\' -ErrorAction SilentlyContinue
  if ($existingTask -and $existingTask.Actions.Arguments -notlike ('*' + (Join-Path $Root 'Launch.ps1') + '*')) {
    throw 'A different task already uses the RestaurantPortal name.'
  }
  if ($existingTask.State -eq 'Running') {
    throw 'Disable and stop the RestaurantPortal scheduled task before installing an update.'
  }
}

function Protect-Directory($Path, [bool]$ServiceWrites) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $admins = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
  $acl.SetOwner($admins)
  foreach ($id in @('S-1-5-32-544', 'S-1-5-18', 'S-1-5-19')) {
    $rights = if ($id -ne 'S-1-5-19') { 'FullControl' } elseif ($ServiceWrites) { 'Modify' } else { 'ReadAndExecute' }
    $sid = New-Object Security.Principal.SecurityIdentifier($id)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, $rights, 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Verify-Payload($App, $Manifest) {
  if ($Manifest.version -notmatch $versionPattern -or $Manifest.schema -lt 1 -or !$Manifest.files.Count) { throw 'The release manifest is invalid.' }
  $expected = @{}
  foreach ($file in $Manifest.files) {
    if ($file.path -notmatch '^[^/\\:]+(?:/[^/\\:]+)*$' -or $file.path -match '(?:^|/)\.{1,2}(?:/|$)' -or
      $file.sha256 -notmatch '^[A-F0-9]{64}$' -or $expected.ContainsKey($file.path)) { throw 'The release inventory is invalid.' }
    $expected[$file.path] = $file.sha256
  }
  $entries = @(Get-ChildItem -LiteralPath $App -Recurse -Force)
  if ($entries | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Release files cannot contain symbolic links or junctions.' }
  $files = @($entries | Where-Object { !$_.PSIsContainer })
  if ($files.Count -ne $expected.Count) { throw 'The release has missing or unexpected files.' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($App.Length + 1).Replace([char]92, [char]47)
      $stream = $file.OpenRead()
      try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
      finally { $stream.Dispose() }
      if (!$expected.ContainsKey($relative) -or $digest -ne $expected[$relative]) { throw "Release integrity check failed for $relative." }
    }
  } finally { $sha.Dispose() }
}

foreach ($directory in @($Root, (Join-Path $Root 'versions'), (Join-Path $Root 'data'))) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  if ((Get-Item -LiteralPath $directory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Installation directories cannot be symbolic links or junctions.' }
  if ($RegisterStartup) { Protect-Directory $directory ($directory -eq (Join-Path $Root 'data')) }
}

$data = Join-Path $Root 'data'
$db = Join-Path $data 'outlet.sqlite'
$stateFile = Join-Path $Root 'active.json'
$settings = Join-Path $Root 'settings.json'
$launcher = Join-Path $Root 'Launch.ps1'
$versions = Join-Path $Root 'versions'
$lock = $null
$stage = $null
$promoted = $false
$committed = $false
try {
  try { $lock = [IO.File]::Open((Join-Path $data 'service.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { throw 'Stop the running Restaurant Portal before changing releases.' }
  if ($RegisterStartup) {
    $runtimePrefix = $versions + [IO.Path]::DirectorySeparatorChar
    $running = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
      $_.ExecutablePath -and $_.ExecutablePath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)
    }
    if ($running) { throw 'The outlet runtime is still running. Stop it before changing releases.' }
  }
  $state = if (Test-Path -LiteralPath $stateFile) { Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json } else { $null }
  if ($state -and ($state.active -notmatch $versionPattern -or ($state.previous -and $state.previous -notmatch $versionPattern))) {
    throw 'The installed release pointer is invalid.'
  }
  $stage = Join-Path $versions ('.candidate-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  if ($Rollback) {
    if ($Demo -or !$state.previous) { throw 'There is no previous installed release to restore.' }
    $release = Join-Path $versions $state.previous
    $manifest = Get-Content -LiteralPath (Join-Path $release 'manifest.json') -Raw | ConvertFrom-Json
    $app = Join-Path $release 'app'
    if ($manifest.version -ne $state.previous) { throw 'The previous release manifest does not match its version.' }
  } else {
    $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
    $app = Join-Path $stage 'app'
    if ($manifest.version -notmatch $versionPattern) { throw 'The package version is invalid.' }
    $release = Join-Path $versions $manifest.version
    if (Test-Path -LiteralPath $release) { throw 'This version is already installed. Use a new release package or rollback.' }
    if ($state -and ([version]$manifest.version -le [version]$state.active)) { throw 'Use rollback to restore an older installed release.' }
    $sourceApp = Join-Path $PSScriptRoot 'app'
    if ((Get-Item -LiteralPath $sourceApp -Force).Attributes -band [IO.FileAttributes]::ReparsePoint -or
      (Get-ChildItem -LiteralPath $sourceApp -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) {
      throw 'Release files cannot contain symbolic links or junctions.'
    }
    & (Join-Path $env:SystemRoot 'System32/robocopy.exe') $sourceApp $app /E /COPY:DAT /R:0 /W:0 /MT:8 /NFL /NDL /NJH /NJS /NP /XJ | Out-Null
    if ($LASTEXITCODE -ge 8) { throw 'The candidate release could not be copied.' }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Destination $stage
  }
  Verify-Payload $app $manifest
  $node = Join-Path $app 'runtime/node.exe'
  $validation = Join-Path $stage 'validation.sqlite'
  $result = & $node (Join-Path $app 'dist/server/install-check.js') $db $validation
  if ($LASTEXITCODE -or ($result | ConvertFrom-Json).schemaVersion -ne $manifest.schema) {
    throw 'The candidate failed its checks. The active release and live database were retained.'
  }
  Remove-Item -LiteralPath $validation
  if ($Demo -and (Test-Path -LiteralPath $db)) { throw 'The outlet database already exists. Demo setup would replace sample data.' }

  if (!$Rollback) {
    Move-Item -LiteralPath $stage -Destination $release
    $promoted = $true
    $app = Join-Path $release 'app'
  }
  if (!(Test-Path -LiteralPath $launcher)) { Copy-Item -LiteralPath (Join-Path $app 'launch.ps1') -Destination $launcher }
  if (Test-Path -LiteralPath (Join-Path $app 'restore.ps1')) {
    Copy-Item -LiteralPath (Join-Path $app 'restore.ps1') -Destination (Join-Path $Root 'Restore-Backup.ps1') -Force
  }
  if (!(Test-Path -LiteralPath $settings)) { '{"RESTAURANT_PORT":"3100"}' | Set-Content -LiteralPath $settings -Encoding ascii }
  if ($Demo) {
    $env:RESTAURANT_DB = $db
    & (Join-Path $app 'runtime/node.exe') (Join-Path $app 'dist/server/setup.js') --demo |
      Set-Content -LiteralPath (Join-Path $data 'demo-accounts.txt') -Encoding ascii
    if ($LASTEXITCODE) { throw 'Sample outlet setup failed.' }
  }
  if ($RegisterStartup) {
    $exe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $action = New-ScheduledTaskAction -Execute $exe -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcher`""
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $identity = New-ScheduledTaskPrincipal -UserId 'S-1-5-19' -LogonType ServiceAccount -RunLevel Limited
    $options = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $taskName -TaskPath '\' -Action $action -Trigger $trigger -Principal $identity -Settings $options -Force | Out-Null
  }
  $nextState = @{ active = $manifest.version; previous = if ($state) { $state.active } else { $null } } | ConvertTo-Json -Compress
  $pointer = Join-Path $Root ('.active-' + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($pointer, $nextState)
  try {
    if (Test-Path -LiteralPath $stateFile) { [IO.File]::Replace($pointer, $stateFile, "$pointer.backup") }
    else { [IO.File]::Move($pointer, $stateFile) }
    $committed = $true
  } finally {
    foreach ($temporary in @($pointer, "$pointer.backup")) {
      if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
    }
  }
  Write-Host "Active release: $($manifest.version)"
} finally {
  try {
    if ($promoted -and !$committed -and (Resolve-Path -LiteralPath $release).Path -eq $release -and
      $release.StartsWith($versions + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      Move-Item -LiteralPath $release -Destination $stage
    }
    if ($stage -and (Test-Path -LiteralPath $stage)) {
      $checked = (Resolve-Path -LiteralPath $stage).Path
      if ($checked -eq $stage -and $checked.StartsWith($versions + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $checked -Recurse -Force
      }
    }
  } finally { if ($lock) { $lock.Dispose() } }
}
if ($RegisterStartup) { Start-ScheduledTask -TaskName $taskName -TaskPath '\' }
