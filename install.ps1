# pire install script for Windows (PowerShell)
#
# One-line install:
#   irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex
#
# Or clone and run:
#   git clone https://github.com/evangit2/pire.git; cd pire; .\install.ps1
#
# Flags:
#   -All          Install everything (no prompts)
#   -CoreOnly     Install only core components (no prompts)
#   -NoWine       Skip wine (not needed on Windows anyway)
#   -Help         Show help

param(
	[switch]$All,
	[switch]$CoreOnly,
	[switch]$NoWine,
	[switch]$Help,
	[switch]$Yes
)

$ErrorActionPreference = "Stop"

# ─── Helpers ──────────────────────────────────────────────────

function Info($msg)  { Write-Host "==> $msg" -ForegroundColor Blue }
function Ok($msg)    { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail($msg)  { Write-Host "  ✗ $msg" -ForegroundColor Red; exit 1 }

function Has($cmd) {
	$null = Get-Command $cmd -ErrorAction SilentlyContinue
	return $?
}

function Prompt-YesNo($question, $default) {
	if ($Yes -or $All) { return $default -eq "y" }
	if ($CoreOnly) { return $false }
	$prompt = if ($default -eq "y") { "$question [Y/n] " } else { "$question [y/N] " }
	$reply = Read-Host $prompt
	if ($reply -match "^[yY]") { return $true }
	if ($reply -match "^[nN]") { return $false }
	return $default -eq "y"
}

if ($Help) {
	Write-Host "pire install — Windows installer (PowerShell)"
	Write-Host ""
	Write-Host "Usage: .\install.ps1 [options]"
	Write-Host ""
	Write-Host "Options:"
	Write-Host "  -All         Install everything (no prompts)"
	Write-Host "  -CoreOnly    Install only core components (no prompts)"
	Write-Host "  -Yes         Non-interactive (accept all defaults)"
	Write-Host "  -Help        Show this help"
	Write-Host ""
	Write-Host "One-liner:"
	Write-Host "  irm https://raw.githubusercontent.com/evangit2/pire/main/install.ps1 | iex"
	exit 0
}

# ─── Detect Platform ──────────────────────────────────────────

Info "Detected: Windows (PowerShell)"

# Check for winget (Windows Package Manager) or Chocolatey
$HasWinget = Has "winget"
$HasChoco = Has "choco"

if (-not $HasWinget -and -not $HasChoco) {
	Info "Installing Chocolatey..."
	Set-ExecutionPolicy Bypass -Scope Process -Force
	[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
	Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
	$HasChoco = $true
	# Refresh PATH
	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

function Pkg-Install($packages) {
	foreach ($pkg in $packages) {
		if ($HasWinget) {
			winget install $pkg --accept-source-agreements --accept-package-agreements --silent 2>$null | Out-Null
		} elseif ($HasChoco) {
			choco install $pkg -y 2>$null | Out-Null
		}
	}
}

# ─── Component Selection ──────────────────────────────────────

$InstallGhidra = $false
$InstallFrida = $false
$InstallGdb = $false
$InstallBinwalk = $false
$InstallJadx = $false
$InstallIlspy = $false
$InstallYara = $false
$InstallVolatility = $false
$InstallPythonTools = $false

if ($All) {
	Info "Installing ALL components (-All)"
	$InstallGhidra = $true
	$InstallFrida = $true
	$InstallGdb = $true
	$InstallBinwalk = $true
	$InstallJadx = $true
	$InstallIlspy = $true
	$InstallYara = $true
	$InstallVolatility = $true
	$InstallPythonTools = $true
} elseif (-not $CoreOnly) {
	Write-Host ""
	Info "Component Selection"
	Write-Host "  Core (Node.js, npm, git, radare2, binutils) — always installed"
	Write-Host ""

	if (Prompt-YesNo "Install Ghidra? (decompiler — large download)" "n") { $InstallGhidra = $true }
	if (Prompt-YesNo "Install Frida? (dynamic instrumentation)" "n") { $InstallFrida = $true }
	if (Prompt-YesNo "Install GDB? (scripted debugging)" "n") { $InstallGdb = $true }
	if (Prompt-YesNo "Install Binwalk? (firmware extraction)" "n") { $InstallBinwalk = $true }
	if (Prompt-YesNo "Install JADX? (APK/DEX -> Java decompiler)" "n") { $InstallJadx = $true }
	if (Prompt-YesNo "Install ILSpy? (.NET -> C# decompiler)" "n") { $InstallIlspy = $true }
	if (Prompt-YesNo "Install Yara? (pattern matching)" "n") { $InstallYara = $true }
	if (Prompt-YesNo "Install Volatility? (memory forensics)" "n") { $InstallVolatility = $true }
	if (Prompt-YesNo "Install Python RE tools? (capstone, keystone, unicorn, angr, lief)" "y") { $InstallPythonTools = $true }
	Write-Host ""
}

# ─── Install Core ─────────────────────────────────────────────

Info "Installing core components..."

$CorePkgs = @()
if (-not (Has "node")) { $CorePkgs += "OpenJS.NodeJS.LTS" }
if (-not (Has "git")) { $CorePkgs += "Git.Git" }
if ($CorePkgs.Count -gt 0) {
	Info "Installing: $($CorePkgs -join ', ')"
	Pkg-Install $CorePkgs
	# Refresh PATH
	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# radare2 — via winget or manual
if (-not (Has "r2") -and -not (Has "radare2")) {
	Info "Installing radare2..."
	if ($HasWinget) {
		winget install radare.radare2 --accept-source-agreements --accept-package-agreements 2>$null | Out-Null
	} elseif ($HasChoco) {
		choco install radare2 -y 2>$null | Out-Null
	}
	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
}

# ─── Install Python (if needed for tools) ─────────────────────

if ($InstallPythonTools -or $InstallFrida -or $InstallVolatility -or $InstallBinwalk) {
	if (-not (Has "python")) {
		Info "Installing Python..."
		Pkg-Install @("Python.Python.3.12")
		$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
	}
}

# ─── Install Optional Components ──────────────────────────────

if ($InstallGdb) {
	Info "Installing GDB..."
	if ($HasWinget) { winget install GDB --accept-package-agreements 2>$null | Out-Null }
	elseif ($HasChoco) { choco install mingw -y 2>$null | Out-Null }
}

if ($InstallJadx) {
	Info "Installing JADX..."
	if (-not (Has "java")) { Pkg-Install @("EclipseAdoptium.Temurin.21.JRE") }
	if ($HasChoco) { choco install jadx -y 2>$null | Out-Null }
}

if ($InstallIlspy) {
	Info "Installing ILSpy..."
	if ($HasWinget) { winget install ILSpy.ILSpy --accept-package-agreements 2>$null | Out-Null }
}

if ($InstallYara) {
	Info "Installing Yara..."
	if (Has "pip") { pip install yara-python 2>$null | Out-Null }
}

if ($InstallVolatility) {
	Info "Installing Volatility 3..."
	if (Has "pip") { pip install volatility3 2>$null | Out-Null }
}

if ($InstallFrida) {
	Info "Installing Frida..."
	if (Has "pip") { pip install frida-tools 2>$null | Out-Null }
}

if ($InstallGhidra) {
	Info "Installing Ghidra..."
	if (-not (Has "java")) { Pkg-Install @("EclipseAdoptium.Temurin.21.JDK") }
	$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
	if ($HasChoco) {
		choco install ghidra -y 2>$null | Out-Null
	} else {
		Warn "Ghidra requires manual install on Windows without Chocolatey — see https://ghidra-sre.org/"
	}
}

if ($InstallPythonTools) {
	Info "Installing Python RE tools..."
	if (Has "pip") {
		pip install capstone keystone-engine unicorn angr lief 2>$null | Out-Null
	}
}

# ─── Verify ───────────────────────────────────────────────────

Info "Verifying installations..."
Write-Host ""

if (Has "node")    { Ok "Node.js $(node -v)" } else { Fail "Node.js not installed" }
if (Has "npm")     { Ok "npm $(npm -v)" } else { Fail "npm not installed" }
if (Has "git")     { Ok "git" } else { Warn "git not installed" }
if (Has "r2")      { Ok "radare2" } elseif (Has "radare2") { Ok "radare2" } else { Warn "radare2 not installed" }

if ($InstallGdb)      { if (Has "gdb") { Ok "gdb" } else { Warn "gdb not installed" } }
if ($InstallJadx)     { if (Has "jadx") { Ok "jadx" } else { Warn "jadx not installed" } }
if ($InstallIlspy)    { if (Has "ilspycmd") { Ok "ilspy" } else { Warn "ilspy not installed" } }
if ($InstallYara)     { if (Has "yara") { Ok "yara" } else { Warn "yara not installed" } }
if ($InstallFrida)    { if ((Has "frida") -or (Has "frida-ps")) { Ok "frida" } else { Warn "frida not installed" } }
if ($InstallPythonTools) {
	if (Has "python") {
		$capstone = python -c "import capstone" 2>$null
		if ($LASTEXITCODE -eq 0) { Ok "capstone" } else { Warn "capstone not installed" }
	}
}

# ─── Install npm dependencies ─────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $ScriptDir) { $ScriptDir = Get-Location }

if (Test-Path "$ScriptDir\package.json") {
	Info "Installing npm dependencies..."
	Push-Location $ScriptDir
	npm install --ignore-scripts 2>$null
	if ($LASTEXITCODE -ne 0) { npm install 2>$null }
	Ok "npm dependencies installed"

	# Link pire CLI
	if ((Test-Path "$ScriptDir\packages\re-agent\src\cli.ts") -and -not (Has "pire")) {
		Info "To make 'pire' available globally, run:"
		Write-Host "  npm install -g tsx"
		Write-Host "  Set-Content -Path `$env:LOCALAPPDATA\Microsoft\WindowsApps\pire.cmd -Value '@tsx $ScriptDir\packages\re-agent\src\cli.ts %*'"
	}

	# Run tests
	if (Test-Path "$ScriptDir\packages\re-agent\test\test-suite.cjs") {
		Info "Running test suite..."
		node packages\re-agent\test\test-suite.cjs 2>&1 | Select-Object -Last 3
		if ($LASTEXITCODE -eq 0) { Ok "Tests passed" } else { Warn "Some tests failed" }
	}

	Pop-Location
}

# ─── Done ─────────────────────────────────────────────────────

Write-Host ""
Info "Installation complete!"
Write-Host ""
Write-Host "  What you can do now:"
Write-Host ""
Write-Host "  1. Set your LLM API credentials:"
Write-Host '     $env:OPENAI_API_KEY = "your-key"'
Write-Host '     $env:OPENAI_BASE_URL = "https://api.openai.com/v1"'
Write-Host '     $env:OPENAI_MODEL = "gpt-4o"'
Write-Host ""
Write-Host "  2. Start pire:"
Write-Host "     pire                          # start chat"
Write-Host "     pire C:\Windows\System32\cmd.exe  # analyze a binary"
Write-Host "     pire https://example.com/app.exe  # download & analyze"
Write-Host ""
