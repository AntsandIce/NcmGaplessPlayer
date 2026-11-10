<#
.SYNOPSIS
  GaplessPlayer 一键安装：自动装 BetterNCM（chromatic）+ 本插件。

.DESCRIPTION
  1. 找网易云音乐安装目录（进程 / 注册表 / 常见路径）
  2. 若没装 BetterNCM：从 std-microblock/chromatic 下载对应架构的 DLL，
     改名 msimg32.dll 放进网易云目录
  3. 把 GaplessPlayer 的 .plugin 复制进 BetterNCM 插件目录
  4. 需要时关闭 / 重启网易云

.PARAMETER CloudMusicPath
  手动指定网易云安装目录（一般不用给）。

.PARAMETER PluginPath
  手动指定 .plugin 文件；默认用脚本同目录的 *.plugin，没有再下载最新版。

.PARAMETER ForceBetterNcm
  即使 msimg32.dll 已存在也重新覆盖（会先备份）。

.PARAMETER UseOfficialInstaller
  不走手动 DLL，而是下载并运行 BetterNCM 官方安装器（GUI，兼容性由安装器判断；
  适合网易云 3.x 这类新版本）。

.PARAMETER NoRestart
  安装完不自动启动网易云。

.PARAMETER DryRun
  只打印将要做什么，不下载、不写文件、不弹管理员。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
