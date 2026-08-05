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

set +e

# ── Helpers ───────────────────────────────────────────────────
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

# Ensure user-local bin dirs are on PATH (pip --user, dotnet tools, etc.)
for _dir in "$HOME/.local/bin" "$HOME/.dotnet/tools"; do
	case ":$PATH:" in
		*":$_dir:"*) ;;
		*) [ -d "$_dir" ] && PATH="$_dir:$PATH" && export PATH ;;
	esac
done

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
	# Serialize package manager calls — apt/dnf/pacman all use lock files
	# and will fail if invoked in parallel.
	PKG_LOCKFILE="/tmp/pire-pkg-install.lock"
	PKG_LOCKHELD=0
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$PKG_LOCKFILE"
		if flock -w 300 9; then
			PKG_LOCKHELD=1
		else
			log_warn "Could not acquire package lock for: $*"
			exec 9>&-
			return 1
		fi
	else
		# No flock (macOS) — retry loop as fallback
		PKG_TRIES=0
		while [ $PKG_TRIES -lt 60 ]; do
			if mkdir "$PKG_LOCKFILE" 2>/dev/null; then
				PKG_LOCKHELD=2
				break
			fi
			sleep 5
			PKG_TRIES=$((PKG_TRIES + 1))
		done
		if [ "$PKG_LOCKHELD" != "2" ]; then
			log_warn "Could not acquire package lock for: $*"
			return 1
		fi
	fi
	case "$PKG_MGR" in
		apt)
			# Use --fix-broken to handle partial installs, and don't let
			# broken third-party repos block the entire install.
			sudo apt-get install -y --no-install-recommends --fix-broken "$@" </dev/null >/dev/null 2>&1
			;;
		dnf)    sudo dnf install -y -q "$@" </dev/null >/dev/null 2>&1 ;;
		pacman)
			if [ "$OS" = "windows" ]; then
				sudo pacman -S --noconfirm --needed "$@" </dev/null 2>&1 \
					| grep -v "Command line alias added" >&2 || true
			else
				sudo pacman -S --noconfirm --needed "$@" </dev/null >/dev/null 2>&1
			fi
			;;
		zypper) sudo zypper install -y -q "$@" </dev/null >/dev/null 2>&1 ;;
		apk)    sudo apk add -q "$@" </dev/null >/dev/null 2>&1 ;;
		brew)
			# Try brew install — if it fails, try as cask
			brew install "$@" </dev/null >/dev/null 2>&1 || brew install --cask "$@" </dev/null >/dev/null 2>&1
			;;
		*)      log_warn "Unknown package manager for: $*" ;;
	esac
	PKG_RC=$?
	if [ "$PKG_LOCKHELD" = "1" ]; then
		flock -u 9
		exec 9>&-
	elif [ "$PKG_LOCKHELD" = "2" ]; then
		rmdir "$PKG_LOCKFILE" 2>/dev/null
	fi
	return $PKG_RC
}

PIP_INSTALL_TIMEOUT=180

# Run a command with a timeout. On Linux, uses GNU `timeout`.
# On macOS (no timeout/gtimeout), uses a Perl wrapper that kills the
# entire process group so child processes (gcc, cc, ld) don't survive.
run_with_timeout() {
	if command -v timeout >/dev/null 2>&1; then
		timeout -k 5 "$PIP_INSTALL_TIMEOUT" "$@"
	elif command -v gtimeout >/dev/null 2>&1; then
		gtimeout -k 5 "$PIP_INSTALL_TIMEOUT" "$@"
	else
		perl -e '
			use POSIX qw(setpgid);
			my $secs = shift;
			setpgid(0, 0);  # parent becomes process group leader
			my $pid = fork();
			if ($pid == 0) {
				# child inherits parent pgid — do NOT call setpgid here
				exec @ARGV or die "exec: $!";
			}
			local $SIG{ALRM} = sub {
				kill -9, $$;  # signal entire process group
				exit 124;
			};
			alarm $secs;
			waitpid($pid, 0);
			exit $? >> 8;
		' "$PIP_INSTALL_TIMEOUT" "$@"
	fi
}

