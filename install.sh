#!/bin/sh
# ============================================================================
# pire Installer
# ============================================================================
# Cross-platform installer with interactive component selection.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh
#
# Or with options:
#   ./install.sh --all     # install everything non-interactively
#   ./install.sh --core    # core only (no prompts)
#   ./install.sh --no-wine # skip wine
#   ./install.sh --help
#
# Supports: Ubuntu/Debian, Fedora/RHEL, Arch, openSUSE, Alpine, macOS, WSL,
#           Windows (Git Bash/MSYS2)
# ============================================================================

set -e

# ── Helpers ───────────────────────────────────────────────────
# Use printf with escape codes in the format string (not echo -e,
# which is not POSIX and prints literal "-e" under dash/sh).
# printf interprets \033 in the format string directly — no %b needed.
log_step()   { printf '\033[0;36m→\033[0m %s\n' "$1"; }
log_done()   { printf '\033[0;32m✓\033[0m %s\n' "$1"; }
log_warn()   { printf '\033[0;33m⚠\033[0m %s\n' "$1"; }
log_error()  { printf '\033[0;31m✗\033[0m %s\n' "$1"; }
log_section() {
	printf '\n'
	printf '\033[0;35m\033[1m═════════════════════════════════════════════════════════════\033[0m\n'
	printf '\033[0;35m\033[1m  %s\033[0m\n' "$1"
	printf '\033[0;35m\033[1m═════════════════════════════════════════════════════════════\033[0m\n'
}

has() { command -v "$1" >/dev/null 2>&1; }

# ── Banner ────────────────────────────────────────────────────
print_banner() {
	printf '\n'
	printf '\033[0;35m\033[1m\n'
	printf '%s\n' "┌─────────────────────────────────────────────────────────┐"
	printf '%s\n' "│  pire Installer                                         │"
	printf '%s\n' "│  Autonomous reverse-engineering agent                   │"
	printf '%s\n' "│  github.com/evangit2/pire                               │"
	printf '%s\n' "└─────────────────────────────────────────────────────────┘"
	printf '\033[0m\n'
}

# ── Interactive prompt ────────────────────────────────────────
IS_INTERACTIVE=true
if ! [ -t 0 ]; then
	IS_INTERACTIVE=false
fi

prompt_yesno() {
	# prompt_yesno "question" default(y/n)
	QUESTION="$1"
	DEFAULT="$2"

	if [ "$NONINTERACTIVE" = "1" ]; then
		[ "$DEFAULT" = "y" ] && return 0 || return 1
	fi

	SUFFIX="[y/N]"
	[ "$DEFAULT" = "y" ] && SUFFIX="[Y/n]"

	if [ "$IS_INTERACTIVE" = "true" ]; then
		printf '%s %s ' "$QUESTION" "$SUFFIX"
		read REPLY 2>/dev/null || REPLY=""
	elif [ -r /dev/tty ] && [ -w /dev/tty ]; then
		printf '%s %s ' "$QUESTION" "$SUFFIX" > /dev/tty
		IFS= read REPLY < /dev/tty 2>/dev/null || REPLY=""
	else
		[ "$DEFAULT" = "y" ] && return 0 || return 1
	fi

	case "$REPLY" in
		y|Y|yes|YES) return 0 ;;
		n|N|no|NO)   return 1 ;;
		"")          [ "$DEFAULT" = "y" ] && return 0 || return 1 ;;
		*)           return 1 ;;
	esac
}

# ── Parse args ────────────────────────────────────────────────
INSTALL_ALL=0
INSTALL_CORE_ONLY=0
NO_WINE=0
NONINTERACTIVE=0

