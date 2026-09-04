#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT_DIR"

MODE="--sim"
MODE_SELECTED=0
MAP_PATH=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --mapping|--navigation|--exploration|--base|--ros|--sim)
      if [[ "$MODE_SELECTED" == "1" ]]; then
        echo "起動構成は1つだけ指定してください。" >&2
        exit 2
      fi
      if [[ "$1" == "--base" ]]; then MODE="--ros"; else MODE="$1"; fi
      MODE_SELECTED=1
      ;;
    --map)
      shift
      if [[ "$#" -eq 0 ]]; then
        echo "--map の後にyamlファイルを指定してください。" >&2
        exit 2
      fi
      MAP_PATH="$1"
      ;;
    *)
      echo "使い方: ./run.sh [--sim|--ros|--mapping|--navigation|--exploration] [--map PATH]" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -n "$MAP_PATH" && "$MODE" != "--navigation" ]]; then
  echo "--mapは--navigationでのみ使用できます。" >&2
  exit 2
fi

start_args=("$MODE")
if [[ -n "$MAP_PATH" ]]; then start_args+=(--map "$MAP_PATH"); fi
exec ./start.sh "${start_args[@]}"
