#!/bin/sh
# pire install script — cross-platform installer with component selection
#
# One-line install:
#   curl -fsSL https://raw.githubusercontent.com/evangit2/pire/main/install.sh | sh
#
# Or clone and run:
#   git clone https://github.com/evangit2/pire.git && cd pire && ./install.sh
#
# Flags:
#   --all     Install everything (no prompts)
#   --core    Install only core components (no prompts)
#   --no-wine Skip wine even if on Linux/macOS
#   --help    Show help
#
# Supports: Ubuntu/Debian, Fedora/RHEL, Arch Linux, macOS (Homebrew), Windows (Git Bash/WSL/MSYS2)

set -e

# ─── Helpers ──────────────────────────────────────────────────

info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m  ✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m  !\033[0m %s\n" "$1"; }
fail()  { printf "\033[1;31m  ✗\033[0m %s\n" "$1"; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

prompt_yesno() {
	# prompt_yesno "question" default(y/n)
	DEFAULT="$2"
	if [ "$NONINTERACTIVE" = "1" ]; then
		if [ "$DEFAULT" = "y" ]; then return 0; else return 1; fi
	fi
	PROMPT="$1"
	if [ "$DEFAULT" = "y" ]; then
		PROMPT="$PROMPT [Y/n] "
	else
		PROMPT="$PROMPT [y/N] "
	fi
	printf "%s" "$PROMPT"
	read REPLY 2>/dev/null || REPLY=""
	case "$REPLY" in
		y|Y|yes|YES) return 0 ;;
		n|N|no|NO) return 1 ;;
		"") [ "$DEFAULT" = "y" ] && return 0 || return 1 ;;
		*) return 1 ;;
	esac
}

# ─── Parse args ───────────────────────────────────────────────

INSTALL_ALL=0
INSTALL_CORE_ONLY=0
NO_WINE=0
NONINTERACTIVE=0

for arg in "$@"; do
	case "$arg" in
		--all)          INSTALL_ALL=1; NONINTERACTIVE=1 ;;
		--core)         INSTALL_CORE_ONLY=1; NONINTERACTIVE=1 ;;
		--no-wine)      NO_WINE=1 ;;
		--yes|-y)       NONINTERACTIVE=1 ;;
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

# ─── Detect Platform ──────────────────────────────────────────

OS=""
PKG_MGR=""

# Detect Windows (Git Bash, MSYS2, Cygwin, WSL)
UNAME_S="$(uname -s)"
case "$UNAME_S" in
	MSYS*|MINGW*|CYGWIN*)
		OS="windows"
		PKG_MGR="pacman"  # MSYS2 pacman
		;;
esac

# Detect WSL
if [ -z "$OS" ] && grep -qi microsoft /proc/version 2>/dev/null; then
	OS="wsl"
fi

# Detect Linux distros
if [ -z "$OS" ] && [ -f /etc/os-release ]; then
	. /etc/os-release
	case "$ID" in
		ubuntu|debian|linuxmint|pop|kali)
			OS="debian"; PKG_MGR="apt" ;;
		fedora|rhel|centos|rocky|alma)
			OS="fedora"; PKG_MGR="dnf" ;;
		arch|manjaro|endeavouros|garuda)
			OS="arch"; PKG_MGR="pacman" ;;
		opensuse*|suse)
			OS="suse"; PKG_MGR="zypper" ;;
		alpine)
			OS="alpine"; PKG_MGR="apk" ;;
		*)
			OS="$ID"; PKG_MGR="unknown" ;;
	esac
fi

# Detect macOS
if [ -z "$OS" ] && [ "$UNAME_S" = "Darwin" ]; then
	OS="macos"
	PKG_MGR="brew"
fi

if [ -z "$OS" ]; then
	fail "Could not detect OS. uname: $UNAME_S. Please install dependencies manually."
fi

info "Detected: $OS ($PKG_MGR)"

# ─── Component Selection ──────────────────────────────────────

# Core components (always installed)
# - node, npm, git, gcc/make, radare2, binutils (nm, size, objdump, strings)

# Optional components
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
INSTALL_PYTHON_TOOLS=0  # capstone, keystone, unicorn, angr, lief

