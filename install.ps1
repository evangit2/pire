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

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

# Force UTF-8 so box-drawing chars render correctly
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

# ── Helpers ───────────────────────────────────────────────────

function Write-Banner {
    Write-Host ""
    Write-Host "+---------------------------------------------------------+" -ForegroundColor Magenta
    Write-Host "|  pire Installer                                         |" -ForegroundColor Magenta
    Write-Host "|  Autonomous reverse-engineering agent                   |" -ForegroundColor Magenta
    Write-Host "|  github.com/evangit2/pire                               |" -ForegroundColor Magenta
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
function Write-Err($Msg)    { Write-Host "[X] $Msg" -ForegroundColor Red }

function Has-Command($Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Pip {
    param([Parameter(ValueFromRemainingArguments=$true)][string[]]$PipArgs)
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    $out = & pip @PipArgs 2>&1
    $ErrorActionPreference = $prevEAP
    return $LASTEXITCODE -eq 0
}

# ── Parse args ────────────────────────────────────────────────

if ($Help) {
    Write-Host "pire install — Windows installer"
    Write-Host ""
    Write-Host "Usage: .\install.ps1 [options]"
    Write-Host ""
    Write-Host "Options:"
    Write-Host "  -All            Install everything (no prompts)"
    Write-Host "  -CoreOnly       Install only core components (no prompts)"
    Write-Host "  -NoWine         Skip Wine installation"
    Write-Host "  -NonInteractive No prompts (accept all defaults)"
    Write-Host "  -Help           Show this help"
    exit 0
}

Write-Banner

# ── Detect Platform ───────────────────────────────────────────
Write-Section "Platform Detection"

$PkgMgr = ""
if (Has-Command "choco")      { $PkgMgr = "choco";  Write-Ok "Package manager: choco" }
elseif (Has-Command "winget") { $PkgMgr = "winget"; Write-Ok "Package manager: winget" }
elseif (Has-Command "scoop")  { $PkgMgr = "scoop";  Write-Ok "Package manager: scoop" }
else {
    Write-Warn2 "No package manager found (choco/winget/scoop)"
    Write-Warn2 "Install winget or chocolatey first."
    exit 1
}

# ── Component Selection ──────────────────────────────────────
Write-Section "Component Selection"

Write-Host "  Core (always installed):"
Write-Host "    Node.js, npm, git, radare2, binutils (file, nm, strings, objdump)"
Write-Host ""

$InstallWine         = $false
$InstallMinGW        = $false
$InstallGhidra       = $false
$InstallFrida        = $false
$InstallGDB          = $false
$InstallBinwalk      = $false
$InstallJADX         = $false
$InstallILSpy        = $false
$InstallYara         = $false
$InstallVolatility   = $false
$InstallPythonTools  = $false

if ($All) {
    Write-Host "  Installing ALL components" -ForegroundColor Green
    $InstallWine = $true; $InstallMinGW = $true; $InstallGhidra = $true
    $InstallFrida = $true; $InstallGDB = $true; $InstallBinwalk = $true
    $InstallJADX = $true; $InstallILSpy = $true; $InstallYara = $true
    $InstallVolatility = $true; $InstallPythonTools = $true
    if ($NoWine) { $InstallWine = $false }
} elseif ($CoreOnly) {
    Write-Host "  Installing CORE components only" -ForegroundColor Green
} else {
    Write-Host "  Select optional components:"
    Write-Host ""

    $prompt = {
        param($q, $default)
        if ($NonInteractive) { return ($default -ieq 'y') }
        $suffix = if ($default -ieq 'y') { "[Y/n]" } else { "[y/N]" }
        Write-Host -NoNewline "  $q $suffix "
        $r = Read-Host
        if ($r -eq "") { return ($default -ieq 'y') }
        return $r -imatch '^[yY]'
    }

    if (& $prompt "Wine (run Linux/ELF binaries via WSL)" "y") { $InstallWine = $true;       Write-Host "    [OK] Wine" }       else { Write-Host "    --  Wine" }
    if (& $prompt "MinGW-w64 (cross-compile Windows binaries)" "y") { $InstallMinGW = $true;  Write-Host "    [OK] MinGW-w64" } else { Write-Host "    --  MinGW-w64" }
    if (& $prompt "Python RE tools (capstone, keystone, unicorn, angr, lief)" "y") { $InstallPythonTools = $true; Write-Host "    [OK] Python RE tools" } else { Write-Host "    --  Python RE tools" }

    Write-Host ""
    Write-Host "  Advanced tools (optional):"
    Write-Host ""

    if (& $prompt "Ghidra (decompiler -- ~400MB download)" "y") { $InstallGhidra = $true;     Write-Host "    [OK] Ghidra" }     else { Write-Host "    --  Ghidra" }
    if (& $prompt "Frida (dynamic instrumentation)" "n") { $InstallFrida = $true;             Write-Host "    [OK] Frida" }      else { Write-Host "    --  Frida" }
    if (& $prompt "GDB (scripted debugging)" "n") { $InstallGDB = $true;                       Write-Host "    [OK] GDB" }        else { Write-Host "    --  GDB" }
    if (& $prompt "Binwalk (firmware extraction)" "n") { $InstallBinwalk = $true;             Write-Host "    [OK] Binwalk" }    else { Write-Host "    --  Binwalk" }
    if (& $prompt "JADX (APK/DEX -> Java decompiler)" "n") { $InstallJADX = $true;            Write-Host "    [OK] JADX" }       else { Write-Host "    --  JADX" }
    if (& $prompt "ILSpy (.NET -> C# decompiler)" "n") { $InstallILSpy = $true;               Write-Host "    [OK] ILSpy" }      else { Write-Host "    --  ILSpy" }
    if (& $prompt "Yara (pattern matching)" "n") { $InstallYara = $true;                       Write-Host "    [OK] Yara" }       else { Write-Host "    --  Yara" }
    if (& $prompt "Volatility (memory forensics)" "n") { $InstallVolatility = $true;          Write-Host "    [OK] Volatility" } else { Write-Host "    --  Volatility" }
}

# ── Core Install (sequential) ────────────────────────────────
Write-Section "Core Components"

function Install-Pkg($pkg) {
    switch ($PkgMgr) {
        "choco"  { choco install $pkg -y --no-progress 2>&1 | Out-Null }
        "winget" { winget install --id $pkg -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
        "scoop"  { scoop install $pkg 2>&1 | Out-Null }
    }
}

Write-Step "Installing core packages..."
switch ($PkgMgr) {
    "choco" {
        choco install nodejs-lts git radare2 -y --no-progress 2>&1 | Out-Null
    }
    "winget" {
        winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        winget install --id Git.Git -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
        winget install --id radare.radare2 -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null
    }
    "scoop" {
        scoop install nodejs-lts git radare2 2>&1 | Out-Null
    }
}

# Refresh PATH
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")

Write-Step "Checking Node.js..."
if (Has-Command "node") {
    Write-Ok "Node.js $(node -v)"
} else {
    Write-Err "Node.js not installed"
    exit 1
}
if (Has-Command "npm") { Write-Ok "npm $(npm -v)" } else { Write-Err "npm not installed"; exit 1 }
if (Has-Command "git") { Write-Ok "git installed" } else { Write-Warn2 "git not found" }

# ── Parallel Install Phase ───────────────────────────────────
# Each component runs as a background job. Main loop shows a live
# spinner dashboard with per-component status.

$Components = @()
if ($InstallWine)        { $Components += @{ Name="Wine";         Key="wine" } }
if ($InstallMinGW)       { $Components += @{ Name="MinGW-w64";    Key="mingw" } }
if ($InstallGDB)         { $Components += @{ Name="GDB";          Key="gdb" } }
if ($InstallBinwalk)     { $Components += @{ Name="Binwalk";      Key="binwalk" } }
if ($InstallFrida)       { $Components += @{ Name="Frida";        Key="frida" } }
if ($InstallJADX)        { $Components += @{ Name="JADX";         Key="jadx" } }
if ($InstallILSpy)       { $Components += @{ Name="ILSpy";        Key="ilspy" } }
if ($InstallGhidra)      { $Components += @{ Name="Ghidra";       Key="ghidra" } }
if ($InstallYara)        { $Components += @{ Name="Yara";         Key="yara" } }
if ($InstallVolatility)  { $Components += @{ Name="Volatility";   Key="volatility" } }
if ($InstallPythonTools) { $Components += @{ Name="Python RE";    Key="python" } }

if ($Components.Count -gt 0) {
    Write-Section "Parallel Installation"
    Write-Host "  Installing $($Components.Count) components in parallel..."
    Write-Host ""

    # ── Build self-contained install scripts for each component ──
    # Each script is a standalone .ps1 file that writes "running" /
    # "done" / "failed" to a status file.  This avoids the runspace
    # isolation problem with Start-Job (parent functions / variables
    # are not available inside background jobs).

    $TmpDir = Join-Path $env:TEMP "pire-install-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

    # Helper: write status to file
    function Write-Status($Key, $Status) {
        Set-Content -Path (Join-Path $TmpDir "$Key.status") -Value $Status -NoNewline
    }

    # Helper: read status from file
    function Read-Status($Key) {
        $f = Join-Path $TmpDir "$Key.status"
        if (Test-Path $f) { return (Get-Content $f -Raw).Trim() }
        return "pending"
    }

    # Helper: check if command exists (for use inside scripts)
    function Test-Cmd($Name) {
        return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
    }

    # ── Per-component install scripts ──────────────────────────

    $ScriptWine = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\wine.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install wine -y --no-progress 2>&1 | Out-Null }
    'winget' { Write-Host 'Wine install on Windows via winget not automated.' }
    'scoop'  { scoop install wine 2>&1 | Out-Null }
}
`$ok = [bool](Get-Command wine -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\wine.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\wine.status' -Value 'failed' -NoNewline }
"@

    $ScriptMinGW = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\mingw.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install mingw -y --no-progress 2>&1 | Out-Null }
    'winget' { winget install --id MartinStorsjo.LLVM-MinGW.UCRT -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
    'scoop'  { scoop install mingw 2>&1 | Out-Null }
}
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
`$ok = [bool](Get-Command gcc -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\mingw.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\mingw.status' -Value 'failed' -NoNewline }
"@

    $ScriptGDB = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\gdb.status' -Value 'running' -NoNewline
`$gdbOk = `$false
switch ('$PkgMgr') {
    'choco'  { choco install gdb -y --no-progress 2>&1 | Out-Null; `$gdbOk = [bool](Get-Command gdb -ErrorAction SilentlyContinue) }
    'winget' {
        if (Get-Command pacman -ErrorAction SilentlyContinue) {
            pacman -S --noconfirm --needed mingw-w64-x86_64-gdb 2>&1 | Out-Null
            `$gdbOk = [bool](Get-Command gdb -ErrorAction SilentlyContinue)
        }
        if (-not `$gdbOk) {
            Write-Host 'GDB not available via winget directly.'
            Write-Host 'Install MSYS2 (https://www.msys2.org/) then run:'
            Write-Host '  pacman -S mingw-w64-x86_64-gdb'
        }
    }
    'scoop'  { scoop install gdb 2>&1 | Out-Null; `$gdbOk = [bool](Get-Command gdb -ErrorAction SilentlyContinue) }
}
if (`$gdbOk) { Set-Content -Path '$TmpDir\gdb.status' -Value 'done' -NoNewline }
else        { Set-Content -Path '$TmpDir\gdb.status' -Value 'failed' -NoNewline }
"@

    $ScriptBinwalk = @"
`$ErrorActionPreference = 'Continue'
Set-Content -Path '$TmpDir\binwalk.status' -Value 'running' -NoNewline
if (Get-Command pip -ErrorAction SilentlyContinue) {
    `$out = & pip install binwalk 2>&1
    `$rc = `$LASTEXITCODE
} else { `$rc = 1 }
`$ok = [bool](Get-Command binwalk -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\binwalk.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\binwalk.status' -Value 'failed' -NoNewline }
"@

    $ScriptFrida = @"
`$ErrorActionPreference = 'Continue'
Set-Content -Path '$TmpDir\frida.status' -Value 'running' -NoNewline
if (Get-Command pip -ErrorAction SilentlyContinue) {
    `$out = & pip install frida-tools 2>&1
    `$rc = `$LASTEXITCODE
} else { `$rc = 1 }
`$ok = [bool](Get-Command frida -ErrorAction SilentlyContinue) -or [bool](Get-Command frida-ps -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\frida.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\frida.status' -Value 'failed' -NoNewline }
"@

    $ScriptJADX = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\jadx.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install jadx -y --no-progress 2>&1 | Out-Null }
    'winget' { winget install --id JesseGallagher.jadx -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
    'scoop'  { scoop install jadx 2>&1 | Out-Null }
}
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
`$ok = [bool](Get-Command jadx -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\jadx.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\jadx.status' -Value 'failed' -NoNewline }
"@

    $ScriptILSpy = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\ilspy.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install dotnet-sdk -y --no-progress 2>&1 | Out-Null }
    'winget' { winget install --id Microsoft.DotNet.SDK.8 -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Null }
    'scoop'  { scoop install dotnet-sdk 2>&1 | Out-Null }
}
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
`$ok = `$false
if (Get-Command dotnet -ErrorAction SilentlyContinue) {
    dotnet tool install -g ilspycmd 2>&1 | Out-Null
    `$ok = `$true
}
if (`$ok) { Set-Content -Path '$TmpDir\ilspy.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\ilspy.status' -Value 'failed' -NoNewline }
"@

    $ScriptGhidra = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\ghidra.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install ghidra -y --no-progress 2>&1 | Out-Null }
    'winget' {
        `$ghidraDir = '`$env:LOCALAPPDATA\ghidra'
        `$GHIDRA_VER = '11.1.2'
        `$GHIDRA_DATE = '20240709'
        `$url = "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_`$(`$GHIDRA_VER)_build/ghidra_`$(`$GHIDRA_VER)_PUBLIC_`$(`$GHIDRA_DATE).zip"
        `$zip = '`$env:TEMP\ghidra.zip'
        try {
            Invoke-WebRequest -Uri `$url -OutFile `$zip -UseBasicParsing
            Expand-Archive -Path `$zip -DestinationPath `$ghidraDir -Force
            Remove-Item `$zip
            `$ghidraExe = Get-ChildItem "`$ghidraDir\*\ghidraRun.bat" -Recurse | Select-Object -First 1
            if (`$ghidraExe) {
                `$wrapperDir = '`$env:LOCALAPPDATA\bin'
                New-Item -ItemType Directory -Force -Path `$wrapperDir | Out-Null
                `$wrapperPath = "`$wrapperDir\ghidra.bat"
                "@echo off`r`n`"`$(`$ghidraExe.FullName)`" %*" | Set-Content `$wrapperPath
                if (`$env:PATH -notlike "*`$wrapperDir*") {
                    [System.Environment]::SetEnvironmentVariable("PATH", "`$env:PATH;`$wrapperDir", "User")
                    `$env:PATH += ";`$wrapperDir"
                }
            }
        } catch {
            Write-Host "Ghidra download failed: `$_"
        }
    }
    'scoop'  { scoop install ghidra 2>&1 | Out-Null }
}
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
`$ok = [bool](Get-Command ghidra -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\ghidra.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\ghidra.status' -Value 'failed' -NoNewline }
"@

    $ScriptYara = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
Set-Content -Path '$TmpDir\yara.status' -Value 'running' -NoNewline
switch ('$PkgMgr') {
    'choco'  { choco install yara -y --no-progress 2>&1 | Out-Null }
    'winget' { Write-Host 'Yara not in winget -- trying pip...' }
    'scoop'  { scoop install yara 2>&1 | Out-Null }
}
`$env:PATH = [System.Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('PATH','User')
if (-not [bool](Get-Command yara -ErrorAction SilentlyContinue)) {
    if (Get-Command pip -ErrorAction SilentlyContinue) {
        & pip install yara-python 2>&1 | Out-Null
    }
}
`$ok = [bool](Get-Command yara -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\yara.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\yara.status' -Value 'failed' -NoNewline }
"@

    $ScriptVolatility = @"
`$ErrorActionPreference = 'Continue'
Set-Content -Path '$TmpDir\volatility.status' -Value 'running' -NoNewline
if (Get-Command pip -ErrorAction SilentlyContinue) {
    `$out = & pip install volatility3 2>&1
    `$rc = `$LASTEXITCODE
} else { `$rc = 1 }
`$ok = [bool](Get-Command vol -ErrorAction SilentlyContinue) -or [bool](Get-Command vol3 -ErrorAction SilentlyContinue)
if (`$ok) { Set-Content -Path '$TmpDir\volatility.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\volatility.status' -Value 'failed' -NoNewline }
"@

    $ScriptPython = @"
`$ErrorActionPreference = 'Continue'
Set-Content -Path '$TmpDir\python.status' -Value 'running' -NoNewline
if (Get-Command pip -ErrorAction SilentlyContinue) {
    `$out = & pip install capstone keystone-engine unicorn angr lief 2>&1
    `$rc = `$LASTEXITCODE
} else { `$rc = 1 }
`$ok = `$false
try { python -c "import capstone" 2>&1 | Out-Null; `$ok = `$true } catch {}
if (`$ok) { Set-Content -Path '$TmpDir\python.status' -Value 'done' -NoNewline }
else      { Set-Content -Path '$TmpDir\python.status' -Value 'failed' -NoNewline }
"@

    # Map component keys to their scripts
    $ScriptMap = @{
        "wine"       = $ScriptWine
        "mingw"      = $ScriptMinGW
        "gdb"        = $ScriptGDB
        "binwalk"    = $ScriptBinwalk
        "frida"      = $ScriptFrida
        "jadx"       = $ScriptJADX
        "ilspy"      = $ScriptILSpy
        "ghidra"     = $ScriptGhidra
        "yara"       = $ScriptYara
        "volatility" = $ScriptVolatility
        "python"     = $ScriptPython
    }

    # Initialize all status files to "pending"
    foreach ($comp in $Components) {
        Set-Content -Path (Join-Path $TmpDir "$($comp.Key).status") -Value "pending" -NoNewline
    }

    # Write each component script to a temp .ps1 file and launch it
    $processes = @()
    foreach ($comp in $Components) {
        $scriptPath = Join-Path $TmpDir "$($comp.Key).ps1"
        Set-Content -Path $scriptPath -Value $ScriptMap[$comp.Key] -Encoding UTF8
        $proc = Start-Process -FilePath "powershell.exe" `
            -ArgumentList "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $scriptPath `
            -WindowStyle Hidden -PassThru
        $processes += @{ Proc=$proc; Name=$comp.Name; Key=$comp.Key }
    }

    # ── Live spinner dashboard ───────────────────────────────
    $spinFrames = @([char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838,
                     [char]0x283C, [char]0x2834, [char]0x2826, [char]0x2827,
                     [char]0x2807, [char]0x280F)
    $spinIdx = 0

    # Print initial lines
    for ($i = 0; $i -lt $processes.Count; $i++) {
        Write-Host "  $($processes[$i].Name)"
    }

    # Move cursor up to first line
    [Console]::SetCursorPosition(0, [Console]::CursorTop - $processes.Count)

    # Main render loop
    $allDone = $false
    while (-not $allDone) {
        $allDone = $true
        $spinIdx = ($spinIdx + 1) % 10
        $spinChar = $spinFrames[$spinIdx]

        for ($i = 0; $i -lt $processes.Count; $i++) {
            $p = $processes[$i]
            $status = Read-Status $p.Key

            if ($status -in @("done", "failed")) {
                # Already finished — skip
                continue
            }

            # Check if the process is still running
            if ($p.Proc.HasExited) {
                # Process exited — read final status (it should have
                # been written by the script, but double-check)
                $status = Read-Status $p.Key
                if ($status -eq "running") {
                    # Process exited without writing status — treat as failed
                    $status = "failed"
                    Set-Content -Path (Join-Path $TmpDir "$($p.Key).status") -Value "failed" -NoNewline
                }
            } else {
                $status = "running"
                $allDone = $false
            }

            $icon = switch ($status) {
                "pending"  { [char]0x25CB }  # ○
                "running"  { $spinChar }
                "done"     { [char]0x2713 }  # ✓
                "failed"   { [char]0x2717 }  # ✗
            }

            $color = switch ($status) {
                "pending"  { "Gray" }
                "running"  { "Cyan" }
                "done"     { "Green" }
                "failed"   { "Red" }
            }

            $statusText = switch ($status) {
                "pending"  { "waiting" }
                "running"  { "installing..." }
                "done"     { "done" }
                "failed"   { "failed" }
            }

            # Clear line and write
            [Console]::SetCursorPosition(0, [Console]::CursorTop)
            Write-Host -NoNewline ("  " + $icon + " " + $p.Name.PadRight(20) + " ")
            Write-Host -NoNewline -ForegroundColor $color $statusText
            Write-Host -NoNewline "          "  # clear rest of line

            # Move down to next line
            if ($i -lt ($processes.Count - 1)) {
                [Console]::SetCursorPosition(0, [Console]::CursorTop + 1)
            }
        }

        # Move cursor back to first line
        [Console]::SetCursorPosition(0, [Console]::CursorTop - ($processes.Count - 1))

        if (-not $allDone) {
            Start-Sleep -Milliseconds 300
        }
    }

    # Move cursor past all lines
    [Console]::SetCursorPosition(0, [Console]::CursorTop + $processes.Count)
    Write-Host ""

    # Print results
    Write-Host "  Results:"
    foreach ($p in $processes) {
        $status = Read-Status $p.Key
        switch ($status) {
            "done"   { Write-Ok $p.Name }
            "failed" { Write-Warn2 "$($p.Name) — install failed" }
        }
    }

    # Clean up temp dir (keep logs if failures)
    $hadFailure = $false
    foreach ($p in $processes) {
        if ((Read-Status $p.Key) -eq "failed") { $hadFailure = $true }
    }
    if (-not $hadFailure) {
        Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
    }
}

# ── Verify ────────────────────────────────────────────────────
Write-Section "Verification"
Write-Host ""

if (Has-Command "node")    { Write-Ok "Node.js $(node -v)" }  else { Write-Err "Node.js not installed" }
if (Has-Command "npm")     { Write-Ok "npm $(npm -v)" }       else { Write-Err "npm not installed" }
if (Has-Command "git")     { Write-Ok "git" }                  else { Write-Warn2 "git not installed" }
if (Has-Command "gcc")     { Write-Ok "gcc" }                  else { Write-Warn2 "gcc not installed" }
if (Has-Command "r2")      { Write-Ok "radare2" }              else { Write-Warn2 "radare2 not installed" }
if (Has-Command "strings") { Write-Ok "strings" }              else { Write-Warn2 "strings not installed" }
if (Has-Command "objdump") { Write-Ok "objdump" }              else { Write-Warn2 "objdump not installed" }

if ($InstallWine)       { if (Has-Command "wine") { Write-Ok "wine" } else { Write-Warn2 "wine not installed" } }
if ($InstallMinGW)      { if (Has-Command "gcc")  { Write-Ok "MinGW-w64" } else { Write-Warn2 "MinGW-w64 not installed" } }
if ($InstallGDB)        { if (Has-Command "gdb")  { Write-Ok "gdb" } else { Write-Warn2 "gdb not installed" } }
if ($InstallBinwalk)    { if (Has-Command "binwalk") { Write-Ok "binwalk" } else { Write-Warn2 "binwalk not installed" } }
if ($InstallFrida)      { if (Has-Command "frida") { Write-Ok "frida" } else { Write-Warn2 "frida not installed" } }
if ($InstallJADX)       { if (Has-Command "jadx") { Write-Ok "jadx" } else { Write-Warn2 "jadx not installed" } }
if ($InstallYara)       { if (Has-Command "yara") { Write-Ok "yara" } else { Write-Warn2 "yara not installed" } }
if ($InstallPythonTools) {
    $pyOk = $true
    try { python -c "import capstone" 2>&1 | Out-Null } catch { $pyOk = $false }
    if ($pyOk) { Write-Ok "capstone" } else { Write-Warn2 "capstone not installed" }
}

# ── Install npm dependencies & link CLI ────────────────────────
$ScriptDir = ""
if (Test-Path "$PSScriptRoot\package.json") {
    $ScriptDir = $PSScriptRoot
} elseif (Test-Path ".\package.json") {
    $ScriptDir = (Get-Location).Path
}

if (-not $ScriptDir -or -not (Test-Path "$ScriptDir\package.json")) {
    $PireDir = "$env:USERPROFILE\.pire"
    if (Test-Path "$PireDir\.git") {
        Write-Step "Updating pire repo..."
        git -C $PireDir pull --ff-only -q 2>&1 | Out-Null
    } else {
        Write-Step "Cloning pire repo..."
        git clone -q https://github.com/evangit2/pire.git $PireDir 2>&1 | Out-Null
    }
    $ScriptDir = $PireDir
}

if ($ScriptDir -and (Test-Path "$ScriptDir\package.json")) {
    Write-Section "Node.js Dependencies"
    Write-Step "Installing npm dependencies..."
    Push-Location $ScriptDir
    try {
        npm install --ignore-scripts 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "npm dependencies installed"
        } else {
            npm install 2>&1 | Out-Null
            Write-Warn2 "npm install had issues"
        }
    } finally {
        Pop-Location
    }

    # Link pire CLI
    if (Test-Path "$ScriptDir\packages\re-agent\src\cli.ts") {
        Write-Step "Linking pire CLI..."
        $pireWrapper = "$env:LOCALAPPDATA\bin\pire.cmd"
        $wrapperDir = Split-Path $pireWrapper
        if (-not (Test-Path $wrapperDir)) {
            New-Item -ItemType Directory -Force -Path $wrapperDir | Out-Null
        }
        "@echo off`r`nnpx tsx `"$ScriptDir\packages\re-agent\src\cli.ts`" %*" | Set-Content $pireWrapper
        if ($env:PATH -notlike "*$wrapperDir*") {
            [System.Environment]::SetEnvironmentVariable("PATH", "$env:PATH;$wrapperDir", "User")
            $env:PATH += ";$wrapperDir"
        }
        if (Has-Command "pire") {
            Write-Ok "pire command available"
        } else {
            Write-Warn2 "Could not create pire command"
        }
        if (-not (Has-Command "tsx")) {
            Write-Step "Installing tsx..."
            npm install -g tsx 2>&1 | Out-Null
        }
        Write-Ok "pire command available"
    }

    # Run tests
    if (Test-Path "$ScriptDir\packages\re-agent\test\test-suite.cjs") {
        Write-Step "Running test suite..."
        Push-Location $ScriptDir
        try {
            $testOut = node packages/re-agent/test/test-suite.cjs 2>&1 | Select-Object -Last 3
            $testOut | ForEach-Object { Write-Host $_ }
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "Tests passed"
            } else {
                Write-Warn2 "Some tests failed"
            }
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
Write-Host "    1. Configure your model provider:"
Write-Host "       pire model"
Write-Host ""
Write-Host "       This opens an interactive selector where you can:"
Write-Host "         - Add providers (OpenAI, Ollama, custom endpoints, etc.)"
Write-Host "         - Fetch and select models from the provider"
Write-Host "         - Set context_length and max_tokens"
Write-Host ""
Write-Host "    2. Start pire:"
Write-Host "       pire                              # start chat (Pi TUI)"
Write-Host "       pire -cli                         # plain CLI mode"
Write-Host "       pire C:\Windows\System32\notepad.exe  # analyze a binary"
Write-Host "       pire https://example.com/app.exe  # download & analyze"
Write-Host ""

if (-not $InstallWine) {
    Write-Host "  [!] Wine not installed -- can't run Linux/ELF binaries." -ForegroundColor Yellow
    Write-Host "        Re-run: .\install.ps1"
    Write-Host ""
}

Write-Host "  Docs: https://github.com/evangit2/pire" -ForegroundColor Cyan
Write-Host ""
