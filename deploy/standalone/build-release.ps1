param(
    [ValidatePattern('^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$')]
    [string]$Tag = ('backend-' + (Get-Date -Format 'yyyyMMdd-HHmmss')),
    [ValidateSet('linux/amd64','linux/arm64')]
    [string]$Platform = 'linux/amd64',
    [string]$TokenFile = ''
)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$releaseDir = Join-Path $repoRoot ".tmp/releases/$Tag"
$privateDir = Join-Path $repoRoot ('.tmp/private-build/' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $releaseDir) { throw 'Release directory already exists. Use a new tag; existing artifacts will not be overwritten.' }

function Invoke-Docker([string[]]$DockerArgs) {
    & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Release is incomplete; do not deploy it.' }
}

Push-Location $repoRoot
try {
    # Fail before creating a release directory if Docker Desktop/Linux is unavailable.
    $serverOS = & docker version --format '{{.Server.Os}}' 2>$null
    if ($LASTEXITCODE -ne 0 -or $serverOS -ne 'linux') { throw 'Start Docker Desktop with the Linux engine before building a release.' }
    if ($TokenFile) {
        & node deploy/standalone/prepare-private.mjs $privateDir $TokenFile
    } else {
        & node deploy/standalone/prepare-private.mjs $privateDir
    }
    if ($LASTEXITCODE -ne 0) { throw 'Private configuration preparation failed.' }
    foreach ($target in @('api')) {
        # Secret contents do not invalidate BuildKit cache: always rebuild private layers.
        Invoke-Docker -DockerArgs @('buildx','build','--platform',$Platform,'--load','--target',"$target-private",'--no-cache-filter',"$target-private",'--secret',"id=api_config,src=$privateDir/api.env",'-t',"bria-cutout-${target}:$Tag",'-f','deploy/standalone/Dockerfile','.')
    }
    New-Item -ItemType Directory -Path $releaseDir | Out-Null
    Invoke-Docker -DockerArgs @('save','--output',(Join-Path $releaseDir 'images.tar'),"bria-cutout-api:$Tag")
    $compose = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'compose.yaml')).Replace('RELEASE_TAG',$Tag)
    [IO.File]::WriteAllText((Join-Path $releaseDir 'compose.yaml'),$compose)
    Copy-Item -LiteralPath (Join-Path $privateDir 'PRIVATE_ACCESS.txt') -Destination $releaseDir
    [IO.File]::Copy((Join-Path $PSScriptRoot 'DEPLOY.md'),(Join-Path $releaseDir 'DEPLOY.md'))
    # Windows PowerShell hosts may not expose Get-FileHash. Stream the archive
    # through .NET so large packages do not need to be loaded into memory.
    $archiveStream = [IO.File]::OpenRead((Join-Path $releaseDir 'images.tar'))
    $archiveHasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($archiveHasher.ComputeHash($archiveStream)).Replace('-', '').ToLowerInvariant() }
    finally { $archiveHasher.Dispose(); $archiveStream.Dispose() }
    [IO.File]::WriteAllText((Join-Path $releaseDir 'SHA256SUMS'),"$hash  images.tar`n")
    # This marker is written last; failed builds/exports cannot look like a complete release.
    [IO.File]::WriteAllText((Join-Path $releaseDir 'RELEASE.txt'),"Tag: $Tag`nPlatform: $Platform`nImage: bria-cutout-api:$Tag`n")
    Write-Output "Release ready: $releaseDir"
} finally {
    # Only remove exact temporary files from our unique directory, no recursive cleanup.
    if (Test-Path -LiteralPath $privateDir) {
        foreach ($file in @('api.env','nginx.conf','htpasswd','PRIVATE_ACCESS.txt')) {
            Remove-Item -LiteralPath (Join-Path $privateDir $file) -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $privateDir
    }
    Pop-Location
}