if [ "$INSTALL_ALL" = "1" ]; then
	info "Installing ALL components (--all)"
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
	info "Installing CORE components only (--core)"
else
	echo ""
	info "Component Selection"
	echo "  Core (node, npm, git, gcc, radare2, binutils) — always installed"
	echo ""

	if [ "$OS" != "windows" ] && [ "$NO_WINE" = "0" ]; then
		if prompt_yesno "Install Wine? (run Windows PE binaries)" "y"; then
			INSTALL_WINE=1
		fi
	fi

	if prompt_yesno "Install MinGW-w64? (cross-compile Windows binaries)" "y"; then
		INSTALL_MINGW=1
	fi

	if prompt_yesno "Install Ghidra? (decompiler — large download)" "n"; then
		INSTALL_GHIDRA=1
	fi

	if prompt_yesno "Install Frida? (dynamic instrumentation)" "n"; then
		INSTALL_FRIDA=1
	fi

	if prompt_yesno "Install GDB? (scripted debugging)" "n"; then
		INSTALL_GDB=1
	fi

	if prompt_yesno "Install Binwalk? (firmware extraction)" "n"; then
		INSTALL_BINWALK=1
	fi

	if prompt_yesno "Install JADX? (APK/DEX → Java decompiler)" "n"; then
		INSTALL_JADX=1
	fi

	if prompt_yesno "Install ILSpy? (.NET → C# decompiler)" "n"; then
		INSTALL_ILSPY=1
	fi

	if prompt_yesno "Install Yara? (pattern matching)" "n"; then
		INSTALL_YARA=1
	fi

	if prompt_yesno "Install Volatility? (memory forensics)" "n"; then
		INSTALL_VOLATILITY=1
	fi

	if prompt_yesno "Install Python RE tools? (capstone, keystone, unicorn, angr, lief)" "y"; then
		INSTALL_PYTHON_TOOLS=1
	fi

	echo ""
fi

# ─── Package Manager Abstraction ──────────────────────────────

pkg_install() {
	case "$PKG_MGR" in
		apt)    sudo apt-get install -y -qq "$@" 2>/dev/null ;;
		dnf)    sudo dnf install -y -q "$@" 2>/dev/null ;;
		pacman) sudo pacman -S --noconfirm --needed "$@" 2>/dev/null ;;
		zypper) sudo zypper install -y -q "$@" 2>/dev/null ;;
		apk)    sudo apk add -q "$@" 2>/dev/null ;;
		brew)   brew install "$@" 2>/dev/null ;;
		*)      warn "Unknown package manager for: $*" ;;
	esac
}

pip_install() {
	if has pip3; then
		pip3 install --user -q "$@" 2>/dev/null || warn "pip install failed: $*"
	elif has pip; then
		pip install --user -q "$@" 2>/dev/null || warn "pip install failed: $*"
	else
		warn "pip not found, skipping: $*"
	fi
}

# ─── Install Core ─────────────────────────────────────────────

info "Installing core components..."

CORE_PACKAGES=""

case "$OS" in
	debian)
		CORE_PACKAGES="nodejs npm git build-essential radare2 binutils file"
		sudo apt-get update -qq 2>/dev/null
		;;
	fedora)
		CORE_PACKAGES="nodejs npm git gcc make radare2 binutils file"
		;;
	arch)
		CORE_PACKAGES="nodejs npm git base-devel radare2 binutils file"
		;;
	suse)
		CORE_PACKAGES="nodejs npm git gcc make radare2 binutils file"
		;;
	alpine)
		CORE_PACKAGES="nodejs npm git build-base radare2 binutils file"
		;;
	macos)
		if ! has brew; then
			info "Installing Homebrew..."
			/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
		fi
		CORE_PACKAGES="node radare2 binutils git"
		;;
	wsl)
		. /etc/os-release 2>/dev/null
		case "$ID" in
			ubuntu|debian|linuxmint|pop)
				OS="debian"; PKG_MGR="apt"
				CORE_PACKAGES="nodejs npm git build-essential radare2 binutils file"
				sudo apt-get update -qq 2>/dev/null
				;;
			fedora|rhel|centos|rocky|alma)
				OS="fedora"; PKG_MGR="dnf"
				CORE_PACKAGES="nodejs npm git gcc make radare2 binutils file"
				;;
			*) 
				OS="debian"; PKG_MGR="apt"
				CORE_PACKAGES="nodejs npm git build-essential radare2 binutils file"
				sudo apt-get update -qq 2>/dev/null
				;;
		esac
		;;
	windows)
		CORE_PACKAGES="nodejs npm git mingw-w64-x86_64-radare2 mingw-w64-x86_64-binutils"
		;;
