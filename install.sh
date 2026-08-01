#!/bin/sh
# pire install script — sets up the development environment on a fresh machine.
# Supports: Ubuntu/Debian, Fedora/RHEL, Arch Linux, macOS (Homebrew)
# Idempotent: safe to run multiple times.

set -e

# ─── Helpers ──────────────────────────────────────────────────

info()  { printf "\033[1;34m==>\033[0m %s\n" "$1"; }
ok()    { printf "\033[1;32m  ✓\033[0m %s\n" "$1"; }
warn()  { printf "\033[1;33m  !\033[0m %s\n" "$1"; }
fail()  { printf "\033[1;31m  ✗\033[0m %s\n" "$1"; exit 1; }

has() { command -v "$1" >/dev/null 2>&1; }

# ─── Detect OS ────────────────────────────────────────────────

OS=""
if [ -f /etc/os-release ]; then
    . /etc/os-release
    case "$ID" in
        ubuntu|debian|linuxmint|pop) OS="debian" ;;
        fedora|rhel|centos|rocky|alma) OS="fedora" ;;
        arch|manjaro|endeavouros) OS="arch" ;;
        *) OS="$ID" ;;
    esac
elif has brew; then
    OS="macos"
elif [ "$(uname)" = "Darwin" ]; then
    OS="macos"
fi

if [ -z "$OS" ]; then
    fail "Could not detect OS. Please install dependencies manually."
fi

info "Detected OS: $OS"

# ─── Install packages per OS ──────────────────────────────────

install_debian() {
    info "Installing packages (Ubuntu/Debian)..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        nodejs npm \
        gcc-mingw-w64-x86-64 \
        wine64 wine \
        radare2 \
        git build-essential \
        2>/dev/null || warn "Some packages may not be available"
    
    # Install Node 22 if the system version is too old
    NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
    if [ "$NODE_VER" -lt 22 ]; then
        warn "System Node.js is v$NODE_VER, installing Node 22 via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y -qq nodejs
    fi
}

install_fedora() {
    info "Installing packages (Fedora/RHEL)..."
    sudo dnf install -y \
        nodejs npm \
        mingw64-gcc \
        wine \
        radare2 \
        git gcc make \
        2>/dev/null || warn "Some packages may not be available"
    
    NODE_VER=$(node -v 2>/dev/null | sed 's/v//' | cut -d. -f1 || echo "0")
    if [ "$NODE_VER" -lt 22 ]; then
        warn "System Node.js is v$NODE_VER, installing Node 22..."
        curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
        sudo dnf install -y nodejs
    fi
}

install_arch() {
    info "Installing packages (Arch Linux)..."
    sudo pacman -S --noconfirm \
        nodejs npm \
        mingw-w64-gcc \
        wine \
        radare2 \
        git base-devel \
        2>/dev/null || warn "Some packages may not be available"
}

install_macos() {
    info "Installing packages (macOS)..."
    
    if ! has brew; then
        warn "Homebrew not found. Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    fi
    
    brew install node radare2 wine mingw-w64 git
    
    # Wine on macOS via Apple Silicon may need a different approach
    if ! has wine64 && ! has wine; then
        warn "Wine not available via Homebrew. Try: brew install --cask wine-stable"
    fi
}

case "$OS" in
    debian) install_debian ;;
    fedora) install_fedora ;;
    arch)   install_arch ;;
    macos)  install_macos ;;
    *)      fail "Unsupported OS: $OS. Please install dependencies manually." ;;
esac

# ─── Verify installations ─────────────────────────────────────

info "Verifying installations..."

has node       && ok "Node.js $(node -v)" || fail "Node.js not installed"
has npm        && ok "npm $(npm -v)"      || fail "npm not installed"
has git        && ok "git $(git --version | head -1)" || fail "git not installed"
has gcc        && ok "gcc $(gcc -dumpversion)" || fail "gcc not installed"
has r2         && ok "radare2 $(r2 -v 2>/dev/null | head -1)" || warn "radare2 not installed (some features unavailable)"
has wine       && ok "wine" || has wine64 && ok "wine64" || warn "wine not installed (cannot run Windows binaries)"

# Check MinGW cross-compiler
if has x86_64-w64-mingw32-gcc; then
    ok "MinGW-w64 (x86_64) $(x86_64-w64-mingw32-gcc -dumpversion)"
else
    warn "MinGW-w64 not installed (cannot compile Windows binaries)"
fi

# ─── Setup Wine prefix ────────────────────────────────────────

WINEPREFIX="${WINEPREFIX:-$HOME/.wine}"
if [ ! -d "$WINEPREFIX" ]; then
    info "Initializing Wine prefix at $WINEPREFIX..."
    WINEPREFIX="$WINEPREFIX" wineboot --init 2>/dev/null || warn "Wine init failed (may need display)"
    ok "Wine prefix initialized"
else
    ok "Wine prefix exists at $WINEPREFIX"
fi

# ─── Install npm dependencies ─────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -f "$SCRIPT_DIR/package.json" ]; then
    info "Installing npm dependencies..."
    cd "$SCRIPT_DIR"
    npm install --ignore-scripts 2>/dev/null || npm install 2>/dev/null || warn "npm install had issues"
    ok "npm dependencies installed"
fi

# ─── Run test suite ───────────────────────────────────────────

if [ -f "$SCRIPT_DIR/packages/re-agent/test/test-suite.cjs" ]; then
    info "Running test suite..."
    cd "$SCRIPT_DIR"
    if node packages/re-agent/test/test-suite.cjs 2>&1 | tail -3; then
        ok "Tests passed"
    else
        warn "Some tests failed — check output above"
    fi
fi

# ─── Done ─────────────────────────────────────────────────────

info "Installation complete!"
echo ""
echo "  Next steps:"
echo "    1. Set your LLM API credentials:"
echo "       export OPENAI_API_KEY=\"your-key\""
echo "       export OPENAI_BASE_URL=\"https://api.openai.com/v1\""
echo "       export OPENAI_MODEL=\"gpt-4o\""
echo "    2. Run: pire targets/cfgmerge/cfgmerge.exe"
echo ""

# ─── Optional: install global CLI ─────────────────────────────

if [ -f "$SCRIPT_DIR/packages/re-agent/src/cli.ts" ]; then
    if has pire 2>/dev/null; then
        ok "pire CLI already installed"
    else
        info "To install the global 'pire' command, run:"
        echo "  sudo ln -sf $SCRIPT_DIR/packages/re-agent/src/cli.ts /usr/local/bin/pire"
        echo "  # (requires tsx: npm install -g tsx)"
    fi
fi