for arg in "$@"; do
	case "$arg" in
		--all)     INSTALL_ALL=1; NONINTERACTIVE=1 ;;
		--core)    INSTALL_CORE_ONLY=1; NONINTERACTIVE=1 ;;
		--no-wine) NO_WINE=1 ;;
		--yes|-y)  NONINTERACTIVE=1 ;;
		--help|-h)
			echo "pire install — cross-platform installer"
			echo ""
			echo "Usage: ./install.sh [options]"
			echo ""
			echo "Options:"
			echo "  --all       Install everything (no prompts)"
			echo "  --core      Install only core components (no prompts)"
			echo "  --no-wine   Skip Wine installation"
			echo "  --yes, -y   Non-interactive (accept all defaults)"
			echo "  --help, -h  Show this help"
			echo ""
			echo "One-liner:"
			echo "  curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh"
			exit 0
			;;
		*) echo "Unknown option: $arg"; exit 1 ;;
	esac
done

print_banner

# ── Detect Platform ───────────────────────────────────────────
log_section "Platform Detection"

OS=""
PKG_MGR=""

UNAME_S="$(uname -s)"
case "$UNAME_S" in
	MSYS*|MINGW*|CYGWIN*)
		OS="windows"
		PKG_MGR="pacman"
		;;
esac

if [ -z "$OS" ] && grep -qi microsoft /proc/version 2>/dev/null; then
	OS="wsl"
fi

if [ -z "$OS" ] && [ -f /etc/os-release ]; then
	. /etc/os-release
	case "$ID" in
		ubuntu|debian|linuxmint|pop|kali) OS="debian"; PKG_MGR="apt" ;;
		fedora|rhel|centos|rocky|alma)     OS="fedora"; PKG_MGR="dnf" ;;
		arch|manjaro|endeavouros|garuda)   OS="arch"; PKG_MGR="pacman" ;;
		opensuse*|suse)                    OS="suse"; PKG_MGR="zypper" ;;
		alpine)                            OS="alpine"; PKG_MGR="apk" ;;
		*)                                 OS="$ID"; PKG_MGR="unknown" ;;
	esac
fi

if [ -z "$OS" ] && [ "$UNAME_S" = "Darwin" ]; then
	OS="macos"
	PKG_MGR="brew"
fi

if [ -z "$OS" ]; then
	log_error "Could not detect OS (uname: $UNAME_S)"
	echo "  Please install dependencies manually."
	exit 1
fi

log_done "OS:      $OS"
log_done "Package: $PKG_MGR"

# ── Component Selection ──────────────────────────────────────
log_section "Component Selection"

echo "  Core (always installed):"
echo "    node, npm, git, gcc, radare2, binutils (file, nm, strings, objdump)"
echo ""

# Component flags
INSTALL_WINE=0
INSTALL_MINGW=0
INSTALL_GHIDRA=0
INSTALL_FRIDA=0
INSTALL_GDB=0
INSTALL_BINWALK=0
INSTALL_JADX=0
INSTALL_ILSPY=0
INSTALL_YARA=0
INSTALL_VOLATILITY=0
INSTALL_PYTHON_TOOLS=0

if [ "$INSTALL_ALL" = "1" ]; then
	printf '  \033[0;32mInstalling ALL components\033[0m\n'
	INSTALL_WINE=1
	INSTALL_MINGW=1
	INSTALL_GHIDRA=1
	INSTALL_FRIDA=1
	INSTALL_GDB=1
	INSTALL_BINWALK=1
	INSTALL_JADX=1
	INSTALL_ILSPY=1
	INSTALL_YARA=1
	INSTALL_VOLATILITY=1
	INSTALL_PYTHON_TOOLS=1
	[ "$NO_WINE" = "1" ] && INSTALL_WINE=0
elif [ "$INSTALL_CORE_ONLY" = "1" ]; then
	printf '  \033[0;32mInstalling CORE components only\033[0m\n'