pip_install() {
	PIPRE_PY=""
	# On macOS, prefer Homebrew Python over Xcode CLT Python.
	# Xcode CLT ships an ancient pip that doesn't support --break-system-packages.
	for p in \
		/opt/homebrew/bin/python3 \
		/usr/local/bin/python3 \
		/usr/bin/python3 \
		python3 python
	do
		if command -v "$p" >/dev/null 2>&1 && "$p" -m pip --version >/dev/null 2>&1; then
			PIPRE_PY="$p"
			break
		fi
	done

	if [ -z "$PIPRE_PY" ]; then
		for p in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3 python3 python; do
			if command -v "$p" >/dev/null 2>&1 && "$p" -m ensurepip --user </dev/null >/dev/null 2>&1; then
				PIPRE_PY="$p"
				break
			fi
		done
	fi

	if [ -z "$PIPRE_PY" ]; then
		return 1
	fi

	# Export the resolved Python path so other functions use the same one
	PIRE_PYTHON="$PIPRE_PY"
	export PIRE_PYTHON

	# --break-system-packages is a pip flag (not OS-specific).
	# Only use it if this pip actually supports it (pip >= 23.0).
	PIPRE_FLAGS="--user"
	if "$PIPRE_PY" -m pip install --help 2>/dev/null | grep -q -- '--break-system-packages'; then
		PIPRE_FLAGS="$PIPRE_FLAGS --break-system-packages"
	fi

	# Write output to a temp file, NOT $(...) — command substitution
	# uses a pipe; if child processes (gcc, cc, ld) survive the timeout,
	# they keep the pipe open and $(...) hangs forever.
	PIPRE_LOG="${TMPDIR_PIRE:-/tmp}/pip_$$.log"

	if [ "$OS" = "windows" ]; then
		run_with_timeout "$PIPRE_PY" -m pip install --user "$@" </dev/null >"$PIPRE_LOG" 2>&1
		PIPRE_RC=$?
		if [ $PIPRE_RC -eq 0 ]; then
			grep -v "already satisfied" "$PIPRE_LOG" | tail -3
			rm -f "$PIPRE_LOG" 2>/dev/null
			return 0
		fi
		tail -3 "$PIPRE_LOG"
		rm -f "$PIPRE_LOG" 2>/dev/null
		return 1
	fi

	run_with_timeout "$PIPRE_PY" -m pip install $PIPRE_FLAGS "$@" </dev/null >"$PIPRE_LOG" 2>&1
	PIPRE_RC=$?
	if [ $PIPRE_RC -eq 0 ]; then
		grep -v "already satisfied" "$PIPRE_LOG" | tail -3
		rm -f "$PIPRE_LOG" 2>/dev/null
		return 0
	fi
	# Fallback: try system-wide (without --user)
	run_with_timeout "$PIPRE_PY" -m pip install --break-system-packages "$@" </dev/null >"$PIPRE_LOG" 2>&1
	PIPRE_RC=$?
	if [ $PIPRE_RC -eq 0 ]; then
		grep -v "already satisfied" "$PIPRE_LOG" | tail -3
		rm -f "$PIPRE_LOG" 2>/dev/null
		return 0
	fi
	tail -3 "$PIPRE_LOG" 2>/dev/null
	rm -f "$PIPRE_LOG" 2>/dev/null
	return 1
}

# ── Core Install (sequential — everything depends on Node.js) ─
log_section "Core Components"

