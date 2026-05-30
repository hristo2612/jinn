#!/usr/bin/env bash
# Restrict VNC (port 5900) to localhost so only the gateway (127.0.0.1 → screensharingd)
# can reach it — the tailnet (utun*) and LAN are blocked. The takeover still works
# because it rides the gateway WebSocket, not a direct 5900 connection.
#
# FIX 1: the rule is scoped `on !lo0`. A bare `from any to any port 5900` would also
# match loopback and sever the gateway's own connection, breaking takeover.
#
# Requires sudo. Reversible (see REVERT below). Reboot-persistence via the companion
# LaunchDaemon com.jinn.pf-5900.plist.
set -euo pipefail

ANCHOR="/etc/pf.anchors/com.jinn.vnc"

echo ">> Writing pf anchor $ANCHOR ..."
echo "block in quick on !lo0 proto tcp from any to any port 5900" | sudo tee "$ANCHOR" >/dev/null

if ! grep -q 'com.jinn.vnc' /etc/pf.conf; then
  echo ">> Registering anchor in /etc/pf.conf ..."
  echo 'anchor "com.jinn.vnc"' | sudo tee -a /etc/pf.conf >/dev/null
  echo 'load anchor "com.jinn.vnc" from "/etc/pf.anchors/com.jinn.vnc"' | sudo tee -a /etc/pf.conf >/dev/null
fi

echo ">> Loading + enabling pf ..."
sudo pfctl -f /etc/pf.conf -e 2>/dev/null || sudo pfctl -f /etc/pf.conf

echo ">> Done. 5900 is now blocked on non-loopback interfaces."
echo ">> VERIFY (a) takeover still works (gateway → 127.0.0.1:5900 open)."
echo ">> VERIFY (b) from another machine: 'nc -vz <this-mac>.tailnet 5900' must be refused."
echo ""
echo ">> REVERT:"
echo "   sudo sed -i '' '/com.jinn.vnc/d' /etc/pf.conf"
echo "   sudo rm -f $ANCHOR"
echo "   sudo pfctl -f /etc/pf.conf"