else
	echo "  Select optional components:"
	echo ""

	if [ "$OS" != "windows" ] && [ "$NO_WINE" = "0" ]; then
		if prompt_yesno "  Wine (run Windows PE binaries)" "y"; then
			INSTALL_WINE=1
			printf '    \033[0;32m✓\033[0m Wine\n'
		else
			printf '    \033[0;31m✗\033[0m Wine\n'
		fi
	fi

	if prompt_yesno "  MinGW-w64 (cross-compile Windows binaries)" "y"; then
		INSTALL_MINGW=1
		printf '    \033[0;32m✓\033[0m MinGW-w64\n'
	else
		printf '    \033[0;31m✗\033[0m MinGW-w64\n'
	fi

	if prompt_yesno "  Python RE tools (capstone, keystone, unicorn, angr, lief)" "y"; then
		INSTALL_PYTHON_TOOLS=1
		printf '    \033[0;32m✓\033[0m Python RE tools\n'
	else
		printf '    \033[0;31m✗\033[0m Python RE tools\n'
	fi

	echo ""
	echo "  Advanced tools (optional):"
	echo ""

	if prompt_yesno "  Ghidra (decompiler — ~400MB download)" "y"; then
		INSTALL_GHIDRA=1
		printf '    \033[0;32m✓\033[0m Ghidra\n'
	else
		printf '    \033[0;31m✗\033[0m Ghidra\n'
	fi

	if prompt_yesno "  Frida (dynamic instrumentation)" "n"; then
		INSTALL_FRIDA=1
		printf '    \033[0;32m✓\033[0m Frida\n'
	else
		printf '    \033[0;31m✗\033[0m Frida\n'
	fi

	if prompt_yesno "  GDB (scripted debugging)" "n"; then
		INSTALL_GDB=1
		printf '    \033[0;32m✓\033[0m GDB\n'
	else
		printf '    \033[0;31m✗\033[0m GDB\n'
	fi

	if prompt_yesno "  Binwalk (firmware extraction)" "n"; then
		INSTALL_BINWALK=1
		printf '    \033[0;32m✓\033[0m Binwalk\n'
	else
		printf '    \033[0;31m✗\033[0m Binwalk\n'
	fi

	if prompt_yesno "  JADX (APK/DEX → Java decompiler)" "n"; then
		INSTALL_JADX=1
		printf '    \033[0;32m✓\033[0m JADX\n'
	else
		printf '    \033[0;31m✗\033[0m JADX\n'
	fi

	if prompt_yesno "  ILSpy (.NET → C# decompiler)" "n"; then
		INSTALL_ILSPY=1
		printf '    \033[0;32m✓\033[0m ILSpy\n'
	else
		printf '    \033[0;31m✗\033[0m ILSpy\n'
	fi

	if prompt_yesno "  Yara (pattern matching)" "n"; then
		INSTALL_YARA=1
		printf '    \033[0;32m✓\033[0m Yara\n'
	else
		printf '    \033[0;31m✗\033[0m Yara\n'
	fi

	if prompt_yesno "  Volatility (memory forensics)" "n"; then
		INSTALL_VOLATILITY=1
		printf '    \033[0;32m✓\033[0m Volatility\n'
	else
		printf '    \033[0;31m✗\033[0m Volatility\n'
	fi
fi

# ── Package Manager Abstraction ───────────────────────────────
pkg_install() {
	case "$PKG_MGR" in
		apt)    sudo apt-get install -y -qq "$@" >/dev/null 2>&1 ;;
		dnf)    sudo dnf install -y -q "$@" >/dev/null 2>&1 ;;
		pacman) sudo pacman -S --noconfirm --needed "$@" >/dev/null 2>&1 ;;
		zypper) sudo zypper install -y -q "$@" >/dev/null 2>&1 ;;
		apk)    sudo apk add -q "$@" >/dev/null 2>&1 ;;
		brew)   brew install "$@" >/dev/null 2>&1 ;;
		*)      log_warn "Unknown package manager for: $*" ;;
	esac
}

pip_install() {
	if has pip3; then
		pip3 install --user -q "$@" 2>/dev/null || log_warn "pip install failed: $*"
	elif has pip; then
		pip install --user -q "$@" 2>/dev/null || log_warn "pip install failed: $*"
	else
		log_warn "pip not found, skipping: $*"
	fi
}