#>
[CmdletBinding()]
param(
  [string]$CloudMusicPath = "",
  [string]$PluginPath = "",
  [switch]$ForceBetterNcm,
  [switch]$UseOfficialInstaller,
  [switch]$NoRestart,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$LOG = Join-Path $env:TEMP "gapless-player-install.log"
$TMP = Join-Path $env:TEMP "gapless-player-install"

function Write-Log([string]$msg, [string]$color = "Gray") {
  $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $msg
  try { Add-Content -Path $LOG -Value $line -Encoding UTF8 } catch {}
  Write-Host $msg -ForegroundColor $color
}

function Fail([string]$msg) {
  Write-Log "✖ $msg" "Red"
  Write-Log "日志：$LOG" "DarkGray"
  exit 1
}

function Test-Admin {
  try {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $pr = New-Object Security.Principal.WindowsPrincipal($id)
    return $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# ---------- 找网易云 ----------
function Find-CloudMusic {
  $cands = New-Object System.Collections.Generic.List[string]
  if ($CloudMusicPath) { $cands.Add($CloudMusicPath) }

  # 1) 正在运行的进程
  try {
    Get-Process -Name "cloudmusic" -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Path) { $cands.Add((Split-Path -Parent $_.Path)) }
    }
  } catch {}

  # 2) 卸载注册表
  $regRoots = @(
    "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )
  foreach ($root in $regRoots) {
    try {
      Get-ItemProperty $root -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match "网易云|CloudMusic|NetEase" } |
        ForEach-Object {
          if ($_.InstallLocation) { $cands.Add($_.InstallLocation) }
          if ($_.DisplayIcon) {
            $ico = ($_.DisplayIcon -split ",")[0].Trim('"')
            if ($ico) { $cands.Add((Split-Path -Parent $ico)) }
          }
        }
    } catch {}
  }

  # 3) 常见路径（含各个盘符）
  $subs = @(
    "Program Files\NetEase\CloudMusic",
    "Program Files (x86)\NetEase\CloudMusic",
    "Program Files\CloudMusic",
    "Program Files (x86)\CloudMusic",
    "CloudMusic",
    "NetEase\CloudMusic"
  )
  try {
    Get-PSDrive -PSProvider FileSystem | ForEach-Object {
      $root = $_.Root
      foreach ($s in $subs) { $cands.Add((Join-Path $root $s)) }
    }
  } catch {}

  foreach ($c in $cands) {
    if (-not $c) { continue }
    $exe = Join-Path $c "cloudmusic.exe"
    if (Test-Path -LiteralPath $exe) { return (Resolve-Path -LiteralPath $c).Path }
  }
  return $null
}

# ---------- PE 架构（0x8664=x64，0x014c=x86） ----------
function Get-PeMachine([string]$exe) {
  try {
    $fs = [System.IO.File]::OpenRead($exe)
    try {
      $br = New-Object System.IO.BinaryReader($fs)
      $fs.Position = 0x3C
      $peOff = $br.ReadInt32()
      if ($peOff -le 0 -or $peOff -gt ($fs.Length - 6)) { return 0 }
      $fs.Position = $peOff + 4
      return $br.ReadUInt16()
    } finally { $fs.Close() }
  } catch { return 0 }
}

# ---------- BetterNCM 插件数据目录 ----------
function Get-BetterNcmProfile {
  $cands = New-Object System.Collections.Generic.List[string]
  if ($env:BETTERNCM_PROFILE) { $cands.Add($env:BETTERNCM_PROFILE) }
  foreach ($scope in @("User", "Machine")) {
    try {
      $v = [Environment]::GetEnvironmentVariable("BETTERNCM_PROFILE", $scope)
      if ($v) { $cands.Add($v) }
    } catch {}
  }
  $cands.Add("C:\betterncm")
  $cands.Add((Join-Path $env:USERPROFILE "betterncm"))
  try { $cands.Add((Join-Path $env:APPDATA "betterncm")) } catch {}

  foreach ($c in $cands) {
    if (-not $c) { continue }
    if (Test-Path -LiteralPath (Join-Path $c "plugins")) { return $c }
  }
  # 都没有 → 按 BetterNCM 默认（用户目录）
  return (Join-Path $env:USERPROFILE "betterncm")
}

function Get-LatestBetterNcmAsset([string]$assetName) {
  # 优先查 GitHub API 找“第一个带该 DLL 的 release”，失败退回固定版本
  try {
    $rels = Invoke-RestMethod "https://api.github.com/repos/std-microblock/chromatic/releases?per_page=20" `
      -Headers @{ "User-Agent" = "GaplessPlayer-Installer" } -TimeoutSec 30
    foreach ($r in $rels) {
      $a = $r.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
      if ($a) { return @{ url = $a.browser_download_url; tag = $r.tag_name; size = $a.size } }
    }
  } catch {}
  return @{
    url  = "https://github.com/std-microblock/chromatic/releases/download/1.3.4/$assetName"
    tag  = "1.3.4"
    size = 0
  }
}

function Get-LatestPluginAsset {
  try {
    $r = Invoke-RestMethod "https://api.github.com/repos/AntsandIce/NcmGaplessPlayer/releases/latest" `
      -Headers @{ "User-Agent" = "GaplessPlayer-Installer" } -TimeoutSec 30
    $a = $r.assets | Where-Object { $_.name -like "*.plugin" } | Select-Object -First 1
    if ($a) { return @{ url = $a.browser_download_url; name = $a.name; tag = $r.tag_name; size = $a.size } }
  } catch {}
  return @{
    url  = "https://github.com/AntsandIce/NcmGaplessPlayer/releases/download/v1.20.0/gapless-player-1.20.0.plugin"
    name = "gapless-player-1.20.0.plugin"
    tag  = "v1.20.0"
    size = 0
  }
}

function Download-File([string]$url, [string]$dest) {
  $dir = Split-Path -Parent $dest
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Write-Log "下载：$url" "DarkGray"
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 300
  if (-not (Test-Path $dest)) { throw "下载失败：$dest" }
  return (Get-Item $dest).Length
}

# ================= 主流程 =================
Write-Log "===== GaplessPlayer 一键安装 =====" "Cyan"
Write-Log "日志：$LOG" "DarkGray"

if ($DryRun) {
  Write-Log "（DryRun：只检查，不写文件）" "Yellow"
} elseif (-not (Test-Admin)) {
  Write-Log "需要管理员权限（要写网易云安装目录），正在提权重开…" "Yellow"
  $argList = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
  if ($CloudMusicPath) { $argList += @("-CloudMusicPath", "`"$CloudMusicPath`"") }
  if ($PluginPath) { $argList += @("-PluginPath", "`"$PluginPath`"") }
  if ($ForceBetterNcm) { $argList += "-ForceBetterNcm" }
  if ($UseOfficialInstaller) { $argList += "-UseOfficialInstaller" }
  if ($NoRestart) { $argList += "-NoRestart" }
  try {
    Start-Process -FilePath "powershell.exe" -ArgumentList $argList -Verb RunAs
  } catch {
    Fail "提权失败（你点了“否”？）。请右键以管理员身份运行。"
  }
  exit 0
}

# 1) 找网易云
$cmDir = Find-CloudMusic
if (-not $cmDir) {
  Fail "没找到网易云音乐。请确认已安装，或用 -CloudMusicPath `"D:\...\CloudMusic`" 指定目录。"
}
$cmExe = Join-Path $cmDir "cloudmusic.exe"
Write-Log "网易云目录：$cmDir" "Green"
try {
  $ver = (Get-Item $cmExe).VersionInfo.FileVersion
  Write-Log "客户端版本：$ver" "DarkGray"
  $vNum = [version](($ver -split "\s")[0])
  if ($vNum -lt [version]"2.10.2") {
    Write-Log "⚠ 客户端低于 2.10.2，BetterNCM 可能不工作。" "Yellow"
  }
} catch {}

$machine = Get-PeMachine $cmExe
$is64 = ($machine -eq 0x8664)
if ($machine -eq 0) { Write-Log "⚠ 读不出 exe 架构，按 64 位处理。" "Yellow"; $is64 = $true }
Write-Log ("客户端架构：" + $(if ($is64) { "x64" } else { "x86" })) "DarkGray"

# 2) BetterNCM
$msimg = Join-Path $cmDir "msimg32.dll"
$needBetter = -not (Test-Path -LiteralPath $msimg) -or $ForceBetterNcm
if (-not $needBetter) {
  Write-Log "已检测到 BetterNCM（msimg32.dll 存在），跳过。" "Green"
} else {
  if ($UseOfficialInstaller) {
    # 官方安装器：兼容性由它自己判断（推荐 3.x 用）
    $url = "https://github.com/std-microblock/BetterNCM-Installer/releases/latest/download/betterncm_installer.exe"
    Write-Log "使用 BetterNCM 官方安装器（会弹出安装器窗口，点安装按钮即可）" "DarkGray"
    if ($DryRun) {
      Write-Log "[DryRun] 会下载并运行 $url" "Yellow"
    } else {
      $exe = Join-Path $TMP "betterncm_installer.exe"
      try {
        Download-File $url $exe | Out-Null
        Start-Process -FilePath $exe -Wait
      } catch {
        Fail ("官方安装器运行失败：" + $_.Exception.Message)
      }
      if (-not (Test-Path -LiteralPath $msimg)) {
        Fail "安装器结束后仍然没有 msimg32.dll —— 可能你在安装器里点了取消，或版本不受支持。"
      }
      Write-Log "BetterNCM 已由官方安装器安装" "Green"
    }
  } else {
    $assetName = if ($is64) { "BetterNCMII.dll" } else { "BetterNCMII86.dll" }
    $info = Get-LatestBetterNcmAsset $assetName
    Write-Log "BetterNCM 版本：$($info.tag)  → $assetName" "DarkGray"
    if ($DryRun) {
      Write-Log "[DryRun] 会下载 $($info.url) 并复制为 $msimg" "Yellow"
    } else {
      $tmpDll = Join-Path $TMP $assetName
      try {
        $len = Download-File $info.url $tmpDll
        if ($len -lt 300KB) { throw "文件太小（$len 字节），可能下载错了" }
        $head = ([System.IO.File]::ReadAllBytes($tmpDll))[0..1] -join ","
        if ($head -ne "77,90") { throw "不是 PE 文件（MZ 头不对）" }
        if (Test-Path -LiteralPath $msimg) {
          $bak = "$msimg.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
          Copy-Item -LiteralPath $msimg -Destination $bak -Force
          Write-Log "旧 msimg32.dll 已备份：$bak" "DarkGray"
        }
        Copy-Item -LiteralPath $tmpDll -Destination $msimg -Force
        Write-Log "BetterNCM 已安装（$assetName → msimg32.dll）" "Green"
        if ($vNum -and $vNum -ge [version]"3.0.0") {
          Write-Log "⚠ 你是 3.x 客户端；如果重启后没出现插件管理器，请改用 -UseOfficialInstaller 再试。" "Yellow"
        }
      } catch {
        Fail ("BetterNCM 安装失败：" + $_.Exception.Message)
      }
    }
  }
}

# 3) 插件目录
$profile = Get-BetterNcmProfile
$pluginsDir = Join-Path $profile "plugins"
Write-Log "BetterNCM 数据目录：$profile" "Green"
if (-not $DryRun -and -not (Test-Path -LiteralPath $pluginsDir)) {
  New-Item -ItemType Directory -Path $pluginsDir -Force | Out-Null
  Write-Log "已创建插件目录：$pluginsDir" "DarkGray"
}

# 4) 插件文件：优先本地，其次下载
$pluginFile = $null
if ($PluginPath) {
  if (-not (Test-Path -LiteralPath $PluginPath)) { Fail "指定的插件不存在：$PluginPath" }
  $pluginFile = (Resolve-Path -LiteralPath $PluginPath).Path
} else {
  $local = Get-ChildItem -LiteralPath $SCRIPT_DIR -Filter "*.plugin" -File -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
  if ($local) { $pluginFile = $local.FullName }
}
if (-not $pluginFile) {
  $pinfo = Get-LatestPluginAsset
  Write-Log "插件版本：$($pinfo.tag)  → $($pinfo.name)" "DarkGray"
  if ($DryRun) {
    Write-Log "[DryRun] 会下载 $($pinfo.url)" "Yellow"
    $pluginFile = "(dry-run) $($pinfo.name)"
  } else {
    $pluginFile = Join-Path $TMP $pinfo.name
    try { Download-File $pinfo.url $pluginFile | Out-Null }
    catch { Fail ("插件下载失败：" + $_.Exception.Message) }
  }
} else {
  Write-Log "使用本地插件：$pluginFile" "DarkGray"
}

# 5) 关掉正在运行的网易云（DLL 被占用会覆盖失败）
$running = Get-Process -Name "cloudmusic" -ErrorAction SilentlyContinue
$stoppedByUs = $false
if ($running) {
  if ($DryRun) {
    Write-Log "[DryRun] 检测到网易云正在运行（安装时会提示关闭）" "Yellow"
  } else {
    $ans = Read-Host "网易云正在运行，安装需要先关闭它。现在关闭？(Y/n)"
    if ($ans -and $ans.ToLower().StartsWith("n")) { Fail "已取消（请手动关闭网易云后重试）" }
    try {
      $running | Stop-Process -Force -ErrorAction Stop
      Start-Sleep -Milliseconds 800
      $stoppedByUs = $true
      Write-Log "已关闭网易云" "Green"
    } catch { Fail ("关闭网易云失败：" + $_.Exception.Message) }
  }
}

# 6) 装插件（清旧版 / 清旧运行时）
if ($DryRun) {
  Write-Log "[DryRun] 会把 $pluginFile 复制到 $pluginsDir" "Yellow"
} else {
  $dest = Join-Path $pluginsDir (Split-Path -Leaf $pluginFile)
  foreach ($prefix in @("WebPlayer-", "GaplessPlayer-", "gapless-player-")) {
    Get-ChildItem -LiteralPath $pluginsDir -Filter "$prefix*.plugin" -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -ne (Split-Path -Leaf $pluginFile) } |
      ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
        Write-Log "已删除旧插件：$($_.Name)" "DarkGray"
      }
  }
  Copy-Item -LiteralPath $pluginFile -Destination $dest -Force
  Write-Log "插件已安装：$dest" "Green"

  $runtimeRoot = Join-Path $profile "plugins_runtime"
  foreach ($rt in @("gapless-player", "GaplessPlayer", "webplayer")) {
    $p = Join-Path $runtimeRoot $rt
    if (Test-Path -LiteralPath $p) {
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
      Write-Log "已清理旧运行时目录：$p" "DarkGray"
    }
  }
}

# 7) 重启
if (-not $DryRun -and -not $NoRestart) {
  if ($stoppedByUs -or -not $running) {
    try {
      Start-Process -FilePath $cmExe
      Write-Log "已启动网易云" "Green"
    } catch { Write-Log "⚠ 启动网易云失败，请手动打开。" "Yellow" }
  }
}

Write-Log ""
Write-Log "===== 安装完成 =====" "Cyan"
Write-Log "网易云设置 → BetterNCM → 插件列表里应能看到 GaplessPlayer。" "Gray"
Write-Log "日志：$LOG" "DarkGray"
