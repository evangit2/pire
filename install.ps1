# ============================================================================
# pire Installer for Windows
# ============================================================================
# Cross-platform installer with interactive component selection.
#
# Usage:
#   irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex
#
# Or with options:
#   .\install.ps1 -All
#   .\install.ps1 -CoreOnly
#   .\install.ps1 -NoWine
#   .\install.ps1 -NonInteractive
# ============================================================================

param(
    [switch]$All,
    [switch]$CoreOnly,
    [switch]$NoWine,
    [switch]$NonInteractive,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Force UTF-8 so box-drawing chars render correctly
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# ── Helpers ───────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host "|                   pire Installer                         |" -ForegroundColor Magenta
    Write-Host "|  Autonomous reverse-engineering agent                    |" -ForegroundColor Magenta
    Write-Host "|  github.com/evangit2/pire                                |" -ForegroundColor Magenta
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host ""
}

function Write-Section($Title) {
    Write-Host ""
    Write-Host "===========================================================" -ForegroundColor Magenta
    Write-Host "  $Title" -ForegroundColor Magenta
    Write-Host "===========================================================" -ForegroundColor Magenta
}

function Write-Step($Msg)   { Write-Host "-> $Msg" -ForegroundColor Cyan }
function Write-Ok($Msg)     { Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn2($Msg)  { Write-Host "[!] $Msg" -ForegroundColor Yellow }
function Write-Err2($Msg)   { Write-Host "[X] $Msg" -ForegroundColor Red }

function Has-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Prompt-YesNo {
    param([string]$Question, [string]$Default = "n")

    if ($NonInteractive) {
        return ($Default -eq "y")
    }

    $suffix = if ($Default -eq "y") { "[Y/n]" } else { "[y/N]" }
    Write-Host "$Question $suffix " -NoNewline
    $answer = Read-Host
    $answer = $answer.Trim().ToLower()

    if ([string]::IsNullOrWhiteSpace($answer)) {
        return ($Default -eq "y")
    }
    return ($answer -eq "y" -or $answer -eq "yes")
}

# ── Parse args ────────────────────────────────────────────────

if ($Help) {
    Write-Host "pire install — cross-platform installer for Windows"
    Write-Host ""
    Write-Host "Usage: .\install.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -All             Install everything (no prompts)"
    Write-Host "  -CoreOnly        Install only core components (no prompts)"
    Write-Host "  -NoWine          Skip Wine installation"
    Write-Host "  -NonInteractive  Non-interactive (accept all defaults)"
    Write-Host "  -Help            Show this help"
    Write-Host ""
    Write-Host "One-liner:"
    Write-Host "  irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex"
    exit 0
}

if ($All) { $NonInteractive = $true }

Write-Banner

# ── Component flags ───────────────────────────────────────────

$InstallWine        = $false
$InstallMinGW       = $false
$InstallGhidra      = $false
$InstallFrida       = $false
$InstallGDB         = $false
$InstallBinwalk     = $false
$InstallJADX        = $false
$InstallILSpy       = $false
$InstallYara        = $false
$InstallVolatility  = $false
$InstallPythonTools = $false

# ── Component Selection ──────────────────────────────────────

Write-Section "Component Selection"

Write-Host "  Core (always installed):"
Write-Host "    Node.js, npm, git, radare2, binutils (file, nm, strings, objdump)"
Write-Host ""

if ($All) {
    Write-Host "  Installing ALL components" -ForegroundColor Green
    $InstallWine = -not $NoWine
    $InstallMinGW = $true
    $InstallGhidra = $true
    $InstallFrida = $true
    $InstallGDB = $true
    $InstallBinwalk = $true
    $InstallJADX = $true
    $InstallILSpy = $true
    $InstallYara = $true
    $InstallVolatility = $true
    $InstallPythonTools = $true
} elseif ($CoreOnly) {
    Write-Host "  Installing CORE components only" -ForegroundColor Green
} else {
    Write-Host "  Select optional components:"
    Write-Host ""

    if (-not $NoWine) {
        if (Prompt-YesNo "  Wine (run Linux/ELF binaries via WSL)" "y") {
            $InstallWine = $true
            Write-Host "    [OK] Wine" -ForegroundColor Green
        } else {
            Write-Host "    [X] Wine" -ForegroundColor Red
        }
    }

    if (Prompt-YesNo "  MinGW-w64 (cross-compile Windows binaries)" "y") {
        $InstallMinGW = $true
        Write-Host "    [OK] MinGW-w64" -ForegroundColor Green
    } else {
        Write-Host "    [X] MinGW-w64" -ForegroundColor Red
    }

    if (Prompt-YesNo "  Python RE tools (capstone, keystone, unicorn, angr, lief)" "y") {
        $InstallPythonTools = $true
        Write-Host "    [OK] Python RE tools" -ForegroundColor Green
    } else {
        Write-Host "    [X] Python RE tools" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "  Advanced tools (optional):"
    Write-Host ""

    if (Prompt-YesNo "  Ghidra (decompiler — ~400MB download)" "n") {
        $InstallGhidra = $true
        Write-Host "    [OK] Ghidra" -ForegroundColor Green
    } else { Write-Host "    [X] Ghidra" -ForegroundColor Red }

    if (Prompt-YesNo "  Frida (dynamic instrumentation)" "n") {
        $InstallFrida = $true
        Write-Host "    [OK] Frida" -ForegroundColor Green
    } else { Write-Host "    [X] Frida" -ForegroundColor Red }

    if (Prompt-YesNo "  GDB (scripted debugging)" "n") {
        $InstallGDB = $true
        Write-Host "    [OK] GDB" -ForegroundColor Green
    } else { Write-Host "    [X] GDB" -ForegroundColor Red }

    if (Prompt-YesNo "  Binwalk (firmware extraction)" "n") {
        $InstallBinwalk = $true
        Write-Host "    [OK] Binwalk" -ForegroundColor Green
    } else { Write-Host "    [X] Binwalk" -ForegroundColor Red }

    if (Prompt-YesNo "  JADX (APK/DEX -> Java decompiler)" "n") {
        $InstallJADX = $true
        Write-Host "    [OK] JADX" -ForegroundColor Green
    } else { Write-Host "    [X] JADX" -ForegroundColor Red }

    if (Prompt-YesNo "  ILSpy (.NET -> C# decompiler)" "n") {
        $InstallILSpy = $true
        Write-Host "    [OK] ILSpy" -ForegroundColor Green
    } else { Write-Host "    [X] ILSpy" -ForegroundColor Red }

    if (Prompt-YesNo "  Yara (pattern matching)" "n") {
        $InstallYara = $true
        Write-Host "    [OK] Yara" -ForegroundColor Green
    } else { Write-Host "    [X] Yara" -ForegroundColor Red }

    if (Prompt-YesNo "  Volatility (memory forensics)" "n") {
        $InstallVolatility = $true
        Write-Host "    [OK] Volatility" -ForegroundColor Green
    } else { Write-Host "    [X] Volatility" -ForegroundColor Red }
}

# ── Detect Package Manager ────────────────────────────────────

Write-Section "Platform Detection"

$PkgMgr = ""
if (Has-Command "choco") {
    $PkgMgr = "choco"
    Write-Ok "Package manager: Chocolatey"
} elseif (Has-Command "winget") {
    $PkgMgr = "winget"
    Write-Ok "Package manager: winget"
} elseif (Has-Command "scoop") {
    $PkgMgr = "scoop"
    Write-Ok "Package manager: Scoop"
} else {
    Write-Step "No package manager found. Installing Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:PATH += ";$env:ALLUSERSPROFILE\chocolatey\bin"
    $PkgMgr = "choco"
    Write-Ok "Chocolatey installed"
}

# ── Install Core ──────────────────────────────────────────────

Write-Section "Core Components"

function Pkg-Install {
    param([string[]]$Packages)
    foreach ($pkg in $Packages) {
        Write-Step "Installing $pkg..."
        switch ($PkgMgr) {
            "choco"  { choco install $pkg -y --no-progress 2>$null }
            "winget" { winget install --id $pkg -e --accept-source-agreements --accept-package-agreements 2>$null }
            "scoop"  { scoop install $pkg 2>$null }
        }
    }
}

Write-Step "Installing core packages..."
switch ($PkgMgr) {
    "choco" {
        choco install nodejs-lts git radare2 -y --no-progress 2>$null
    }
    "winget" {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements 2>$null
        winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements 2>$null
        winget install --id radare.radare2 -e --accept-source-agreements --accept-package-agreements 2>$null
    }
    "scoop" {
        scoop install nodejs-lts git radare2 2>$null
    }
}

# Refresh PATH
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

Write-Step "Checking Node.js..."
if (Has-Command "node") {
    $nodeVer = node -v
    Write-Ok "Node.js $nodeVer"
} else {
    Write-Err2 "Node.js installation failed"
    Write-Warn2 "Install manually from https://nodejs.org/"
}

if (Has-Command "npm") {
    Write-Ok "npm $(npm -v)"
}

if (Has-Command "git") {
    Write-Ok "git installed"
}

if (Has-Command "r2") {
    Write-Ok "radare2 installed"
}

# ── Install Wine ──────────────────────────────────────────────

if ($InstallWine) {
    Write-Section "Wine"
    if ($PkgMgr -eq "choco") {
        Write-Step "Installing Wine..."
        choco install wine -y --no-progress 2>$null
        if (Has-Command "wine") { Write-Ok "Wine installed" } else { Write-Warn2 "Wine install may need restart" }
    } else {
        Write-Warn2 "Wine install on Windows via $PkgMgr not automated."
        Write-Warn2 "Consider using WSL for Linux binary analysis."
    }
}

# ── Install MinGW ─────────────────────────────────────────────

if ($InstallMinGW) {
    Write-Section "MinGW-w64"
    Write-Step "Installing MinGW-w64..."
    switch ($PkgMgr) {
        "choco"  { choco install mingw -y --no-progress 2>$null }
        "winget" { winget install --id MartinStorsjo.LLVM-MinGW.UCRT -e --accept-source-agreements --accept-package-agreements 2>$null }
        "scoop"  { scoop install mingw 2>$null }
    }
    if (Has-Command "gcc") { Write-Ok "MinGW-w64 installed" } else { Write-Warn2 "MinGW install may need restart" }
}

# ── Install GDB ───────────────────────────────────────────────

if ($InstallGDB) {
    Write-Section "GDB"
    Write-Step "Installing GDB..."
    switch ($PkgMgr) {
        "choco"  { choco install gdb -y --no-progress 2>$null }
        "scoop"  { scoop install gdb 2>$null }
    }
    if (Has-Command "gdb") { Write-Ok "GDB installed" } else { Write-Warn2 "GDB install failed" }
}

# ── Install Binwalk ───────────────────────────────────────────

if ($InstallBinwalk) {
    Write-Section "Binwalk"
    Write-Step "Installing Binwalk via pip..."
    if (Has-Command "pip") {
        pip install binwalk 2>$null
        if (Has-Command "binwalk") { Write-Ok "Binwalk installed" } else { Write-Warn2 "Binwalk install failed" }
    } else {
        Write-Warn2 "pip not found — install Python first"
    }
}

# ── Install Yara ──────────────────────────────────────────────

if ($InstallYara) {
    Write-Section "Yara"
    Write-Step "Installing Yara..."
    switch ($PkgMgr) {
        "choco"  { choco install yara -y --no-progress 2>$null }
        "winget" { Write-Warn2 "Yara not in winget — trying pip..." }
        "scoop"  { scoop install yara 2>$null }
    }
    if (Has-Command "yara") { Write-Ok "Yara installed" } else {
        if (Has-Command "pip") { pip install yara-python 2>$null }
        Write-Warn2 "Yara CLI not found — python binding may be installed"
    }
}

# ── Install Volatility ────────────────────────────────────────

if ($InstallVolatility) {
    Write-Section "Volatility"
    Write-Step "Installing Volatility 3 via pip..."
    if (Has-Command "pip") {
        pip install volatility3 2>$null
        Write-Ok "Volatility 3 installed"
    } else {
        Write-Warn2 "pip not found — install Python first"
    }
}

# ── Install Frida ─────────────────────────────────────────────

if ($InstallFrida) {
    Write-Section "Frida"
    Write-Step "Installing Frida..."
    if (Has-Command "pip") {
        pip install frida-tools 2>$null
        if (Has-Command "frida") { Write-Ok "Frida installed" } else { Write-Warn2 "Frida install failed" }
    } else {
        Write-Warn2 "pip not found — install Python first"
    }
}

# ── Install JADX ──────────────────────────────────────────────

if ($InstallJADX) {
    Write-Section "JADX"
    Write-Step "Installing JADX..."
    $jadxVer = "1.5.0"
    $jadxUrl = "https://github.com/skylot/jadx/releases/download/v${jadxVer}/jadx-${jadxVer}.zip"
    $jadxDir = "$env:LOCALAPPDATA\pire-tools\jadx"
    $jadxZip = "$env:TEMP\jadx.zip"

    Write-Step "Downloading JADX v$jadxVer..."
    try {
        Invoke-WebRequest -Uri $jadxUrl -OutFile $jadxZip -UseBasicParsing
        New-Item -ItemType Directory -Path $jadxDir -Force | Out-Null
        Expand-Archive -Path $jadxZip -DestinationPath $jadxDir -Force
        $jadxBat = "$jadxDir\bin\jadx.bat"
        if (Test-Path $jadxBat) {
            $binDir = "$env:LOCALAPPDATA\pire-tools\bin"
            New-Item -ItemType Directory -Path $binDir -Force | Out-Null
            Copy-Item $jadxBat "$binDir\jadx.bat" -Force
            $env:PATH += ";$binDir"
            Write-Ok "JADX installed to $jadxDir"
        } else {
            Write-Warn2 "JADX extraction failed"
        }
        Remove-Item $jadxZip -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Warn2 "JADX download failed: $_"
    }
}

# ── Install ILSpy ─────────────────────────────────────────────

if ($InstallILSpy) {
    Write-Section "ILSpy"
    Write-Step "Installing ILSpy..."
    switch ($PkgMgr) {
        "choco"  { choco install dotnet-sdk -y --no-progress 2>$null }
        "winget" { winget install --id Microsoft.DotNet.SDK.8 -e --accept-source-agreements --accept-package-agreements 2>$null }
        "scoop"  { scoop install dotnet-sdk 2>$null }
    }
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    if (Has-Command "dotnet") {
        Write-Step "Installing ilspycmd..."
        dotnet tool install -g ilspycmd 2>$null
        Write-Ok "ILSpy installed via dotnet tool"
    } else {
        Write-Warn2 ".NET SDK not found — install from https://dotnet.microsoft.com/"
    }
}

# ── Install Ghidra ────────────────────────────────────────────

if ($InstallGhidra) {
    Write-Section "Ghidra"
    Write-Step "Installing Ghidra..."
    $ghidraVer = "11.1.2"
    $ghidraDate = "20240709"
    $ghidraUrl = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${ghidraVer}_build/ghidra_${ghidraVer}_PUBLIC_${ghidraDate}.zip"
    $ghidraDir = "$env:LOCALAPPDATA\pire-tools\ghidra"
    $ghidraZip = "$env:TEMP\ghidra.zip"

    # Ensure Java
    if (-not (Has-Command "java")) {
        Write-Step "Installing Java JDK..."
        switch ($PkgMgr) {
            "choco"  { choco install microsoft-openjdk17 -y --no-progress 2>$null }
            "winget" { winget install --id Microsoft.OpenJDK.17 -e --accept-source-agreements --accept-package-agreements 2>$null }
        }
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
    }

    if (Has-Command "java") {
        Write-Step "Downloading Ghidra v$ghidraVer (~400MB)..."
        try {
            Invoke-WebRequest -Uri $ghidraUrl -OutFile $ghidraZip -UseBasicParsing
            Write-Step "Extracting..."
            New-Item -ItemType Directory -Path $ghidraDir -Force | Out-Null
            Expand-Archive -Path $ghidraZip -DestinationPath $ghidraDir -Force
            $ghidraExe = Get-ChildItem -Path $ghidraDir -Filter "ghidraRun.bat" -Recurse | Select-Object -First 1
            if ($ghidraExe) {
                $binDir = "$env:LOCALAPPDATA\pire-tools\bin"
                New-Item -ItemType Directory -Path $binDir -Force | Out-Null
                # Create a wrapper batch file
                "@echo off`r`ncall `"$($ghidraExe.FullName)`" %*" | Set-Content "$binDir\ghidra.bat" -Encoding ASCII
                $env:PATH += ";$binDir"
                Write-Ok "Ghidra installed to $ghidraDir"
            } else {
                Write-Warn2 "Ghidra extraction failed"
            }
            Remove-Item $ghidraZip -Force -ErrorAction SilentlyContinue
        } catch {
            Write-Warn2 "Ghidra download failed: $_"
            Write-Warn2 "Install manually from https://ghidra-sre.org/"
        }
    } else {
        Write-Warn2 "Java not installed — Ghidra requires JDK 17+"
    }
}

# ── Install Python RE Tools ───────────────────────────────────

if ($InstallPythonTools) {
    Write-Section "Python RE Tools"
    Write-Step "Installing capstone, keystone, unicorn, angr, lief..."
    if (Has-Command "pip") {
        pip install capstone keystone-engine unicorn angr lief 2>$null
        Write-Ok "Python RE tools installed"
    } else {
        Write-Warn2 "pip not found — installing Python..."
        switch ($PkgMgr) {
            "choco"  { choco install python -y --no-progress 2>$null }
            "winget" { winget install --id Python.Python.3.12 -e --accept-source-agreements --accept-package-agreements 2>$null }
            "scoop"  { scoop install python 2>$null }
        }
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
        if (Has-Command "pip") {
            pip install capstone keystone-engine unicorn angr lief 2>$null
            Write-Ok "Python RE tools installed"
        } else {
            Write-Warn2 "Python installation failed"
        }
    }
}

# ── Verification ──────────────────────────────────────────────

Write-Section "Verification"

Write-Host ""
if (Has-Command "node")    { Write-Ok "Node.js $(node -v)" } else { Write-Err2 "Node.js not installed" }
if (Has-Command "npm")     { Write-Ok "npm $(npm -v)" }      else { Write-Err2 "npm not installed" }
if (Has-Command "git")     { Write-Ok "git" }                else { Write-Warn2 "git not installed" }
if (Has-Command "r2")      { Write-Ok "radare2" }            else { Write-Warn2 "radare2 not installed" }

if ($InstallWine -and (Has-Command "wine"))        { Write-Ok "wine" }
if ($InstallMinGW -and (Has-Command "gcc"))         { Write-Ok "MinGW-w64" }
if ($InstallGDB -and (Has-Command "gdb"))           { Write-Ok "gdb" }
if ($InstallBinwalk -and (Has-Command "binwalk"))   { Write-Ok "binwalk" }
if ($InstallFrida -and (Has-Command "frida"))       { Write-Ok "frida" }
if ($InstallJADX -and (Has-Command "jadx"))         { Write-Ok "jadx" }
if ($InstallYara -and (Has-Command "yara"))         { Write-Ok "yara" }

# ── Install npm Dependencies ─────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = (Get-Location).Path }

if (Test-Path (Join-Path $ScriptDir "package.json")) {
    Write-Section "Node.js Dependencies"
    Write-Step "Installing npm dependencies..."
    Push-Location $ScriptDir
    try {
        npm install --ignore-scripts 2>$null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "npm dependencies installed"
        } else {
            npm install 2>$null
            Write-Warn2 "npm install had issues"
        }
    } finally {
        Pop-Location
    }

    # Run tests
    $testSuite = Join-Path $ScriptDir "packages\re-agent\test\test-suite.cjs"
    if (Test-Path $testSuite) {
        Write-Step "Running test suite..."
        Push-Location $ScriptDir
        try {
            node $testSuite 2>&1 | Select-Object -Last 3
            if ($LASTEXITCODE -eq 0) { Write-Ok "Tests passed" } else { Write-Warn2 "Some tests failed" }
        } finally {
            Pop-Location
        }
    }
}

# ── Done ──────────────────────────────────────────────────────

Write-Section "Installation Complete"

Write-Host ""
Write-Host "  pire is ready!" -ForegroundColor Green
Write-Host ""
Write-Host "  Next steps:"
Write-Host ""
Write-Host "    1. Set your LLM API credentials:"
Write-Host '       $env:OPENAI_API_KEY = "your-key"'
Write-Host '       $env:OPENAI_BASE_URL = "https://api.openai.com/v1"'
Write-Host '       $env:OPENAI_MODEL = "gpt-4o"'
Write-Host ""
Write-Host "    2. Start pire:"
Write-Host "       pire                              # start chat"
Write-Host "       pire C:\Windows\System32\notepad.exe  # analyze a binary"
Write-Host ""
Write-Host "  Docs: https://github.com/evangit2/pire" -ForegroundColor Cyan
Write-Host ""