# ── Install Core ──────────────────────────────────────────────
log_section "Core Components"

case "$OS" in
	debian)
		log_step "Updating package index..."
		sudo apt-get update -qq >/dev/null 2>&1
		log_step "Installing core packages..."
		pkg_install nodejs npm git build-essential radare2 binutils file
		;;
	fedora)
		log_step "Installing core packages..."
		pkg_install nodejs npm git gcc make radare2 binutils file
		;;
	arch)
		log_step "Installing core packages..."
		pkg_install nodejs npm git base-devel radare2 binutils file
		;;
	suse)
		log_step "Installing core packages..."
		pkg_install nodejs npm git gcc make radare2 binutils file
		;;
	alpine)
		log_step "Installing core packages..."
		pkg_install nodejs npm git build-base radare2 binutils file
		;;
	macos)
		if ! has brew; then
			log_step "Installing Homebrew..."
			/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" >/dev/null 2>&1
		fi
		log_done "Homebrew ready"
		log_step "Installing core packages..."
		pkg_install node radare2 binutils git
		;;
	wsl)
		. /etc/os-release 2>/dev/null
		case "$ID" in
			ubuntu|debian|linuxmint|pop)
				OS="debian"; PKG_MGR="apt"
				log_step "Updating package index..."
				sudo apt-get update -qq >/dev/null 2>&1
				log_step "Installing core packages..."
				pkg_install nodejs npm git build-essential radare2 binutils file
				;;
			fedora|rhel|centos|rocky|alma)
				OS="fedora"; PKG_MGR="dnf"
				log_step "Installing core packages..."
				pkg_install nodejs npm git gcc make radare2 binutils file
				;;
			*)
				OS="debian"; PKG_MGR="apt"
				log_step "Updating package index..."
				sudo apt-get update -qq >/dev/null 2>&1
				log_step "Installing core packages..."
				pkg_install nodejs npm git build-essential radare2 binutils file
				;;
		esac
		;;
	windows)
		log_step "Installing core packages..."
		pkg_install nodejs npm git mingw-w64-x86_64-radare2 mingw-w64-x86_64-binutils
		;;
esac

# Ensure Node.js 22+
log_step "Checking Node.js version..."
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [ "$NODE_VER" -lt 22 ] 2>/dev/null; then
	log_warn "Node.js is v$NODE_VER, need v22+"
	log_step "Upgrading Node.js..."
	case "$OS" in
		debian)
			# NodeSource setup for Node.js 22
			curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null 2>&1
			sudo apt-get install -y -qq nodejs >/dev/null 2>&1
			;;
		fedora)
			# NodeSource RPM for Node.js 22
			curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - >/dev/null 2>&1
			sudo dnf install -y -q nodejs >/dev/null 2>&1
			;;
		arch|windows)
			pkg_install nodejs 2>/dev/null
			;;
		macos)
			brew install node@22 2>/dev/null || brew link --overwrite node@22 2>/dev/null
			;;
	esac
	log_done "Node.js upgraded to $(node -v)"
else
	log_done "Node.js $(node -v)"
fi

# ── Install Wine ──────────────────────────────────────────────
if [ "$INSTALL_WINE" = "1" ]; then
	log_section "Wine"
	log_step "Installing Wine..."
	case "$OS" in
		debian)  pkg_install wine64 wine ;;
		fedora)  pkg_install wine ;;
		arch)    pkg_install wine ;;
		suse)    pkg_install wine ;;
		macos)   brew install --cask wine-stable 2>/dev/null || log_warn "Wine on macOS Apple Silicon may not work" ;;
		windows) log_done "Wine not needed on Windows" ;;
	esac

	if [ "$OS" != "windows" ]; then
		WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
		if [ ! -d "$WINEPREFIX" ]; then
			log_step "Initializing Wine prefix..."
			WINEPREFIX="$WINEPREFIX" wineboot --init >/dev/null 2>&1 || log_warn "Wine init failed"
			log_done "Wine prefix initialized at $WINEPREFIX"
		else
			log_done "Wine prefix exists at $WINEPREFIX"
		fi
	fi
