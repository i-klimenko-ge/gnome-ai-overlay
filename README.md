# AI Overlay GNOME Extension

AI Overlay is a GNOME Shell extension that displays a small indicator on the screen and exposes a D-Bus interface for controlling its state (`idle`, `listening`, `thinking` and `error`).

## Installation

1. Copy or symlink the contents of this repository to `~/.local/share/gnome-shell/extensions/ai-overlay@example.com`.
2. Make the restart script executable:
   ```bash
   chmod +x restart.sh
   ```

## Running and Restarting

Reload the extension after making changes or installing it:
```bash
./restart.sh
```
The script disables and re-enables the extension using `gnome-extensions`.

## Controlling the Overlay

The extension registers a D-Bus service `org.example.AIOverlay` on the session bus at `/org/example/AIOverlay`.
To change its state, you can call:
```bash
gdbus call --session --dest org.example.AIOverlay --object-path /org/example/AIOverlay --method org.example.AIOverlay.SetState "listening"
```
Replace `listening` with `thinking`, `error` or `idle` to try other modes.