esac

if [ -n "$CORE_PACKAGES" ]; then
	pkg_install $CORE_PACKAGES || warn "Some core packages may not be available"
fi

# Ensure Node.js 22+
NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
if [ "$NODE_VER" -lt 22 ] 2>/dev/null; then
	warn "Node.js is v$NODE_VER, need v22+"
	case "$OS" in
		debian)
			info "Installing Node 22 via NodeSource..."
			curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null
			sudo apt-get install -y -qq nodejs 2>/dev/null
			;;
		fedora)
			curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash - 2>/dev/null
			sudo dnf install -y -q nodejs 2>/dev/null
			;;
		arch|windows)
			pkg_install nodejs 2>/dev/null
			;;
		macos)
			brew install node@22 2>/dev/null || brew link --overwrite node@22 2>/dev/null
			;;
	esac
fi

# ─── Install Optional Components ──────────────────────────────

if [ "$INSTALL_WINE" = "1" ]; then
	info "Installing Wine..."
	case "$OS" in
		debian)   pkg_install wine64 wine ;;
		fedora)   pkg_install wine ;;
		arch)     pkg_install wine ;;
		suse)     pkg_install wine ;;
		macos)    brew install --cask wine-stable 2>/dev/null || warn "Wine on macOS Apple Silicon may not work" ;;
		windows)  ok "Wine not needed on Windows" ;;
	esac

	# Init wine prefix
	WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
	if [ ! -d "$WINEPREFIX" ] && [ "$OS" != "windows" ]; then
		info "Initializing Wine prefix..."
		WINEPREFIX="$WINEPREFIX" wineboot --init 2>/dev/null || warn "Wine init failed"
		ok "Wine prefix initialized"
	else
		ok "Wine prefix exists"
	fi
fi

if [ "$INSTALL_MINGW" = "1" ]; then
	info "Installing MinGW-w64..."
	case "$OS" in
		debian)   pkg_install gcc-mingw-w64-x86-64 ;;
		fedora)   pkg_install mingw64-gcc ;;
		arch)     pkg_install mingw-w64-gcc ;;
		suse)     pkg_install mingw64-gcc ;;
		macos)    brew install mingw-w64 ;;
		windows)  pkg_install mingw-w64-x86_64-gcc ;;
	esac
fi

if [ "$INSTALL_GDB" = "1" ]; then
	info "Installing GDB..."
	pkg_install gdb
fi

if [ "$INSTALL_BINWALK" = "1" ]; then
	info "Installing Binwalk..."
	case "$OS" in
		debian|fedora|arch|suse) pkg_install binwalk ;;
		macos) brew install binwalk ;;
		*) pip_install binwalk ;;
	esac
fi

if [ "$INSTALL_YARA" = "1" ]; then
	info "Installing Yara..."
	case "$OS" in
		debian)   pkg_install yara ;;
		fedora)   pkg_install yara ;;
		arch)     pkg_install yara ;;
		suse)     pkg_install yara ;;
		macos)    brew install yara ;;
		*) pip_install yara-python ;;
	esac
fi

if [ "$INSTALL_VOLATILITY" = "1" ]; then
	info "Installing Volatility 3..."
	pip_install volatility3
fi

if [ "$INSTALL_FRIDA" = "1" ]; then
	info "Installing Frida..."
	pip_install frida-tools
	case "$OS" in
		debian)   pkg_install python3-frida 2>/dev/null ;;
		arch)     pkg_install frida-tools 2>/dev/null ;;
	esac
fi