case "$OS" in
	debian)
		log_step "Updating package index..."
		# Allow apt-get update to fail on broken third-party repos
		# (e.g. Sonarr missing GPG keys) — we only need the core repos
		sudo apt-get update -qq </dev/null 2>/dev/null
		log_step "Installing core packages..."
		# Note: nodejs/npm installed separately from official binary below
		pkg_install git build-essential radare2 binutils file python3-pip python3-venv
		/usr/bin/python3 -m pip --version >/dev/null 2>&1 || /usr/bin/python3 -m ensurepip --user </dev/null >/dev/null 2>&1
		;;
	fedora)
		log_step "Installing core packages..."
		pkg_install git gcc make radare2 binutils file python3-pip
		;;
	arch)
		log_step "Installing core packages..."
		pkg_install git base-devel radare2 binutils file python-pip
		;;
	suse)
		log_step "Installing core packages..."
		pkg_install git gcc make radare2 binutils file python3-pip
		;;
	alpine)
		log_step "Installing core packages..."
		pkg_install git build-base radare2 binutils file py3-pip
		;;
	macos)
		if ! has brew; then
			log_step "Installing Homebrew..."
			/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null >/dev/null 2>&1
		fi
		log_done "Homebrew ready"
		log_step "Installing core packages..."
		pkg_install node radare2 binutils git
		# Install coreutils for gtimeout (needed for pip timeout)
		pkg_install coreutils 2>/dev/null || true
		# Ensure Python is available (node formula may pull it in, but not always)
		pkg_install python@3 2>/dev/null || true
		;;
	wsl)
		. /etc/os-release 2>/dev/null
		case "$ID" in
			ubuntu|debian|linuxmint|pop)
				OS="debian"; PKG_MGR="apt"
				log_step "Updating package index..."
				sudo apt-get update -qq </dev/null 2>/dev/null
				log_step "Installing core packages..."
				pkg_install git build-essential radare2 binutils file
				;;
			fedora|rhel|centos|rocky|alma)
				OS="fedora"; PKG_MGR="dnf"
				log_step "Installing core packages..."
				pkg_install git gcc make radare2 binutils file
				;;
			*)
				OS="debian"; PKG_MGR="apt"
				log_step "Updating package index..."
				sudo apt-get update -qq </dev/null 2>/dev/null
				log_step "Installing core packages..."
				pkg_install git build-essential radare2 binutils file
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
	log_step "Installing Node.js 22..."

	case "$OS" in
		macos)
			# macOS: use Homebrew
			pkg_install node@22 2>/dev/null || brew link --overwrite node@22 </dev/null >/dev/null 2>&1
			;;
		windows)
			# MSYS2/Windows: pacman has recent Node
			pkg_install nodejs 2>/dev/null
			;;
		*)
			# Linux: install from official binary tarball.
			# This avoids all apt/dnf repo issues (broken third-party repos,
			# GPG keys, stale caches) — just download and extract to /usr/local.
			log_step "Installing Node.js 22 from official binary..."
			NODE_ARCH="x64"
			case "$(uname -m)" in
				aarch64|arm64) NODE_ARCH="arm64" ;;
				x86_64|amd64)  NODE_ARCH="x64" ;;
				*)             log_warn "Unknown arch $(uname -m), trying x64" ;;
			esac

			# Fetch the latest Node 22 version from the official API
			NODE_LATEST=$(curl -fsSL "https://nodejs.org/dist/index.json" 2>/dev/null \
				| grep -o '"version":"v22\.[^"]*"' | head -1 | sed 's/"version":"//;s/"//')
			[ -z "$NODE_LATEST" ] && NODE_LATEST="v22.11.0"

			NODE_TARBALL="/tmp/node22-$$.tar.xz"
			NODE_URL="https://nodejs.org/dist/$NODE_LATEST/node-$NODE_LATEST-linux-$NODE_ARCH.tar.xz"

			if curl -fsSL "$NODE_URL" -o "$NODE_TARBALL" 2>/dev/null; then
				if [ -w /usr/local ]; then
					tar -xJf "$NODE_TARBALL" -C /usr/local --strip-components=1 2>/dev/null
				else
					sudo tar -xJf "$NODE_TARBALL" -C /usr/local --strip-components=1 2>/dev/null
				fi
				rm -f "$NODE_TARBALL" 2>/dev/null
			else
				log_warn "Direct download failed, trying nvm..."
			fi
			;;
	esac

	# Verify
	NODE_VER_NEW=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
	if [ "$NODE_VER_NEW" -lt 22 ] 2>/dev/null; then
		log_warn "Binary install didn't take, trying nvm fallback..."
		# nvm fallback — user-space install, no sudo needed
		curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | sh >/dev/null 2>&1
		NVM_DIR="$HOME/.nvm"
		[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
		nvm install 22 >/dev/null 2>&1
		nvm use 22 >/dev/null 2>&1
		nvm alias default 22 >/dev/null 2>&1
		# Source nvm in shell profile so it persists
		for PROFILE_FILE in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
			[ -f "$PROFILE_FILE" ] || continue
			grep -q 'NVM_DIR' "$PROFILE_FILE" 2>/dev/null && break
			printf '\n# nvm\nexport NVM_DIR="$HOME/.nvm"\n[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"\n' >> "$PROFILE_FILE"
		done
		NODE_VER_NEW=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
	fi

	if [ "$NODE_VER_NEW" -ge 22 ] 2>/dev/null; then
		log_done "Node.js $(node -v)"
	else
		log_error "Failed to install Node.js 22+ (still v$NODE_VER_NEW)"
		log_error "Please install manually: https://nodejs.org/en/download"
		exit 1
	fi
else
	log_done "Node.js $(node -v)"
fi

# ── Cache sudo credentials for parallel phase ─────────────────
NEEDS_SUDO=0
case "$OS" in
	debian|fedora|arch|suse|alpine|wsl) NEEDS_SUDO=1 ;;
esac
if [ "$NEEDS_SUDO" = "1" ]; then
	log_step "Caching sudo credentials for parallel installs..."
	sudo -v 2>/dev/null && log_done "sudo ready" || log_warn "sudo not cached — may prompt during install"
