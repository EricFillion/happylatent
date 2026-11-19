#!/bin/sh
set -eu

agent_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
export HAPPYLATENT_NODE_ROOT="$agent_dir/../.."
if [ "$#" -eq 0 ]; then
  set -- setup
fi

node_ready() {
  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 22 ? 1 : 0)'
}

if ! node_ready; then
  node_version=v24.15.0
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64; checksum=372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4 ;;
    Darwin-x86_64) platform=darwin-x64; checksum=ffd5ee293467927f3ee731a553eb88fd1f48cf74eebc2d74a6babe4af228673b ;;
    Linux-aarch64) platform=linux-arm64; checksum=73afc234d558c24919875f51c2d1ea002a2ada4ea6f83601a383869fefa64eed ;;
    Linux-x86_64) platform=linux-x64; checksum=44836872d9aec49f1e6b52a9a922872db9a2b02d235a616a5681b6a85fec8d89 ;;
    *) printf '%s\n' 'Install Node.js 22+ and npm to continue on this platform.' >&2; exit 1 ;;
  esac
  tools_dir="${HAPPYLATENT_STATE_DIR:-$HOME/.happylatent-agent}/tools"
  distribution="node-$node_version-$platform"
  if [ ! -x "$tools_dir/$distribution/bin/node" ]; then
    mkdir -p "$tools_dir"
    download_dir=$(mktemp -d "$tools_dir/download.XXXXXX")
    trap 'rm -rf "$download_dir"' EXIT
    archive="$distribution.tar.gz"
    printf 'Installing Node.js %s into %s\n' "$node_version" "$tools_dir" >&2
    curl --fail --silent --show-error --location --retry 2 \
      "https://nodejs.org/dist/$node_version/$archive" -o "$download_dir/$archive"
    (cd "$download_dir" && printf '%s  %s\n' "$checksum" "$archive" | shasum -a 256 --check)
    tar -xzf "$download_dir/$archive" -C "$download_dir"
    mv -n "$download_dir/$distribution" "$tools_dir/"
    rm -rf "$download_dir"
    trap - EXIT
  fi
  PATH="$tools_dir/$distribution/bin:$PATH"
  export PATH
fi

lock_checksum=$(shasum -a 256 "$agent_dir/package-lock.json" | cut -d ' ' -f 1)
stamp="$agent_dir/node_modules/.happylatent-lock"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock_checksum" ] ||
   [ ! -f "$agent_dir/node_modules/@modelcontextprotocol/sdk/package.json" ] ||
   [ ! -f "$agent_dir/node_modules/zod/package.json" ]; then
  (cd "$agent_dir" && npm ci --ignore-scripts --no-audit --no-fund) >&2
  printf '%s\n' "$lock_checksum" > "$stamp"
fi
node "$agent_dir/prepare-resources.mjs"
exec node "$agent_dir/cli.mjs" "$@"
