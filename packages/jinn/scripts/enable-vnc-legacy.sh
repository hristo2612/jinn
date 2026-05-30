#!/usr/bin/env bash
# Enable Apple screensharingd LEGACY VNC auth (security type 2) so noVNC's RFB
# password path works, and set the 8-char password to match the gateway secret.
#
# Reads the password from ~/.jinn/secrets/api-keys.json (key: vncPassword) so the
# value on the Mac matches what the gateway's VNC proxy uses. Generate it first by
# starting the gateway once (server-side) or set it manually in that file.
#
# Requires sudo. Run on the Mac mini (the machine being controlled).
set -euo pipefail

SECRETS="$HOME/.jinn/secrets/api-keys.json"
PW="$(node -e 'try{const j=require(process.env.HOME+"/.jinn/secrets/api-keys.json");process.stdout.write(j.vncPassword||"")}catch{process.stdout.write("")}')"
if [ -z "$PW" ]; then
  echo "ERROR: no vncPassword in $SECRETS — set an 8-char password there first." >&2
  exit 1
fi
if [ "${#PW}" -gt 8 ]; then
  echo "ERROR: vncPassword is longer than 8 chars (legacy VNC limit)." >&2
  exit 1
fi

KS="/System/Library/CoreServices/RemoteManagement/ARDAgent.app/Contents/Resources/kickstart"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo ">> Enabling ARD/VNC legacy with the gateway's password (sudo required)..."
sudo "$KS" -activate -configure \
  -clientopts -setvnclegacy -vnclegacy yes \
  -clientopts -setvncpw -vncpw "$PW" \
  -restart -agent -privs -all

echo ">> Re-probing security types (expect a 2 to appear)..."
if node "$HERE/rfb-probe.mjs"; then
  echo ">> SUCCESS: type 2 present. The takeover bridge will authenticate."
else
  echo ""
  echo ">> Type 2 did NOT appear. kickstart did not enable legacy VNC on this macOS build."
  echo ">> Manual fallback: System Settings → General → Sharing → Screen Sharing (i) →"
  echo "   'VNC viewers may control screen with password' → set the SAME 8-char password,"
  echo "   then re-run: node $HERE/rfb-probe.mjs"
  echo ">> If type 2 still absent, fall back to D1-Option-A (client-side password). STOP and report."
  exit 2
fi
