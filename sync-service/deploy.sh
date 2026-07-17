#!/bin/bash
# ============================================================
# Wallgarden Sync Service — Build & Deploy to Synology NAS
#
# Thin wrapper — all logic lives in ../../deploy-kit/lib.sh
# ============================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="wallgarden-sync"
DISPLAY_NAME="🔄 Wallgarden Sync"

source "${SCRIPT_DIR}/../../deploy-kit/lib.sh"