fi

# ── Parallel Install Phase ────────────────────────────────────
# Each component runs in the background, writing status to a temp file.
# Main loop shows a live spinner dashboard.

TMPDIR_PIRE="/tmp/pire-install-$$"
mkdir -p "$TMPDIR_PIRE"

# Status constants
ST_PENDING="pending"
ST_RUNNING="running"
ST_DONE="done"
ST_FAILED="failed"

# Spinner frames (Unicode braille)
SPIN_FRAMES="⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏"
SPIN_IDX=0

# Build list of components to install in parallel
COMPONENTS=""
COMP_LABELS=""

add_component() {
	COMPONENTS="$COMPONENTS $1"
	if [ -z "$COMP_LABELS" ]; then
		COMP_LABELS="$2"
	else
		COMP_LABELS="$COMP_LABELS|$2"
	fi
	echo "$ST_PENDING" > "$TMPDIR_PIRE/$1.status"
}

[ "$INSTALL_WINE" = "1" ]         && add_component "wine"         "Wine"
[ "$INSTALL_MINGW" = "1" ]        && add_component "mingw"        "MinGW-w64"
[ "$INSTALL_GDB" = "1" ]          && add_component "gdb"          "GDB"
[ "$INSTALL_BINWALK" = "1" ]      && add_component "binwalk"      "Binwalk"
[ "$INSTALL_FRIDA" = "1" ]        && add_component "frida"        "Frida"
[ "$INSTALL_JADX" = "1" ]         && add_component "jadx"         "JADX"
[ "$INSTALL_ILSPY" = "1" ]        && add_component "ilspy"        "ILSpy"
[ "$INSTALL_GHIDRA" = "1" ]       && add_component "ghidra"       "Ghidra"
[ "$INSTALL_YARA" = "1" ]         && add_component "yara"         "Yara"
[ "$INSTALL_VOLATILITY" = "1" ]   && add_component "volatility"   "Volatility"
[ "$INSTALL_PYTHON_TOOLS" = "1" ] && add_component "python_tools" "Python RE tools"

# ── Component install functions ───────────────────────────────

install_wine() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/wine.status"
	case "$OS" in
		debian)  pkg_install wine64 wine ;;
		fedora)  pkg_install wine ;;
		arch)    pkg_install wine ;;
		suse)    pkg_install wine ;;
		macos)   pkg_install wine-stable 2>/dev/null || true ;;
		windows) true ;;  # not needed
	esac
	# Init wine prefix
	if [ "$OS" != "windows" ]; then
		WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
		if [ ! -d "$WINEPREFIX" ] && has wine; then
			WINEPREFIX="$WINEPREFIX" wineboot --init >/dev/null 2>&1 || true
		fi
	fi
	if has wine || has wine64 || [ "$OS" = "windows" ]; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/wine.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/wine.status"
	fi
}

install_mingw() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/mingw.status"
	case "$OS" in
		debian)  pkg_install gcc-mingw-w64-x86-64 ;;
		fedora)  pkg_install mingw64-gcc ;;
		arch)    pkg_install mingw-w64-gcc ;;
		suse)    pkg_install mingw64-gcc ;;
		macos)   pkg_install mingw-w64 2>/dev/null ;;
		windows) pkg_install mingw-w64-x86_64-gcc ;;
	esac
	if has x86_64-w64-mingw32-gcc || has gcc; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/mingw.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/mingw.status"
	fi
}

install_gdb() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/gdb.status"
	case "$OS" in
		windows) pkg_install mingw-w64-x86_64-gdb ;;
		*)       pkg_install gdb ;;
	esac
	if has gdb; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/gdb.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/gdb.status"
	fi
}

install_binwalk() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/binwalk.status"
	case "$OS" in
		debian|fedora|arch|suse) pkg_install binwalk ;;
		macos) pkg_install binwalk 2>/dev/null ;;
		windows)
			if command -v python3 >/dev/null 2>&1; then
				python3 -m pip install --user binwalk </dev/null 2>&1 | tail -3
			elif command -v python >/dev/null 2>&1; then
				python -m pip install --user binwalk </dev/null 2>&1 | tail -3
			fi
			;;
		*) pip_install binwalk ;;
	esac
	if has binwalk; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/binwalk.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/binwalk.status"
	fi
}

install_frida() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/frida.status"
	pip_install frida-tools
	case "$OS" in
		debian) pkg_install python3-frida 2>/dev/null ;;
		arch)   pkg_install frida-tools 2>/dev/null ;;
	esac
	if has frida || has frida-ps || "${PIRE_PYTHON:-python3}" -c "import frida" 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/frida.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/frida.status"
	fi
}

