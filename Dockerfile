# pire — Reverse Engineering Agent
# Build: docker build -t pire .
# Run:   docker run -it --rm -v $(pwd):/workspace pire /workspace/binary.exe
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=UTC
ENV PIRE_DOCKER=1

# ── Base system deps ──────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl wget git unzip sudo bash ca-certificates \
        default-jdk maven \
        gcc binutils file \
        python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 (NodeSource — Ubuntu 24.04 ships Node 18) ─────
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Create non-root user ──────────────────────────────────────
RUN useradd -m -s /bin/bash pireuser \
    && echo "pireuser ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# ── Copy pire source into image ───────────────────────────────
COPY --chown=pireuser:pireuser . /home/pireuser/pire

USER pireuser
WORKDIR /home/pireuser/pire

# ── Install pire using its own installer ──────────────────────
# Core tools + Ghidra. Users can install Wine/ILSpy/etc. inside the
# container if needed — keeps the image lean.
RUN ./install.sh --core --no-tests 2>&1 || true
# Install Ghidra separately (not part of --core)
RUN cd /home/pireuser/pire && \
    export GHIDRA_VER=11.1.2 && \
    export GHIDRA_DATE=20240709 && \
    curl -fsSL "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VER}_build/ghidra_${GHIDRA_VER}_PUBLIC_${GHIDRA_DATE}.zip" -o /tmp/ghidra.zip && \
    sudo unzip -q -o /tmp/ghidra.zip -d /opt/ && \
    sudo ln -sf /opt/ghidra_${GHIDRA_VER}_PUBLIC/ghidraRun /usr/local/bin/ghidra && \
    rm /tmp/ghidra.zip && \
    GHIDRA_DIR=/opt/ghidra_11.1.2_PUBLIC && \
    GHIDRA_VERSION=11.1.2 && \
    cd packages/ghidra-mcp && \
    sed -i "s|<ghidra.version>.*</ghidra.version>|<ghidra.version>${GHIDRA_VERSION}</ghidra.version>|" pom.xml && \
    bash ghidra-mcp-setup.sh --setup-deps --ghidra-path "$GHIDRA_DIR" >/dev/null 2>&1 || true && \
    mvn clean package -DskipTests -q 2>&1 || true

# ── Workspace mount point ─────────────────────────────────────
# Users mount their binaries here:
#   docker run -it --rm -v $(pwd):/workspace pire /workspace/malware.exe
USER root
RUN mkdir -p /workspace && chown pireuser:pireuser /workspace
RUN ln -sf /usr/local/bin/pire /usr/bin/pire 2>/dev/null || true

USER pireuser
WORKDIR /workspace

ENTRYPOINT ["pire"]
CMD ["--help"]
