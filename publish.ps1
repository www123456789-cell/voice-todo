param(
	[Parameter(Mandatory = $true)][string]$TokenFile,
	[string]$Owner = "www123456789-cell",
	[string]$Repo = "voice-todo",
	[string]$Version = "",
	[switch]$Private
)

# 用法：.\publish.ps1 -TokenFile C:\path\to\token.txt [-Private]
# 作用：建/更新仓库文件 → 建 release（tag = manifest.version）→ 挂 main.js / manifest.json / styles.css
# 不会打印 token。

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = $PSScriptRoot
$py = "C:\Users\theon\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
$publisher = "C:\Users\theon\Documents\ChatGPT\githubmd\doc2speech\tools\gh_publish.py"
$token = (Get-Content $TokenFile -Raw).Trim()
if (-not $token) { throw "token 文件是空的" }

$manifestText = [IO.File]::ReadAllText((Join-Path $root "manifest.json"), [Text.Encoding]::UTF8)
$manifest = $manifestText | ConvertFrom-Json
if (-not $Version) { $Version = $manifest.version }
if ($manifest.version -ne $Version) { throw "manifest.version=$($manifest.version) 与 -Version=$Version 不一致" }

Push-Location $root
try {
	Write-Host "[1/3] 上传仓库文件到 $Owner/$Repo ..."
	$flags = if ($Private) { "--private" } else { "--public" }
	& $py $publisher $TokenFile $root "$Owner/$Repo" $flags
	if ($LASTEXITCODE -ne 0) { throw "gh_publish 失败（退出码 $LASTEXITCODE）" }

	$headers = @{
		Authorization = "Bearer $token"
		Accept = "application/vnd.github+json"
		"X-GitHub-Api-Version" = "2022-11-28"
	}
	$api = "https://api.github.com/repos/$Owner/$Repo"

	Write-Host "[2/3] 建 release $Version ..."
	$body = @{
		tag_name = $Version
		name = $Version
		target_commitish = "main"
		draft = $false
		prerelease = $false
	} | ConvertTo-Json
	try {
		$release = Invoke-RestMethod -Uri "$api/releases" -Method Post -Headers $headers -Body $body -ContentType "application/json"
	} catch {
		# 已存在则复用
		$release = Invoke-RestMethod -Uri "$api/releases/tags/$Version" -Headers $headers
	}
	Write-Host "    release id = $($release.id)"

	Write-Host "[3/3] 上传附件 ..."
	foreach ($name in @("main.js", "manifest.json", "styles.css")) {
		$file = Join-Path $root $name
		if (-not (Test-Path $file)) { throw "缺少 $name" }
		$upload = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=$name"
		$res = Invoke-RestMethod -Uri $upload -Method Post -Headers $headers -ContentType "application/octet-stream" -InFile $file
		Write-Host "    $name -> $($res.name) ($($res.size) bytes)"
	}
	Write-Host "完成：https://github.com/$Owner/$Repo/releases/tag/$Version"
} finally {
	Pop-Location
}