install_jadx() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/jadx.status"
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install default-jre 2>/dev/null || true
			if ! has jadx 2>/dev/null; then
				JADX_VER="1.5.0"
				curl -fsSL "https://github.com/skylot/jadx/releases/download/v${JADX_VER}/jadx-${JADX_VER}.zip" -o /tmp/jadx.zip 2>/dev/null
				sudo mkdir -p /opt/jadx && sudo unzip -q -o /tmp/jadx.zip -d /opt/jadx </dev/null 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx /usr/local/bin/jadx 2>/dev/null
				sudo ln -sf /opt/jadx/bin/jadx-gui /usr/local/bin/jadx-gui 2>/dev/null
				rm -f /tmp/jadx.zip
			fi
			;;
		macos)
			pkg_install jadx 2>/dev/null
			;;
	esac
	if has jadx; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/jadx.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/jadx.status"
	fi
}

install_ilspy() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/ilspy.status"
	case "$OS" in
		debian|fedora|arch|suse)
			pkg_install dotnet-sdk-8.0 2>/dev/null || pkg_install dotnet-sdk 2>/dev/null || true
			if has dotnet 2>/dev/null; then
				run_with_timeout dotnet tool install -g ilspycmd </dev/null 2>/dev/null
			fi
			# Fallback: mono-utils provides monodis
			if ! has ilspycmd 2>/dev/null && ! has monodis 2>/dev/null; then
				pkg_install mono-devel 2>/dev/null || true
			fi
			;;
		macos)
			pkg_install dotnet-sdk 2>/dev/null || true
			if has dotnet 2>/dev/null; then
				run_with_timeout dotnet tool install -g ilspycmd </dev/null 2>/dev/null
			fi
			;;
	esac
	if has ilspycmd 2>/dev/null || has monodis 2>/dev/null || has dotnet 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/ilspy.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/ilspy.status"
	fi
}

install_ghidra() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/ghidra.status"
	case "$OS" in
		debian|fedora|arch|suse|wsl)
			pkg_install default-jdk 2>/dev/null || true
			if has java 2>/dev/null; then
				GHIDRA_VER="11.1.2"
				GHIDRA_DATE="20240709"
				run_with_timeout curl -fsSL "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip" -o /tmp/ghidra.zip 2>/dev/null
				if [ -f /tmp/ghidra.zip ] && [ -s /tmp/ghidra.zip ]; then
					sudo unzip -q -o /tmp/ghidra.zip -d /opt/ </dev/null 2>/dev/null
					sudo ln -sf /opt/ghidra_${GHIDRA_VER}_PUBLIC/ghidraRun /usr/local/bin/ghidra 2>/dev/null
					rm -f /tmp/ghidra.zip
				fi
			fi
			;;
		macos)
			# Install JDK first (Ghidra requires Java 17+)
			pkg_install temurin 2>/dev/null || pkg_install openjdk 2>/dev/null || true
			GHIDRA_VER="11.1.2"
			GHIDRA_DATE="20240709"
			GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip"
			GHIDRA_DIR="$HOME/.local/share/ghidra"
			run_with_timeout curl -fsSL "$GHIDRA_URL" -o /tmp/ghidra.zip 2>/dev/null
			if [ -f /tmp/ghidra.zip ] && [ -s /tmp/ghidra.zip ]; then
				mkdir -p "$GHIDRA_DIR" 2>/dev/null
				unzip -q -o /tmp/ghidra.zip -d "$GHIDRA_DIR" 2>/dev/null
				GHIDRA_BIN=$(find "$GHIDRA_DIR" -name ghidraRun -type f 2>/dev/null | head -1)
				if [ -n "$GHIDRA_BIN" ]; then
					mkdir -p "$HOME/.local/bin" 2>/dev/null
					ln -sf "$GHIDRA_BIN" "$HOME/.local/bin/ghidra" 2>/dev/null
				fi
				rm -f /tmp/ghidra.zip
			fi
			;;
	esac
	if has ghidra 2>/dev/null || has ghidraRun 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/ghidra.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/ghidra.status"
	fi
}

install_yara() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/yara.status"
	case "$OS" in
		debian|fedora|arch|suse) pkg_install yara ;;
		macos) pkg_install yara 2>/dev/null ;;
		*) pip_install yara-python ;;
	esac
	# Always install yara-python — pire uses the Python module, not the CLI
	pip_install yara-python 2>/dev/null
	if has yara || python3 -c "import yara" 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/yara.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/yara.status"
	fi
}

