#!/bin/sh
# Stable entry point for people and agents installing from a repository clone.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
case "${1-}" in
  '') set -- setup ;;
  --help|-h) ;;
  --*) set -- setup "$@" ;;
esac

exec sh "$repo_dir/integrations/agent/install.sh" "$@"
