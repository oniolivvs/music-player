#!/usr/bin/env bash
# Music Player — cross-distro installer.
#
#   curl -fsSL https://raw.githubusercontent.com/oniolivvs/music-player/main/install.sh | bash
#
# Picks the right artifact from the latest GitHub release for your package
# manager (.deb / .rpm), or falls back to the universal AppImage on any distro.
# Env: MP_VERSION=vX.Y.Z to pin a version, GITHUB_TOKEN=... for a private repo.
set -euo pipefail

REPO="oniolivvs/music-player"
APP="music-player"
API="https://api.github.com/repos/${REPO}/releases"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")

say() { printf '\033[1;35m::\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have curl || die "curl is required."

# --- pick the release ---
if [ -n "${MP_VERSION:-}" ]; then
  REL_URL="${API}/tags/${MP_VERSION}"
else
  REL_URL="${API}/latest"
fi
say "Fetching release info…"
JSON=$(curl -fsSL "${AUTH[@]}" "$REL_URL") || die "cannot reach GitHub (private repo? set GITHUB_TOKEN)."

# Grab every asset download URL.
mapfile -t ASSETS < <(printf '%s' "$JSON" | grep -oE '"browser_download_url"[^,]*' | cut -d'"' -f4)
[ "${#ASSETS[@]}" -gt 0 ] || die "no downloadable assets in the release yet — build one first (push a tag)."

arch=$(uname -m)
case "$arch" in
  x86_64|amd64) DEB_ARCH="amd64"; RPM_ARCH="x86_64" ;;
  aarch64|arm64) DEB_ARCH="arm64"; RPM_ARCH="aarch64" ;;
  *) DEB_ARCH="$arch"; RPM_ARCH="$arch" ;;
esac

pick() { # pick <regex>
  local re="$1" a
  for a in "${ASSETS[@]}"; do [[ "$a" =~ $re ]] && { printf '%s' "$a"; return 0; }; done
  return 1
}

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
download() { say "Downloading $(basename "$1")"; curl -fL --progress-bar "${AUTH[@]}" -o "$2" "$1"; }

# --- native package first, AppImage as the universal fallback ---
if have apt-get && url=$(pick "\.deb$"); then
  f="$TMP/pkg.deb"; download "$url" "$f"
  say "Installing with apt (sudo)…"; sudo apt-get install -y "$f"
  say "Done — launch it from your app menu or run: $APP"
elif { have dnf || have yum; } && url=$(pick "\.rpm$"); then
  f="$TMP/pkg.rpm"; download "$url" "$f"
  say "Installing with dnf (sudo)…"; sudo "$(have dnf && echo dnf || echo yum)" install -y "$f"
  say "Done — launch it from your app menu or run: $APP"
elif have zypper && url=$(pick "\.rpm$"); then
  f="$TMP/pkg.rpm"; download "$url" "$f"
  say "Installing with zypper (sudo)…"; sudo zypper --non-interactive install --allow-unsigned-rpm "$f"
  say "Done — launch it from your app menu or run: $APP"
else
  # Any other distro (Arch, NixOS, immutable, …): the portable AppImage.
  url=$(pick "\.AppImage$") || die "no AppImage in this release for the fallback install."
  say "No matching native package — using the portable AppImage."
  mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/256x256/apps"
  dest="$HOME/.local/bin/${APP}.AppImage"
  download "$url" "$dest"; chmod +x "$dest"
  cat > "$HOME/.local/share/applications/${APP}.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Music Player
Comment=Local-first music player with YouTube search, streaming and downloads
Exec=${dest} %U
Icon=${APP}
Terminal=false
Categories=AudioVideo;Audio;Player;
EOF
  say "Installed to ${dest}"
  case ":$PATH:" in *":$HOME/.local/bin:"*) : ;; *) say "Add ~/.local/bin to your PATH to run '${APP}.AppImage' from anywhere." ;; esac
  say "Done — find “Music Player” in your app menu, or run: ${dest}"
fi