install_volatility() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/volatility.status"
	pip_install volatility3
	if command -v vol 2>/dev/null || command -v vol3 2>/dev/null || "${PIRE_PYTHON:-python3}" -c "import volatility3" 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/volatility.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/volatility.status"
	fi
}

install_python_tools() {
	echo "$ST_RUNNING" > "$TMPDIR_PIRE/python_tools.status"
	case "$OS" in
		debian)
			pkg_install python3-pip python3-venv 2>/dev/null
			pkg_install python3-capstone python3-lief 2>/dev/null
			;;
		fedora) pkg_install python3-pip python3-capstone python3-lief 2>/dev/null ;;
		arch)   pkg_install python-pip python-capstone python-lief 2>/dev/null ;;
	esac
	# Install packages individually — angr is slow to compile and
	# shouldn't block capstone/keystone/unicorn/lief.
	# Use --only-binary when available to avoid source compilation.
	for pkg in capstone unicorn lief; do
		pip_install "$pkg" 2>/dev/null || true
	done
	# keystone-engine has no arm64 wheel on PyPI — use our pre-built one
	if [ "$OS" = "macos" ] && [ "$(uname -m)" = "arm64" ]; then
		KS_WHEEL="/tmp/keystone_engine-arm64.whl"
		curl -fsSL "https://raw.githubusercontent.com/evangit2/pire/main/wheels/macos-arm64/keystone_engine-0.9.2-py2.py3-none-macosx_14_0_arm64.whl" -o "$KS_WHEEL" 2>/dev/null
		if [ -f "$KS_WHEEL" ]; then
			pip_install "$KS_WHEEL" 2>/dev/null || pip_install keystone-engine 2>/dev/null || true
		else
			pip_install keystone-engine 2>/dev/null || true
		fi
	else
		pip_install keystone-engine 2>/dev/null || true
	fi
	# angr is heavy — try binary wheel first, fall back to source
	pip_install "angr" 2>/dev/null || true
	# Verify using the same Python that pip_install selected
	VERIFY_PY="${PIRE_PYTHON:-python3}"
	if "$VERIFY_PY" -c "import capstone" 2>/dev/null; then
		echo "$ST_DONE" > "$TMPDIR_PIRE/python_tools.status"
	else
		echo "$ST_FAILED" > "$TMPDIR_PIRE/python_tools.status"
	fi
}

# ── Launch all selected components in parallel ────────────────
if [ -n "$COMPONENTS" ]; then
	log_section "Parallel Installation"
	echo "  Installing $(echo $COMPONENTS | wc -w | tr -d ' ') components in parallel..."
	echo ""

	# Launch each component in background
	for comp in $COMPONENTS; do
		eval "install_${comp}" </dev/null >"$TMPDIR_PIRE/$comp.log" 2>&1 &
	done

	# ── Live spinner dashboard ───────────────────────────────
	# Get the list of labels aligned with components
	get_label() {
		echo "$COMP_LABELS" | tr '|' '\n' | sed -n "$1p"
	}

	# Count components
	N_COMPS=$(echo $COMPONENTS | wc -w | tr -d ' ')

	# Print initial lines (one per component) so we can overwrite them
	i=0
	while [ $i -lt $N_COMPS ]; do
		i=$((i + 1))
		label=$(get_label $i)
		printf '  %s %s\n' " " "$label"
	done

	# Move cursor up to first line
	printf '\033[%dA' "$N_COMPS"

	# Main render loop
	ALL_DONE=0
	while [ $ALL_DONE -eq 0 ]; do
		# Get current spinner char
		SPIN_IDX=$(( (SPIN_IDX + 1) % 10 ))
		SPIN_CHAR=$(echo "$SPIN_FRAMES" | cut -d' ' -f$((SPIN_IDX + 1)))

		# Render each component line
		idx=0
		ALL_DONE=1
		for comp in $COMPONENTS; do
			idx=$((idx + 1))
			label=$(get_label $idx)
			status=$(cat "$TMPDIR_PIRE/$comp.status" 2>/dev/null || echo "$ST_PENDING")

			case "$status" in
				$ST_PENDING)
					icon="\033[0;90m○\033[0m"
					ALL_DONE=0
					;;
				$ST_RUNNING)
					icon="\033[0;36m${SPIN_CHAR}\033[0m"
					ALL_DONE=0
					;;
				$ST_DONE)
					icon="\033[0;32m✓\033[0m"
					;;
				$ST_FAILED)
					icon="\033[0;31m✗\033[0m"
					;;
			esac

			# Pad label to 20 chars for alignment
			padded=$(printf '%-20s' "$label")

			# Clear line and write (\r returns to col 0, \033[2K clears line)
			printf '\r\033[2K  %b %s' "$icon" "$padded"

			# Print status text
			case "$status" in
				$ST_PENDING)  printf '\033[0;90mwaiting\033[0m' ;;
				$ST_RUNNING)  printf '\033[0;36minstalling...\033[0m' ;;
				$ST_DONE)     printf '\033[0;32mdone\033[0m' ;;
				$ST_FAILED)   printf '\033[0;31mfailed\033[0m' ;;
			esac

			# Move to next line (every line gets \n so cursor math is simple)
			printf '\n'
		done

		# Move cursor back up to first line for next redraw
		printf '\033[%dA' "$N_COMPS"

		if [ $ALL_DONE -eq 0 ]; then
			sleep 0.3 2>/dev/null || sleep 1
		fi
	done

	# Move cursor down past all lines
	printf '\n\033[%dB' "$((N_COMPS - 1))"

	echo ""
	echo "  Results:"
	for comp in $COMPONENTS; do
		status=$(cat "$TMPDIR_PIRE/$comp.status" 2>/dev/null || echo "$ST_FAILED")
		label=$(printf '%-20s' "$comp")
		case "$status" in
			$ST_DONE)   log_done "$comp" ;;
			$ST_FAILED) log_warn "$comp — check $TMPDIR_PIRE/$comp.log" ;;
		esac
	done

	# Clean up temp files (keep logs if failures)
	HAD_FAILURE=0
	for comp in $COMPONENTS; do
		status=$(cat "$TMPDIR_PIRE/$comp.status" 2>/dev/null || echo "")
		if [ "$status" = "$ST_FAILED" ]; then
			HAD_FAILURE=1
		fi
	done
	if [ "$HAD_FAILURE" = "0" ]; then
		rm -rf "$TMPDIR_PIRE"
	fi
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

