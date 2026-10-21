[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CandidatePath,
  [Parameter(Mandatory = $true)][string]$EvidenceDirectory
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run only on a disposable GitHub-hosted Windows runner. This probe installs a temporary package and trust certificate.'
}
$expectedHash = 'e5e0c5884274bf32fcafa9da8772be944a4a96b29aa7977149ea2ca1ed811e99'
$expectedName = 'QuadLabsTechnologiesLLC.Gamekins'
$expectedPublisher = 'CN=BC200B51-E7F8-4B9A-B84B-823675B09085'
$expectedFamily = 'QuadLabsTechnologiesLLC.Gamekins_45ypgqnggv0a4'
$CandidatePath = (Resolve-Path -LiteralPath $CandidatePath).Path
$EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Force -Path $EvidenceDirectory | Out-Null
$scratch = Join-Path $env:RUNNER_TEMP ('gamekins-sideload-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
$result = [ordered]@{
  candidate = [ordered]@{ sourceRun = '39646982777'; artifactId = '12368051698'; expectedSha256 = $expectedHash }
  environment = [ordered]@{ os = [Environment]::OSVersion.VersionString; interactive = [Environment]::UserInteractive; sessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId }
  package = [ordered]@{ status = 'not-run' }
  deployment = [ordered]@{ status = 'not-run' }
  launch = [ordered]@{ status = 'not-run' }
  protocol = [ordered]@{ status = 'not-run' }
  startup = [ordered]@{ status = 'not-run' }
  wack = [ordered]@{ status = 'not-run'; note = 'Local WACK does not constitute Microsoft Store certification.' }
  cleanup = @()
  blockers = @()
  certificationReady = $false
}
$thumbprint = $null
$installed = $null
$installLocation = $null
$deploymentAttempted = $false
$exitCode = 0
Start-Transcript -Path (Join-Path $EvidenceDirectory 'acceptance.log') | Out-Null

function Find-KitTool([string]$Name) {
  $kits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
  if (-not (Test-Path -LiteralPath $kits)) { return $null }
  if ($Name -eq 'appcert.exe') {
    $tool = Join-Path $kits 'App Certification Kit\appcert.exe'
    if (Test-Path -LiteralPath $tool) { return $tool }
    return $null
  }
  $tools = @(Get-ChildItem (Join-Path $kits 'bin') -Recurse -File -Filter $Name -ErrorAction SilentlyContinue | Where-Object { $_.Directory.Name -eq 'x64' } | Sort-Object FullName -Descending)
  if ($tools.Count) { return $tools[0].FullName }
  return $null
}
function Get-OwnedProcesses {
  if (-not $installLocation) { return @() }
  return @(Get-Process -Name Gamekins -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($installLocation + '\', [StringComparison]::OrdinalIgnoreCase) } catch { $false }
  })
}
function Get-OwnedAutorun {
  $key = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
  if (-not $key) { return @() }
  return @($key.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' -and ($_.Name -match 'Gamekins' -or [string]$_.Value -match 'Gamekins') } | ForEach-Object { [ordered]@{ name = $_.Name; command = [string]$_.Value } })
}
function Wait-OwnedWindow([int]$Seconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  do {
    $windows = @(Get-OwnedProcesses | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })
    if ($windows.Count) { return $windows[0] }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Installed package did not produce a native Gamekins window within the deadline.'
}
function Run-KitTool([string]$Tool, [string[]]$Arguments, [string]$LogPrefix, [int]$TimeoutSeconds = 1200) {
  $quoted = @($Arguments | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_.Replace('"', '\"') + '"' } else { $_ } })
  $process = Start-Process -FilePath $Tool -ArgumentList $quoted -PassThru -RedirectStandardOutput ($LogPrefix + '.stdout.log') -RedirectStandardError ($LogPrefix + '.stderr.log')
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw 'Preinstalled SDK tool exceeded its time limit.'
  }
  $process.Refresh()
  return $process.ExitCode
}

