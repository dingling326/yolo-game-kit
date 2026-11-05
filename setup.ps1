# 第一次使用：建立 .venv 虛擬環境並安裝套件（只要做一次）
# VS Code：Ctrl+Shift+P → Tasks: Run Task →「1. 安裝環境（第一次）」
# 或在這個資料夾按右鍵用 PowerShell 執行：powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
# 讓 pip 用 UTF-8 讀 requirements.txt（中文 Windows 預設 cp950 會讀不懂中文註解）
$env:PYTHONUTF8 = "1"

# 找 Python 3.10～3.13
$py = $null
$pyArgs = @()
foreach ($cand in @("py -3.13", "py -3.12", "py -3.11", "py -3.10", "python")) {
    $parts = $cand -split " "
    $exe = $parts[0]
    $extra = @($parts | Select-Object -Skip 1)
    try {
        $v = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $v -match '^3\.(1[0-3])$') { $py = $exe; $pyArgs = $extra; break }
    } catch {}
}
if (-not $py) {
    Write-Host ""
    Write-Host "找不到 Python 3.10～3.13。請到 https://www.python.org/downloads/ 安裝 Python 3.12，" -ForegroundColor Red
    Write-Host "安裝時記得勾選「Add python.exe to PATH」，裝好後關掉 VS Code 再打開，重跑這個步驟。" -ForegroundColor Red
    exit 1
}
Write-Host "使用 Python $v（$py $pyArgs）"

if (-not (Test-Path ".venv\Scripts\python.exe")) {
    Write-Host "建立虛擬環境 .venv ..."
    & $py @pyArgs -m venv .venv
}
Write-Host "安裝套件（第一次約 2～5 分鐘）..."
& .venv\Scripts\python.exe -m pip install --disable-pip-version-check -q --upgrade pip
# 舊版用 opencv-python，現在改用 opencv-contrib-python；兩個同時存在會互相蓋掉，先移除舊的
$hasOld = $false
try {
    & .venv\Scripts\python.exe -m pip show -q opencv-python 2>$null | Out-Null
    $hasOld = ($LASTEXITCODE -eq 0)
} catch {}       # 沒裝的時候 pip 會在 stderr 印警告，PowerShell 5.1 會把它當成錯誤
if ($hasOld) {
    Write-Host "移除舊的 opencv-python（改用 opencv-contrib-python）..."
    & .venv\Scripts\python.exe -m pip uninstall -y -q opencv-python
}
& .venv\Scripts\python.exe -m pip install --disable-pip-version-check -r requirements.txt
if ($LASTEXITCODE -ne 0) { Write-Host "套件安裝失敗，請檢查網路後再試一次" -ForegroundColor Red; exit 1 }

& .venv\Scripts\python.exe -c "import cv2, onnxruntime, aiohttp, mediapipe; cv2.aruco; print('檢查通過：opencv', cv2.__version__, '／onnxruntime', onnxruntime.__version__, '／mediapipe', mediapipe.__version__)"
Write-Host ""
Write-Host "完成！按 F5 啟動（或 Ctrl+Shift+P → Tasks: Run Task →「2. 啟動」）" -ForegroundColor Green