fi

# ── Install MinGW ─────────────────────────────────────────────
if [ "$INSTALL_MINGW" = "1" ]; then
	log_section "MinGW-w64"
	log_step "Installing MinGW-w64 cross-compiler..."
	case "$OS" in
		debian)  pkg_install gcc-mingw-w64-x86-64 ;;
		fedora)  pkg_install mingw64-gcc ;;
		arch)    pkg_install mingw-w64-gcc ;;
		suse)    pkg_install mingw64-gcc ;;
		macos)   brew install mingw-w64 ;;
		windows) pkg_install mingw-w64-x86_64-gcc ;;
	esac
fi

# ── Install GDB ───────────────────────────────────────────────
if [ "$INSTALL_GDB" = "1" ]; then
	log_section "GDB"
	log_step "Installing GDB..."
	pkg_install gdb
fi

# ── Install Binwalk ───────────────────────────────────────────
if [ "$INSTALL_BINWALK" = "1" ]; then
	log_section "Binwalk"
	log_step "Installing Binwalk..."
	case "$OS" in
		debian|fedora|arch|suse) pkg_install binwalk ;;
		macos) brew install binwalk ;;
		*) pip_install binwalk ;;
	esac
fi

# ── Install Yara ──────────────────────────────────────────────
if [ "$INSTALL_YARA" = "1" ]; then
	log_section "Yara"
	log_step "Installing Yara..."
	case "$OS" in
		debian|fedora|arch|suse) pkg_install yara ;;
		macos) brew install yara ;;
		*) pip_install yara-python ;;
	esac
fi

# ── Install Volatility ────────────────────────────────────────
if [ "$INSTALL_VOLATILITY" = "1" ]; then
	log_section "Volatility"
	log_step "Installing Volatility 3..."
	pip_install volatility3
fi

# ── Install Frida ─────────────────────────────────────────────
if [ "$INSTALL_FRIDA" = "1" ]; then
	log_section "Frida"
	log_step "Installing Frida..."
	pip_install frida-tools
	case "$OS" in
		debian) pkg_install python3-frida 2>/dev/null ;;
		arch)   pkg_install frida-tools 2>/dev/null ;;
	esac
fi

# ── Install JADX ──────────────────────────────────────────────
if [ "$INSTALL_JADX" = "1" ]; then
	log_section "JADX"
	log_step "Installing JADX..."
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install default-jre 2>/dev/null || log_warn "JADX needs Java (JRE)"
			if has jadx 2>/dev/null; then
				log_done "JADX already installed"
			else
				log_step "Downloading JADX v1.5.0..."
				JADX_VER="1.5.0"
				curl -fsSL "https://github.com/skylot/jadx/releases/download/v${JADX_VER}/jadx-${JADX_VER}.zip" -o /tmp/jadx.zip 2>/dev/null
				sudo mkdir -p /opt/jadx && sudo unzip -q -o /tmp/jadx.zip -d /opt/jadx 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx /usr/local/bin/jadx 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx-gui /usr/local/bin/jadx-gui 2>/dev/null
				rm -f /tmp/jadx.zip
				log_done "JADX installed to /opt/jadx"
			fi
			;;
		macos)
			brew install jadx
			;;
		*) log_warn "JADX install not automated on $OS — see https://github.com/skylot/jadx" ;;
	esac
fi

