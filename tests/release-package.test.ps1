$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tag = 'test-package-' + [guid]::NewGuid().ToString('N')
$releaseDir = Join-Path $repoRoot ".tmp/releases/$tag"
$tokenFile = Join-Path $repoRoot ".tmp/$tag.env"
[IO.File]::WriteAllText($tokenFile,'BRIA_API_TOKEN=synthetic-package-token')
$global:releaseTestCalls = [Collections.Generic.List[object]]::new()
function Get-FileHash { throw 'Get-FileHash is intentionally unavailable in this packaging regression.' }

# Synthetic Docker only: verify packaging boundaries without building or deploying images.
function docker {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$DockerArgs)
    $global:LASTEXITCODE = 0
    $global:releaseTestCalls.Add($DockerArgs)
    switch ($DockerArgs[0]) {
        'version' { 'linux' }
        'buildx' {
            if ($DockerArgs -notcontains '--load' -or $DockerArgs -notcontains 'linux/amd64' -or $DockerArgs -notcontains '--no-cache-filter' -or $DockerArgs -notcontains '--secret') { throw 'Incorrect private build/cache/platform/export' }
            if (($DockerArgs -join ' ') -match 'synthetic-package-token') { throw 'Token exposed in Docker arguments' }
        }
        'save' { [IO.File]::WriteAllText($DockerArgs[2], 'SYNTHETIC TEST ONLY - NOT A DOCKER IMAGE') }
        default { throw 'Unexpected Docker operation' }
    }
}

try {
    & (Join-Path $repoRoot 'deploy/standalone/build-release.ps1') -Tag $tag -TokenFile $tokenFile
    $expected = @('compose.yaml','DEPLOY.md','images.tar','RELEASE.txt','SHA256SUMS','PRIVATE_ACCESS.txt')
    $actual = @(Get-ChildItem -LiteralPath $releaseDir -File | ForEach-Object Name | Sort-Object)
    if (Compare-Object $actual ($expected | Sort-Object)) { throw "Release must contain only the private runtime artifacts. Actual: $($actual -join ', ')" }
    $compose = [IO.File]::ReadAllText((Join-Path $releaseDir 'compose.yaml'))
    if ($compose -match '(?m)^\s*(build|context):' -or $compose -match '\.\./\.\.') { throw 'Runtime compose depends on source checkout' }
    if ($compose -notmatch "bria-cutout-api:$tag" -or $compose -match 'BRIA_API_TOKEN|CUTOUT_PROXY_TOKEN:|RELEASE_TAG') { throw 'Incorrect version or exposed credential' }
    $login = [IO.File]::ReadAllText((Join-Path $releaseDir 'PRIVATE_ACCESS.txt'))
    if ($login -notmatch 'Password: [a-f0-9]{64}' -or $login -match 'synthetic-package-token') { throw 'Missing login or exposed Bria token' }
    $secretArg = $global:releaseTestCalls[1] | Where-Object { $_ -like 'id=api_config,src=*' }
    if (Test-Path -LiteralPath ($secretArg -replace '^id=api_config,src=','')) { throw 'Temporary private configuration was not removed' }
    $sum = & node --input-type=module -e "import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; console.log(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));" (Join-Path $releaseDir 'images.tar')
    if ($LASTEXITCODE -ne 0) { throw 'Independent checksum verification failed' }
    if ([IO.File]::ReadAllText((Join-Path $releaseDir 'SHA256SUMS')).Trim() -ne "$sum  images.tar") { throw 'Invalid artifact checksum' }
    if ($global:releaseTestCalls.Count -ne 3 -or $compose -match 'bria-cutout-web') { throw 'Expected exactly one backend build and export' }
    $before = $global:releaseTestCalls.Count
    $rejected = $false
    try { & (Join-Path $repoRoot 'deploy/standalone/build-release.ps1') -Tag $tag } catch { $rejected = $true }
    if (-not $rejected -or $global:releaseTestCalls.Count -ne $before) { throw 'Existing release must be preserved before invoking Docker' }
    Write-Output 'PASS: synthetic private packaging, runtime-only files, no token in arguments/compose, secret-cache invalidation, temporary config cleanup, version/checksum and overwrite rejection.'
} finally {
    # Remove only the exact synthetic files created by this test, never recurse.
    if (Test-Path -LiteralPath $releaseDir) {
        foreach ($file in @('compose.yaml','DEPLOY.md','images.tar','RELEASE.txt','SHA256SUMS','PRIVATE_ACCESS.txt')) {
            Remove-Item -LiteralPath (Join-Path $releaseDir $file) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $releaseDir
    }
    Remove-Item -LiteralPath $tokenFile -Force
    Remove-Variable -Name releaseTestCalls -Scope Global -ErrorAction SilentlyContinue
}