try {
  $actualHash = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $result.candidate.actualSha256 = $actualHash
  if ($actualHash -ne $expectedHash) { throw 'Candidate SHA-256 does not match the pinned submission artifact.' }
  if (@(Get-AppxPackage -Name $expectedName).Count) { throw 'Runner already has this product installed; refusing to replace unrelated state.' }
  if (@(Get-OwnedAutorun).Count) { throw 'Runner already has Gamekins autorun state; refusing to alter unrelated state.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($CandidatePath)
  try {
    $entry = $zip.GetEntry('AppxManifest.xml')
    if (-not $entry) { throw 'AppX manifest is absent.' }
    $stream = $entry.Open()
    try {
      $settings = New-Object Xml.XmlReaderSettings
      $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
      $settings.XmlResolver = $null
      $reader = [Xml.XmlReader]::Create($stream, $settings)
      try { $manifest = New-Object Xml.XmlDocument; $manifest.Load($reader) } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
  } finally { $zip.Dispose() }
  $identity = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
  $application = $manifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Applications']/*[local-name()='Application']")
  if (-not $identity -or -not $application) { throw 'Package identity/application metadata is absent.' }
  if ($identity.GetAttribute('Name') -ne $expectedName -or $identity.GetAttribute('Publisher') -ne $expectedPublisher -or $identity.GetAttribute('ProcessorArchitecture') -ne 'x64' -or $identity.GetAttribute('Version') -ne '0.1.1.0') { throw 'Unexpected package identity, publisher, architecture or version (expected 0.1.1.0).' }
  $protocols = @($manifest.SelectNodes("//*[local-name()='Protocol']") | ForEach-Object { $_.GetAttribute('Name') })
  $startupTasks = @($manifest.SelectNodes("//*[local-name()='StartupTask']") | ForEach-Object { $_.GetAttribute('TaskId') })
  $result.package = [ordered]@{ status = 'passed'; identity = $expectedName; publisher = $expectedPublisher; version = $identity.GetAttribute('Version'); architecture = 'x64'; applicationId = $application.GetAttribute('Id'); executable = $application.GetAttribute('Executable'); protocols = $protocols; startupTasks = $startupTasks }
  $signTool = Find-KitTool 'signtool.exe'
  if (-not $signTool) { throw 'Preinstalled Windows SDK SignTool is unavailable; no SDK downloads are permitted.' }
  $copy = Join-Path $scratch 'candidate-test-signed.appx'
  Copy-Item -LiteralPath $CandidatePath -Destination $copy
  $certificate = New-SelfSignedCertificate -Subject $expectedPublisher -Type Custom -KeyUsage DigitalSignature -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' -NotAfter (Get-Date).AddDays(1) -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={text}')
  $thumbprint = $certificate.Thumbprint
  $publicCertificate = Join-Path $scratch 'ephemeral-public.cer'
  [IO.File]::WriteAllBytes($publicCertificate, $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
  Import-Certificate -FilePath $publicCertificate -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
  $signExit = Run-KitTool $signTool @('sign', '/fd', 'SHA256', '/s', 'My', '/sha1', $thumbprint, $copy) (Join-Path $EvidenceDirectory 'signtool') 120
  if ($signExit -ne 0) { throw "Test-copy signing failed with code $signExit." }
  $deploymentAttempted = $true
  Add-AppxPackage -Path $copy -ErrorAction Stop
  $installed = Get-AppxPackage -Name $expectedName
  if (-not $installed -or $installed.PackageFamilyName -ne $expectedFamily -or $installed.Publisher -ne $expectedPublisher) { throw 'The installed package identity does not match the pinned product.' }
  $installLocation = $installed.InstallLocation
  $result.deployment = [ordered]@{ status = 'passed'; packageFullName = $installed.PackageFullName; packageFamilyName = $installed.PackageFamilyName; signedCopySha256 = (Get-FileHash $copy -Algorithm SHA256).Hash.ToLowerInvariant(); signing = 'Disposable runner-only self-signed copy; original submission AppX unchanged.' }
  if (-not [Environment]::UserInteractive -or $result.environment.sessionId -eq 0) {
    $result.launch.status = 'blocked-session'
    $result.protocol.status = 'blocked-session'
    $result.wack.status = 'unavailable-session'
    $result.wack.note = 'The hosted runner has no interactive Windows desktop. WACK was not run; no SDK was downloaded.'
    throw 'Runner has no interactive user session; native window/protocol/WACK acceptance requires an interactive Windows desktop.'
  }
  $aumid = $installed.PackageFamilyName + '!' + $application.GetAttribute('Id')
  Start-Process explorer.exe -ArgumentList ('shell:AppsFolder\' + $aumid) | Out-Null
  $window = Wait-OwnedWindow
  $windowId = $window.Id
  Start-Sleep -Seconds 15
  $window = Wait-OwnedWindow 5
  if ($window.Id -ne $windowId) { throw 'Native application restarted unexpectedly during first launch.' }
  $result.launch = [ordered]@{ status = 'passed'; method = 'Installed AppX AUMID activation through shell:AppsFolder'; pid = $window.Id; title = $window.MainWindowTitle; executable = $window.Path; note = 'Native window survived 15 seconds; provider accounts and owned-game flows were not exercised.' }
  if ('gamekins' -notin $protocols) { throw 'Pinned AppX does not declare the gamekins protocol.' }
  # This URL has no launch action or game key: it only opens the launcher window.
  Start-Process 'gamekins://acceptance-check' | Out-Null
  Start-Sleep -Seconds 5
  $activated = Wait-OwnedWindow 5
  if ($activated.Id -ne $windowId) { throw 'Protocol activation did not preserve the running single instance.' }
  $result.protocol = [ordered]@{ status = 'invoked-unverified'; uri = 'gamekins://acceptance-check'; declared = $true; singleInstancePid = $activated.Id; note = 'Shell invocation succeeded and the native window survived. URI delivery inside the app was not observed; unchanged PID alone does not prove handling.' }
  $result.blockers += 'Protocol delivery requires confirmation from the application log or a manual test; this probe only invoked the declared handler.'
  $autorun = @(Get-OwnedAutorun)
  if ($autorun.Count) { throw 'First launch unexpectedly enabled Gamekins autorun.' }
  $result.startup = [ordered]@{ status = 'passed'; defaultAutorunEntries = 0; declaredStartupTasks = $startupTasks; note = 'Only default-off autorun checked. Enabling/disabling startup still needs manual acceptance.' }
  foreach ($process in @(Get-OwnedProcesses)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  $appcert = Find-KitTool 'appcert.exe'
  if (-not $appcert) {
    $result.wack.status = 'unavailable'
    $result.blockers += 'Windows App Certification Kit is not preinstalled. No SDK was downloaded. Run WACK on an interactive Windows test device before claiming WACK acceptance.'
  } else {
    $resetExit = Run-KitTool $appcert @('reset') (Join-Path $EvidenceDirectory 'wack-reset') 120
    if ($resetExit -ne 0) { throw "WACK reset failed with code $resetExit." }
    $reportPath = Join-Path $EvidenceDirectory 'wack-report.xml'
    $wackExit = Run-KitTool $appcert @('test', '-appxpackagepath', $copy, '-reportoutputpath', $reportPath) (Join-Path $EvidenceDirectory 'wack')
    $result.wack = [ordered]@{ status = 'needs-review'; exitCode = $wackExit; reportPresent = (Test-Path $reportPath); note = 'WACK ran against the disposable test-signed copy. Inspect its XML; no Store certification claim.' }
    if ($wackExit -ne 0 -or -not (Test-Path $reportPath)) { throw 'WACK did not complete successfully with a report. Review the captured tool logs.' }
    $result.blockers += 'WACK report requires explicit result review; zero tool exit alone is not a certification pass.'
  }
} catch {
  $result.blockers += $_.Exception.Message
  $result.error = $_.Exception.ToString()
  $exitCode = 1
  Write-Warning $_.Exception.Message
} finally {
  foreach ($process in @(Get-OwnedProcesses)) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  if ($deploymentAttempted) {
    try {
      Get-AppxPackage -Name $expectedName | Where-Object { $_.PackageFamilyName -eq $expectedFamily -and $_.Publisher -eq $expectedPublisher -and [string]$_.Version -eq '0.1.1.0' } | Remove-AppxPackage -ErrorAction Stop
      $result.cleanup += 'Any temporary registration of the exact pinned package removed, including after a failed deployment.'
    } catch { $result.cleanup += 'Package cleanup failed: ' + $_.Exception.Message; $exitCode = 1 }
  }
  if ($thumbprint) {
    foreach ($location in @('Cert:\LocalMachine\TrustedPeople', 'Cert:\CurrentUser\My')) {
      $path = Join-Path $location $thumbprint
      try {
        if (Test-Path $path) {
          if ($location -eq 'Cert:\CurrentUser\My') { Remove-Item -LiteralPath $path -DeleteKey -Force } else { Remove-Item -LiteralPath $path -Force }
        }
      } catch { $result.cleanup += 'Ephemeral certificate cleanup failed: ' + $_.Exception.Message; $exitCode = 1 }
    }
  }
  try { Remove-Item -LiteralPath $scratch -Recurse -Force; $result.cleanup += 'Disposable signed copy and public certificate removed; no private key exported.' } catch { $result.cleanup += 'Scratch cleanup failed: ' + $_.Exception.Message; $exitCode = 1 }
  $after = (Get-FileHash -LiteralPath $CandidatePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $result.candidate.finalSha256 = $after
  $result.candidate.unchanged = $after -eq $expectedHash
  if ($after -ne $expectedHash) { $result.blockers += 'Original submission package changed.'; $exitCode = 1 }
  $result.overall = if ($exitCode) { 'failed-or-blocked' } else { 'partial-native-probe-only' }
  $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $EvidenceDirectory 'acceptance-result.json') -Encoding UTF8
  if ($env:GITHUB_STEP_SUMMARY) {
    @("## Pinned Store acceptance", "Overall: $($result.overall). Certification ready: false. A green probe job does not indicate certification acceptance.", "Candidate SHA-256: ``$expectedHash``", "Native launch: $($result.launch.status); protocol: $($result.protocol.status); default startup: $($result.startup.status); WACK: $($result.wack.status).", "Original submission unchanged: $($result.candidate.unchanged).", '', 'Remaining blockers:', ($result.blockers | ForEach-Object { '- ' + $_ })) | Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY
  }
  Stop-Transcript | Out-Null
}
exit $exitCode
