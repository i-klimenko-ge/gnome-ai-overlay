#!/usr/bin/env bash
set -euo pipefail

UUID="ai-overlay@example.com"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"

log(){ printf "[ai-overlay] %s\n" "$*"; }

# 1) Disable the extension
log "Disabling $UUID"
gnome-extensions disable "$UUID" || true

if [[ "${XDG_SESSION_TYPE:-}" == "x11" ]]; then
  # 2) Xorg: restart GNOME Shell over D-Bus (Alt+F2 r equivalent)
  log "Xorg session detected — restarting GNOME Shell"
  # try reexec first, then Meta.restart fallback
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval 'global.reexec_self();' >/dev/null 2>&1 || \
  gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.gnome.Shell.Eval 'Meta.restart("Restarting from script");' >/dev/null 2>&1 || true

  # Wait until Shell is responsive again
  log "Waiting for GNOME Shell to come back..."
  for _ in {1..60}; do
    if gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
         --method org.gnome.Shell.Eval '""' >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
else
  # Wayland: can’t restart the Shell non-interactively; touch files to bust ESM cache
  log "Wayland session detected — touching files to force reload"
  touch "$EXT_DIR/extension.js" "$EXT_DIR/metadata.json" "$EXT_DIR/stylesheet.css" 2>/dev/null || true
  sleep 1
fi

# 3) Re-enable the extension
log "Enabling $UUID"
gnome-extensions enable "$UUID" || true

# Optional: ping your D-Bus service to confirm it’s up
if gdbus call --session --dest org.example.AIOverlay \
     --object-path /org/example/AIOverlay \
     --method org.example.AIOverlay.Ping >/dev/null 2>&1; then
  log "Overlay D-Bus is up."
else
  log "Overlay D-Bus not up yet (that’s fine right after enable)."
fi
