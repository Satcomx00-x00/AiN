#!/usr/bin/env bash
# System libraries needed to build the Tauri app on Debian/Ubuntu (x64).
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  build-essential \
  pkg-config \
  clang \
  libclang-dev \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libgtk-layer-shell-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libssl-dev \
  libxdo-dev \
  libdbus-1-dev \
  libpipewire-0.3-dev \
  libspa-0.2-dev \
  libwayland-dev \
  libgbm-dev \
  libegl-dev \
  libxcb1-dev \
  libxcb-randr0-dev \
  libxcb-shm0-dev \
  libxrandr-dev \
  file \
  patchelf