[ "$INSTALL_WINE" = "1" ]   && { (has wine || has wine64)                       && log_done "wine"                       || log_error "wine not installed"; }
[ "$INSTALL_MINGW" = "1" ]  && { has x86_64-w64-mingw32-gcc                     && log_done "MinGW-w64"                  || log_error "MinGW-w64 not installed"; }
[ "$INSTALL_GDB" = "1" ]    && { has gdb                                        && log_done "gdb"                        || log_error "gdb not installed"; }
[ "$INSTALL_BINWALK" = "1" ] && { has binwalk                                   && log_done "binwalk"                    || log_error "binwalk not installed"; }
[ "$INSTALL_FRIDA" = "1" ]  && { (has frida || has frida-ps || "${PIRE_PYTHON:-python3}" -c "import frida" 2>/dev/null) && log_done "frida" || log_error "frida not installed"; }
[ "$INSTALL_JADX" = "1" ]   && { (has jadx || has jadx-cli)                     && log_done "jadx"                       || log_error "jadx not installed"; }
[ "$INSTALL_YARA" = "1" ]   && { (has yara || "${PIRE_PYTHON:-python3}" -c "import yara" 2>/dev/null) && log_done "yara" || log_error "yara not installed"; }
[ "$INSTALL_GHIDRA" = "1" ] && { (has ghidra || has ghidraRun)                  && log_done "ghidra"                     || log_error "ghidra not installed"; }
[ "$INSTALL_ILSPY" = "1" ]  && { (has ilspycmd || has monodis)                  && log_done "ilspy"                      || log_error "ilspy not installed"; }
[ "$INSTALL_VOLATILITY" = "1" ] && { (has vol || "${PIRE_PYTHON:-python3}" -c "import volatility3" 2>/dev/null) && log_done "volatility" || log_error "volatility not installed"; }
[ "$INSTALL_PYTHON_TOOLS" = "1" ] && {
	"${PIRE_PYTHON:-python3}" -c "import capstone" 2>/dev/null && log_done "capstone" || log_error "capstone not installed"
	"${PIRE_PYTHON:-python3}" -c "import lief" 2>/dev/null     && log_done "lief"     || log_error "lief not installed"
}

# ── Install npm dependencies & link CLI ────────────────────────
SCRIPT_DIR=""
if [ -f "$(dirname "$0")/package.json" ]; then
	SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
elif [ -f "./package.json" ]; then
	SCRIPT_DIR="$(pwd)"
fi

