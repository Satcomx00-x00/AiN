#!/usr/bin/env bash
# System libraries and tools to build, package (.rpm) and launch-check the Tauri app on Fedora
# (x64), the counterpart of linux-deps.sh. Runs as root in a `fedora` container, or with sudo.
# Node.js too: vitest runs on Node, as on the hosted runners (Bun, standing in for a missing
# Node, imports modules from data: URLs differently).
set -euo pipefail

SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO=sudo

$SUDO dnf install -y --setopt=install_weak_deps=False \
  gcc \
  gcc-c++ \
  make \
  cmake \
  pkgconf-pkg-config \
  clang \
  clang-devel \
  git \
  curl \
  unzip \
  nodejs \
  xz \
  file \
  patchelf \
  python3-pip \
  rpm-build \
  webkit2gtk4.1-devel \
  gtk3-devel \
  gtk-layer-shell-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  openssl-devel \
  alsa-lib-devel \
  libxdo-devel \
  dbus-devel \
  pipewire-devel \
  wayland-devel \
  mesa-libgbm-devel \
  mesa-libEGL-devel \
  libxcb-devel \
  libXrandr-devel \
  xorg-x11-server-Xvfb \
  xdpyinfo \
  xwininfo \
  dbus-x11 \
  ImageMagick \
  procps-ng