if [ "$INSTALL_JADX" = "1" ]; then
	info "Installing JADX..."
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install default-jre 2>/dev/null || warn "JADX needs Java (JRE)"
			if has jadx 2>/dev/null; then
				ok "JADX already installed"
			else
				info "Downloading JADX..."
				JADX_VER="1.5.0"
				curl -fsSL "https://github.com/skylot/jadx/releases/download/v${JADX_VER}/jadx-${JADX_VER}.zip" -o /tmp/jadx.zip 2>/dev/null
				sudo mkdir -p /opt/jadx && sudo unzip -q -o /tmp/jadx.zip -d /opt/jadx 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx /usr/local/bin/jadx 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx-gui /usr/local/bin/jadx-gui 2>/dev/null
				rm -f /tmp/jadx.zip
			fi
			;;
		macos)
			brew install jadx
			;;
		*) warn "JADX install not automated on $OS — see https://github.com/skylot/jadx" ;;
	esac
fi

if [ "$INSTALL_ILSPY" = "1" ]; then
	info "Installing ILSpy..."
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install dotnet-sdk-8.0 2>/dev/null || pkg_install dotnet-sdk 2>/dev/null || warn "ILSpy needs .NET SDK"
			if has dotnet 2>/dev/null; then
				dotnet tool install -g ilspycmd 2>/dev/null || warn "ilspycmd install failed"
			fi
			;;
		macos)
			brew install --cask dotnet-sdk 2>/dev/null || warn "Install .NET SDK manually"
			if has dotnet 2>/dev/null; then
				dotnet tool install -g ilspycmd 2>/dev/null
			fi
			;;
		*) warn "ILSpy install not automated on $OS — see https://github.com/icsharpcode/ILSpy" ;;
	esac
fi

if [ "$INSTALL_GHIDRA" = "1" ]; then
	info "Installing Ghidra..."
	case "$OS" in
		debian|fedora|arch|suse|wsl)
			pkg_install default-jdk 2>/dev/null || warn "Ghidra needs Java (JDK 17+)"
			if has java 2>/dev/null; then
				GHIDRA_VER="11.1.2"
				GHIDRA_DATE="20240709"
				info "Downloading Ghidra ${GHIDRA_VER}..."
				curl -fsSL "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip" -o /tmp/ghidra.zip 2>/dev/null
				if [ -f /tmp/ghidra.zip ]; then
					sudo unzip -q -o /tmp/ghidra.zip -d /opt/ 2>/dev/null
					sudo ln -sf /opt/ghidra_${GHIDRA_VER}_PUBLIC/ghidraRun /usr/local/bin/ghidra 2>/dev/null
					ok "Ghidra installed to /opt/ghidra_${GHIDRA_VER}_PUBLIC"
					rm -f /tmp/ghidra.zip
				else
					warn "Ghidra download failed — install manually from https://ghidra-sre.org/"
				fi
			else
				warn "Java not installed — Ghidra requires JDK 17+"
			fi
			;;
		macos)
			brew install --cask ghidra 2>/dev/null || warn "Install Ghidra manually from https://ghidra-sre.org/"
			;;
		*) warn "Ghidra install not automated on $OS — see https://ghidra-sre.org/" ;;
	esac
fi

if [ "$INSTALL_PYTHON_TOOLS" = "1" ]; then
	info "Installing Python RE tools (capstone, keystone, unicorn, angr, lief)..."
	case "$OS" in
		debian)
			pkg_install python3-pip python3-venv 2>/dev/null
			# Some distros need these as system packages
			pkg_install python3-capstone python3-lief 2>/dev/null
			;;
		fedora)
			pkg_install python3-pip python3-capstone python3-lief 2>/dev/null
			;;
		arch)
			pkg_install python-pip python-capstone python-lief 2>/dev/null
			;;
	esac
	pip_install capstone keystone-engine unicorn angr lief
fi

# ─── Verify ───────────────────────────────────────────────────

info "Verifying installations..."
echo ""

has node    && ok "Node.js $(node -v)" || fail "Node.js not installed"
has npm     && ok "npm $(npm -v)" || fail "npm not installed"
has git     && ok "git $(git --version | head -1)" || warn "git not installed"
has gcc     && ok "gcc $(gcc -dumpversion)" || warn "gcc not installed"
has r2      && ok "radare2 $(r2 -v 2>/dev/null | head -1)" || warn "radare2 not installed"
has strings && ok "strings" || warn "strings not installed"
has objdump && ok "objdump" || warn "objdump not installed"
has nm      && ok "nm" || warn "nm not installed"
has file    && ok "file" || warn "file not installed"