# If no local repo found (e.g. curl | sh), clone one
if [ -z "$SCRIPT_DIR" ] || [ ! -f "$SCRIPT_DIR/package.json" ]; then
	PIRE_INSTALL_DIR="$HOME/.pire"
	if [ -d "$PIRE_INSTALL_DIR/.git" ]; then
		log_step "Updating pire repo..."
		git -C "$PIRE_INSTALL_DIR" pull --ff-only -q 2>/dev/null
	else
		log_step "Cloning pire repo..."
		git clone -q https://github.com/evangit2/pire.git "$PIRE_INSTALL_DIR" 2>/dev/null
	fi
	SCRIPT_DIR="$PIRE_INSTALL_DIR"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
	log_section "Node.js Dependencies"
	log_step "Installing npm dependencies..."
	cd "$SCRIPT_DIR"
	npm install --ignore-scripts </dev/null >/dev/null 2>&1 || npm install </dev/null >/dev/null 2>&1 || log_warn "npm install had issues"
	log_done "npm dependencies installed"

	# Build pi-tui (dist/ is gitignored, must be built locally)
	log_step "Building TUI framework..."
	( cd "$SCRIPT_DIR/packages/tui" && npx tsc -p tsconfig.build.json >/dev/null 2>&1 || npx tsgo -p tsconfig.build.json >/dev/null 2>&1 || log_warn "TUI build had issues" )
	if [ -f "$SCRIPT_DIR/packages/tui/dist/index.js" ]; then
		log_done "TUI framework built"
	else
		log_warn "TUI framework build incomplete — pire may not start"
	fi

	# Link pire CLI
	if [ -f "$SCRIPT_DIR/packages/re-agent/src/cli.ts" ]; then
		log_step "Linking pire CLI..."
		PIRE_WRAPPER="/usr/local/bin/pire"
		if [ -w /usr/local/bin ]; then
			printf '#!/bin/sh\nexec npx tsx "%s/packages/re-agent/src/cli.ts" "$@"\n' "$SCRIPT_DIR" > "$PIRE_WRAPPER"
			chmod +x "$PIRE_WRAPPER"
		else
			sudo sh -c "printf '#!/bin/sh\nexec npx tsx \"$SCRIPT_DIR/packages/re-agent/src/cli.ts\" \"\$@\"\n' > '$PIRE_WRAPPER'" 2>/dev/null
			sudo chmod +x "$PIRE_WRAPPER" 2>/dev/null
		fi
		if has pire 2>/dev/null; then
			log_done "pire command available"
		else
			log_warn "Could not create /usr/local/bin/pire"
		fi
		if ! has tsx 2>/dev/null; then
			log_step "Installing tsx..."
			if [ -w /usr/local/bin ]; then
				npm install -g tsx </dev/null >/dev/null 2>&1
			else
				sudo npm install -g tsx </dev/null >/dev/null 2>&1
			fi
			if ! has tsx 2>/dev/null; then
				log_warn "Install tsx manually: npm install -g tsx"
			fi
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

# ── Persist PATH for user-local bin dirs ──────────────────────
# pip --user installs to ~/.local/bin, dotnet tools to ~/.dotnet/tools
# These need to be on PATH for pire to find frida, ilspycmd, vol, etc.
NEEDS_PROFILE_UPDATE=0
for _dir in "$HOME/.local/bin" "$HOME/.dotnet/tools"; do
	[ -d "$_dir" ] || continue
	for _profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
		[ -f "$_profile" ] || continue
		if ! grep -q "$_dir" "$_profile" 2>/dev/null; then
			printf '\n# Added by pire installer\nexport PATH="%s:$PATH"\n' "$_dir" >> "$_profile"
			NEEDS_PROFILE_UPDATE=1
		fi
	done
done
if [ "$NEEDS_PROFILE_UPDATE" = "1" ]; then
	log_step "Added ~/.local/bin and ~/.dotnet/tools to PATH"
	log_warn "Run 'source ~/.bashrc' (or restart your terminal) for changes to take effect"
fi

# ── Done ──────────────────────────────────────────────────────
log_section "Installation Complete"

echo ""
printf '  \033[0;32m\033[1mpire is ready!\033[0m\n'
echo ""
echo "  Next steps:"
echo ""
echo "    1. Configure your model provider:"
echo "       pire model"
echo ""
echo "       This opens an interactive selector where you can:"
echo "         - Add providers (OpenAI, Ollama, custom endpoints, etc.)"
echo "         - Fetch and select models from the provider"
echo "         - Set context_length and max_tokens"
echo ""
echo "    2. Start pire:"
echo "       pire                              # start chat (Pi TUI)"
echo "       pire -cli                         # plain CLI mode"
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