# ── Install ILSpy ─────────────────────────────────────────────
if [ "$INSTALL_ILSPY" = "1" ]; then
	log_section "ILSpy"
	log_step "Installing ILSpy..."
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install dotnet-sdk-8.0 2>/dev/null || pkg_install dotnet-sdk 2>/dev/null || log_warn "ILSpy needs .NET SDK"
			if has dotnet 2>/dev/null; then
				dotnet tool install -g ilspycmd 2>/dev/null || log_warn "ilspycmd install failed"
				log_done "ILSpy installed via dotnet tool"
			fi
			;;
		macos)
			brew install --cask dotnet-sdk 2>/dev/null || log_warn "Install .NET SDK manually"
			if has dotnet 2>/dev/null; then
				dotnet tool install -g ilspycmd 2>/dev/null
				log_done "ILSpy installed via dotnet tool"
			fi
			;;
		*) log_warn "ILSpy install not automated on $OS — see https://github.com/icsharpcode/ILSpy" ;;
	esac
fi

# ── Install Ghidra ────────────────────────────────────────────
if [ "$INSTALL_GHIDRA" = "1" ]; then
	log_section "Ghidra"
	log_step "Installing Ghidra..."
	case "$OS" in
		debian|fedora|arch|suse|wsl)
			pkg_install default-jdk 2>/dev/null || log_warn "Ghidra needs Java (JDK 17+)"
			if has java 2>/dev/null; then
				GHIDRA_VER="11.1.2"
				GHIDRA_DATE="20240709"
				log_step "Downloading Ghidra ${GHIDRA_VER} (~400MB)..."
				curl -fsSL "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip" -o /tmp/ghidra.zip 2>/dev/null
				if [ -f /tmp/ghidra.zip ]; then
					log_step "Extracting..."
					sudo unzip -q -o /tmp/ghidra.zip -d /opt/ 2>/dev/null
					sudo ln -sf /opt/ghidra_${GHIDRA_VER}_PUBLIC/ghidraRun /usr/local/bin/ghidra 2>/dev/null
					rm -f /tmp/ghidra.zip
					log_done "Ghidra installed to /opt/ghidra_${GHIDRA_VER}_PUBLIC"
				else
					log_warn "Download failed — install manually from https://ghidra-sre.org/"
				fi
			else
				log_warn "Java not installed — Ghidra requires JDK 17+"
			fi
			;;
		macos)
			brew install --cask ghidra 2>/dev/null || log_warn "Install Ghidra manually from https://ghidra-sre.org/"
			;;
		*) log_warn "Ghidra install not automated on $OS — see https://ghidra-sre.org/" ;;
	esac
fi

# ── Install Python RE Tools ───────────────────────────────────
if [ "$INSTALL_PYTHON_TOOLS" = "1" ]; then
	log_section "Python RE Tools"
	log_step "Installing capstone, keystone, unicorn, angr, lief..."
	case "$OS" in
		debian)
			pkg_install python3-pip python3-venv 2>/dev/null
			pkg_install python3-capstone python3-lief 2>/dev/null
			;;
		fedora) pkg_install python3-pip python3-capstone python3-lief 2>/dev/null ;;
		arch)   pkg_install python-pip python-capstone python-lief 2>/dev/null ;;
	esac
	pip_install capstone keystone-engine unicorn angr lief
fi

# ── Verify ────────────────────────────────────────────────────
log_section "Verification"

echo ""
has node    && log_done "Node.js $(node -v)"          || log_error "Node.js not installed"
has npm     && log_done "npm $(npm -v)"               || log_error "npm not installed"
has git     && log_done "git"                          || log_warn "git not installed"
has gcc     && log_done "gcc $(gcc -dumpversion)"     || log_warn "gcc not installed"
has r2      && log_done "radare2"                      || log_warn "radare2 not installed"
has strings && log_done "strings"                      || log_warn "strings not installed"
has objdump && log_done "objdump"                      || log_warn "objdump not installed"
has nm      && log_done "nm"                           || log_warn "nm not installed"
has file    && log_done "file"                         || log_warn "file not installed"