if [ "$INSTALL_WINE" = "1" ]; then
	(has wine || has wine64) && ok "wine" || warn "wine not installed"
fi
if [ "$INSTALL_MINGW" = "1" ]; then
	has x86_64-w64-mingw32-gcc && ok "MinGW-w64" || warn "MinGW-w64 not installed"
fi
if [ "$INSTALL_GDB" = "1" ]; then
	has gdb && ok "gdb" || warn "gdb not installed"
fi
if [ "$INSTALL_BINWALK" = "1" ]; then
	has binwalk && ok "binwalk" || warn "binwalk not installed"
fi
if [ "$INSTALL_FRIDA" = "1" ]; then
	(has frida || has frida-ps) && ok "frida" || warn "frida not installed"
fi
if [ "$INSTALL_JADX" = "1" ]; then
	has jadx && ok "jadx" || warn "jadx not installed"
fi
if [ "$INSTALL_YARA" = "1" ]; then
	has yara && ok "yara" || warn "yara not installed"
fi
if [ "$INSTALL_PYTHON_TOOLS" = "1" ]; then
	python3 -c "import capstone" 2>/dev/null && ok "capstone" || warn "capstone not installed"
	python3 -c "import lief" 2>/dev/null && ok "lief" || warn "lief not installed"
fi

# ─── Install npm dependencies ─────────────────────────────────

SCRIPT_DIR=""
# Try to find the repo root (if running from cloned repo)
if [ -f "$(dirname "$0")/package.json" ]; then
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ -f "./package.json" ]; then
	SCRIPT_DIR="$(pwd)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
	info "Installing npm dependencies..."
	cd "$SCRIPT_DIR"
	npm install --ignore-scripts 2>/dev/null || npm install 2>/dev/null || warn "npm install had issues"
	ok "npm dependencies installed"

	# Link pire CLI
	if [ -f "$SCRIPT_DIR/packages/re-agent/src/cli.ts" ] && ! has pire 2>/dev/null; then
		info "Installing pire CLI link..."
		sudo ln -sf "$SCRIPT_DIR/packages/re-agent/src/cli.ts" /usr/local/bin/pire 2>/dev/null || \
			warn "Could not create /usr/local/bin/pire symlink"
		if ! has tsx 2>/dev/null; then
			info "Installing tsx (for running .ts files)..."
			npm install -g tsx 2>/dev/null || warn "Install tsx manually: npm install -g tsx"
		fi
		ok "pire command available"
	fi

	# Run tests
	if [ -f "$SCRIPT_DIR/packages/re-agent/test/test-suite.cjs" ]; then
		info "Running test suite..."
		if node packages/re-agent/test/test-suite.cjs 2>&1 | tail -3; then
			ok "Tests passed"
		else
			warn "Some tests failed"
		fi
	fi
fi

# ─── Done ─────────────────────────────────────────────────────

echo ""
info "Installation complete!"
echo ""
echo "  What you can do now:"
echo ""
echo "  1. Set your LLM API credentials:"
echo "     export OPENAI_API_KEY=\"your-key\""
echo "     export OPENAI_BASE_URL=\"https://api.openai.com/v1\""
echo "     export OPENAI_MODEL=\"gpt-4o\""
echo ""
echo "  2. Start pire:"
echo "     pire                          # start chat"
echo "     pire /bin/ls                  # analyze a binary"
echo "     pire https://example.com/app.exe  # download & analyze"
echo ""
if [ "$INSTALL_WINE" = "0" ] && [ "$OS" != "windows" ]; then
	echo "  Note: Wine not installed — can't run Windows PE binaries."
	echo "        Re-run with ./install.sh to add Wine."
	echo ""
fi
if [ "$INSTALL_PYTHON_TOOLS" = "0" ]; then
	echo "  Note: Python RE tools (capstone, angr, lief) not installed."
	echo "        Re-run with ./install.sh to add them."
	echo ""
fi
