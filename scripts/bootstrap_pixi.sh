#!/usr/bin/env bash
set -euo pipefail

# Official immutable release; hashes verified against its SHA-256 assets and API digests.
# https://github.com/prefix-dev/pixi/releases/tag/v0.77.0
PIXI_VERSION="0.77.0"
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)
    artifact="pixi-aarch64-apple-darwin.tar.gz"
    expected_sha256="38d3ba48f9c380dd6826750eec0d764d13993514dcd1afce4e3f0d3c9cabc3f6" ;;
  Darwin/x86_64)
    artifact="pixi-x86_64-apple-darwin.tar.gz"
    expected_sha256="519b99560af96f1f4a3c57f175bea7c43fa43b558130ea1b2fef28e26353d4b5" ;;
  Linux/aarch64)
    artifact="pixi-aarch64-unknown-linux-musl.tar.gz"
    expected_sha256="aef3e420bc27a62a1b546890c0846ff2bb08496fba93b1ea5f20cd131be371e9" ;;
  Linux/x86_64)
    artifact="pixi-x86_64-unknown-linux-musl.tar.gz"
    expected_sha256="bff2f77ef23178f0c73c7ddbc90ca57c68f8b75a5bd85ce8e7404f33b32852d5" ;;
  *) echo "Pixi bootstrap: 未対応のOSまたはarchitectureです。" >&2; exit 1 ;;
esac

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "SHA-256検証コマンドが見つかりません。" >&2
    return 1
  fi
}

# Private temporary directory; no downloaded bytes are extracted or executed before verification.
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/ros2-visual-starter-pixi.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
archive="$work_dir/pixi.tar.gz"
curl -fsSL --retry 3 --retry-delay 1 --connect-timeout 15 --max-time 300 \
  --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$archive" \
  "https://github.com/prefix-dev/pixi/releases/download/v${PIXI_VERSION}/${artifact}"
actual_sha256="$(sha256_file "$archive")"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "Pixi checksumが一致しません。展開・実行を中止しました。" >&2
  exit 1
fi

tar -xzf "$archive" -C "$work_dir" pixi
if [[ ! -f "$work_dir/pixi" || -L "$work_dir/pixi" || ! -x "$work_dir/pixi" ]]; then
  echo "Pixi archiveに通常の実行ファイルがありません。" >&2
  exit 1
fi
if [[ "$("$work_dir/pixi" --version)" != "pixi ${PIXI_VERSION}" ]]; then
  echo "Pixiのversionが検証基準と一致しません。" >&2
  exit 1
fi
mkdir -p "${HOME}/.pixi/bin"
# Stage on the destination filesystem, then atomically replace the binary.
install_target="$(mktemp "${HOME}/.pixi/bin/.pixi.XXXXXX")"
trap 'rm -rf "$work_dir"; rm -f "$install_target"' EXIT
install -m 755 "$work_dir/pixi" "$install_target"
mv -f "$install_target" "${HOME}/.pixi/bin/pixi"
echo "Pixi ${PIXI_VERSION}: SHA-256検証後にuser領域へ導入しました。"
