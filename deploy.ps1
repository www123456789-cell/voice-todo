param(
	[string]$Vault = "C:\Users\theon\Desktop\新建文件夹 (2)\第二发言者",
	[switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$dst = Join-Path $Vault ".obsidian\plugins\voice-todo"

if (-not $SkipBuild) {
	Push-Location $src
	try {
		& node esbuild.config.mjs production
		if ($LASTEXITCODE -ne 0) { throw "build failed" }
	} finally {
		Pop-Location
	}
}

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $src "manifest.json"), (Join-Path $src "main.js"), (Join-Path $src "styles.css") -Destination $dst -Force
Write-Host "deployed to $dst"
Write-Host "reload Obsidian (Ctrl+R) to pick it up"