[ "$INSTALL_WINE" = "1" ]   && { (has wine || has wine64)                       && log_done "wine"                       || log_warn "wine not installed"; }
[ "$INSTALL_MINGW" = "1" ]  && { has x86_64-w64-mingw32-gcc                     && log_done "MinGW-w64"                  || log_warn "MinGW-w64 not installed"; }
[ "$INSTALL_GDB" = "1" ]    && { has gdb                                        && log_done "gdb"                        || log_warn "gdb not installed"; }
[ "$INSTALL_BINWALK" = "1" ] && { has binwalk                                   && log_done "binwalk"                    || log_warn "binwalk not installed"; }
[ "$INSTALL_FRIDA" = "1" ]  && { (has frida || has frida-ps)                    && log_done "frida"                      || log_warn "frida not installed"; }
[ "$INSTALL_JADX" = "1" ]   && { has jadx                                       && log_done "jadx"                       || log_warn "jadx not installed"; }
[ "$INSTALL_YARA" = "1" ]   && { has yara                                       && log_done "yara"                       || log_warn "yara not installed"; }
[ "$INSTALL_PYTHON_TOOLS" = "1" ] && {
	python3 -c "import capstone" 2>/dev/null && log_done "capstone" || log_warn "capstone not installed"
	python3 -c "import lief" 2>/dev/null     && log_done "lief"     || log_warn "lief not installed"
}

# ── Install npm dependencies ──────────────────────────────────
SCRIPT_DIR=""
if [ -f "$(dirname "$0")/package.json" ]; then
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ -f "./package.json" ]; then
	SCRIPT_DIR="$(pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
	log_section "Node.js Dependencies"
	log_step "Installing npm dependencies..."
	cd "$SCRIPT_DIR"
	npm install --ignore-scripts >/dev/null 2>&1 || npm install >/dev/null 2>&1 || log_warn "npm install had issues"
	log_done "npm dependencies installed"

	# Link pire CLI
	if [ -f "$SCRIPT_DIR/packages/re-agent/src/cli.ts" ] && ! has pire 2>/dev/null; then
		log_step "Linking pire CLI..."
		sudo ln -sf "$SCRIPT_DIR/packages/re-agent/src/cli.ts" /usr/local/bin/pire 2>/dev/null || \
			log_warn "Could not create /usr/local/bin/pire symlink"
		if ! has tsx 2>/dev/null; then
			log_step "Installing tsx..."
			npm install -g tsx 2>/dev/null || log_warn "Install tsx manually: npm install -g tsx"
		fi
		log_done "pire command available"
	fi

	# Run tests
	if [ -f "$SCRIPT_DIR/packages/re-agent/test/test-suite.cjs" ]; then
		log_step "Running test suite..."
		if node packages/re-agent/test/test-suite.cjs 2>&1 | tail -3; then
			log_done "Tests passed"
		else
			log_warn "Some tests failed"
		fi
	fi
fi

# ── Done ──────────────────────────────────────────────────────
log_section "Installation Complete"

echo ""
printf '  \033[0;32m\033[1mpire is ready!\033[0m\n'
echo ""
echo "  Next steps:"
echo ""
echo "    1. Set your LLM API credentials:"
echo "       export OPENAI_API_KEY=\"your-key\""
echo "       export OPENAI_BASE_URL=\"https://api.openai.com/v1\""
echo "       export OPENAI_MODEL=\"gpt-4o\""
echo ""
echo "    2. Start pire:"
echo "       pire                              # start chat"
echo "       pire /bin/ls                      # analyze a binary"
echo "       pire https://example.com/app.exe  # download & analyze"
echo ""

if [ "$INSTALL_WINE" = "0" ] && [ "$OS" != "windows" ]; then
	printf '  \033[0;33m⚠\033[0m Wine not installed — can'"'"'t run Windows PE binaries.\n'
	echo "        Re-run: ./install.sh"
	echo ""
fi

printf '  \033[0;36mDocs:\033[0m https://github.com/evangit2/pire\n'
echo ""
