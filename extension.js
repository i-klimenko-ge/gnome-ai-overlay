'use strict';

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta'; // на будущее
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as ByteArray from 'resource:///org/gnome/gjs/modules/byteArray.js';

const BUS_NAME = 'org.example.AIOverlay';
const OBJ_PATH = '/org/example/AIOverlay';
const IFACE = 'org.example.AIOverlay';
const IFACE_XML = `
<node>
  <interface name="${IFACE}">
    <method name="SetState"><arg type="s" name="state" direction="in"/></method>
    <method name="GetState"><arg type="s" name="state" direction="out"/></method>
    <method name="Show"/>
    <method name="Hide"/>
    <method name="Ping"><arg type="s" name="reply" direction="out"/></method>
  </interface>
</node>`;

const DEFAULT_CONFIG = {
  dotSize: 12,
  padding: [6, 10],
  margin: 24,
  position: 'top-right',
  font: '600 11pt sans-serif',
  pulseScale: 1.06,
  listeningPeriod: 700,
  thinkingPeriod: 1100,
};

function loadConfig(dir) {
  try {
    const file = dir.get_child('config.json');
    if (file?.query_exists(null)) {
      const [ok, bytes] = file.load_contents(null);
      if (ok) {
        const cfg = JSON.parse(ByteArray.toString(bytes));
        return { ...DEFAULT_CONFIG, ...cfg };
      }
    }
  } catch (e) {
    logError(e, '[ai-overlay] loadConfig');
  }
  return { ...DEFAULT_CONFIG };
}

class Overlay {
  constructor(cfg) {
    this._cfg = cfg;
    this._box = null; this._dot = null; this._label = null;
    this._pulse = 0; this._state = 'idle';
    this._monitorMgr = null; this._monitorsChangedId = 0;
  }

  enable() {
    log('[ai-overlay] overlay.enable');
    this._build();
    this._reposition();

    // GNOME 46: слушаем изменения конфигурации мониторов через MonitorManager
    this._monitorMgr = global.display.get_monitor_manager?.() ?? null;
    if (this._monitorMgr?.connect) {
      this._monitorsChangedId = this._monitorMgr.connect('monitors-changed', () => this._reposition());
    } else {
      log('[ai-overlay] monitor-manager not found; skip monitors-changed');
    }

    // мягкий «пинг», чтобы увидеть, что живо
    this.setState('listening');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => {
      this.setState('idle');
      return GLib.SOURCE_REMOVE;
    });
  }

  disable() {
    log('[ai-overlay] overlay.disable');
    this._stopPulse();
    if (this._monitorMgr && this._monitorsChangedId) {
      this._monitorMgr.disconnect(this._monitorsChangedId);
      this._monitorsChangedId = 0;
    }
    this._monitorMgr = null;
    this._box?.destroy(); this._box = this._dot = this._label = null;
  }

  _build() {
    const pad = Array.isArray(this._cfg.padding) ? `${this._cfg.padding[0]}px ${this._cfg.padding[1]}px` : `${this._cfg.padding}px`;
    this._box = new St.BoxLayout({ style_class: 'ai-overlay', reactive: false });
    this._box.set_pivot_point(0.5, 0.5);
    this._box.set_style(`padding:${pad};`);

    const size = this._cfg.dotSize;
    this._dot = new St.Widget({ style_class: 'ai-dot', reactive: false });
    this._dot.set_style(`width:${size}px;height:${size}px;`);

    this._label = new St.Label({ text: '', style_class: 'ai-label', reactive: false });
    this._label.set_style(`font:${this._cfg.font};`);

    this._box.add_child(this._dot); this._box.add_child(this._label);
    global.stage.add_child(this._box);
    this._box.hide();
  }

  _raise() {
    // поднимаем поверх всех детей stage
    if (this._box?.get_parent() === global.stage)
      global.stage.set_child_above_sibling(this._box, null);
  }

  _reposition() {
    const d = global.display;
    const idx = d.get_primary_monitor();
    const rect = d.get_monitor_geometry(idx);
    let mx, my;
    if (Array.isArray(this._cfg.margin)) [mx, my] = this._cfg.margin; else mx = my = this._cfg.margin;
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!this._box) return GLib.SOURCE_REMOVE;
      switch (this._cfg.position) {
        case 'top-left':
          this._box.set_position(rect.x + mx, rect.y + my); break;
        case 'bottom-left':
          this._box.set_position(rect.x + mx, rect.y + rect.height - this._box.height - my); break;
        case 'bottom-right':
          this._box.set_position(rect.x + rect.width - this._box.width - mx, rect.y + rect.height - this._box.height - my); break;
        default:
          this._box.set_position(rect.x + rect.width - this._box.width - mx, rect.y + my); break;
      }
      return GLib.SOURCE_REMOVE;
    });
  }

  _stopPulse() {
    if (this._pulse) { GLib.source_remove(this._pulse); this._pulse = 0; }
    if (this._box) { this._box.scale_x = 1; this._box.scale_y = 1; }
  }

  _startPulse(period) {
    this._stopPulse();
    const half = Math.max(150, Math.floor(period/2));
    const tick = () => {
      if (!this._box) return GLib.SOURCE_REMOVE;
      this._box.ease({
        scale_x: this._cfg.pulseScale, scale_y: this._cfg.pulseScale, duration: half,
        mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        onComplete: () => this._box?.ease({
          scale_x: 1, scale_y: 1, duration: half,
          mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD
        })
      });
      return GLib.SOURCE_CONTINUE;
    };
    this._pulse = GLib.timeout_add(GLib.PRIORITY_DEFAULT, period, tick);
    tick();
  }

  _apply() {
    if (!this._box) return;
    this._dot.remove_style_class_name('listening');
    this._dot.remove_style_class_name('thinking');
    this._dot.remove_style_class_name('error');
    this._box.remove_style_class_name('ai-overlay-error');

    switch (this._state) {
      case 'idle':
        this._label.text = ''; this._stopPulse(); this.hide(); break;
      case 'listening':
        this._label.text = 'Слушаю…'; this._dot.add_style_class_name('listening'); this._startPulse(this._cfg.listeningPeriod); this.show(); break;
      case 'thinking':
        this._label.text = 'Думаю…'; this._dot.add_style_class_name('thinking'); this._startPulse(this._cfg.thinkingPeriod); this.show(); break;
      case 'error':
        this._label.text = 'Ошибка'; this._dot.add_style_class_name('error'); this._box.add_style_class_name('ai-overlay-error');
        this._stopPulse(); this.show(); this._box.opacity = 180;
        this._box.ease({ opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD }); break;
    }
    this._reposition();
    this._raise();
  }

  setState(s) {
    s = String(s).toLowerCase();
    if (!['idle','listening','thinking','error'].includes(s)) { log(`[ai-overlay] unknown state ${s}`); return; }
    this._state = s; this._apply();
  }
  getState() { return this._state; }

  show() {
    if (!this._box) return;
    this._box.opacity = 0; this._box.show();
    this._raise();
    this._box.ease({ opacity: 255, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
  }
  hide() {
    if (!this._box) return;
    this._box.ease({
      opacity: 0, duration: 120, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => this._box && this._box.hide()
    });
  }
}

class DBusController {
  constructor(overlay) { this._overlay = overlay; this._nameId = 0; this._exported = null; this._conn = null; this._regId = 0; }

  enable() {
    log('[ai-overlay] dbus.enable');
    try {
      const busAcquired = (conn) => {
        this._conn = conn;
        if (Gio.DBusExportedObject?.wrapJSObject) {
          const impl = {
            SetState: (state) => { this._overlay.setState(state); },
            GetState: () => this._overlay.getState(),
            Show: () => { this._overlay.show(); },
            Hide: () => { this._overlay.hide(); },
            Ping: () => 'ok',
          };
          this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, impl);
          this._exported.export(conn, OBJ_PATH);
        } else {
          const node = Gio.DBusNodeInfo.new_for_xml(IFACE_XML);
          const iface = node.lookup_interface(IFACE);
          const vtable = {
            method_call: (conn, sender, path, ifaceName, method, params, inv) => {
              try {
                switch (method) {
                  case 'SetState': this._overlay.setState(params.deepUnpack()[0]); inv.return_value(null); break;
                  case 'GetState': inv.return_value(GLib.Variant.new_tuple(GLib.Variant.new_string(this._overlay.getState()))); break;
                  case 'Show': this._overlay.show(); inv.return_value(null); break;
                  case 'Hide': this._overlay.hide(); inv.return_value(null); break;
                  case 'Ping': inv.return_value(GLib.Variant.new_tuple(GLib.Variant.new_string('ok'))); break;
                  default: inv.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod','Unknown'); break;
                }
              } catch (e) { logError(e, '[ai-overlay] dbus method'); inv.return_dbus_error('org.example.AIOverlay.Error', String(e)); }
            }
          };
          this._regId = conn.register_object(OBJ_PATH, iface, vtable);
        }
        log(`[ai-overlay] D-Bus exported as ${BUS_NAME}`);
      };

      this._nameId = Gio.DBus.own_name(
        Gio.BusType.SESSION,
        BUS_NAME,
        Gio.BusNameOwnerFlags.REPLACE,
        busAcquired,
        null,
        (conn, name) => log(`[ai-overlay] name lost: ${name}`)
      );
    } catch (e) {
      logError(e, '[ai-overlay] dbus.enable error');
    }
  }

  disable() {
    log('[ai-overlay] dbus.disable');
    try {
      if (this._exported) { this._exported.unexport(); this._exported = null; }
      if (this._conn && this._regId) { this._conn.unregister_object(this._regId); this._regId = 0; }
      if (this._nameId) { Gio.DBus.unown_name(this._nameId); this._nameId = 0; }
      this._conn = null;
    } catch (e) { logError(e, '[ai-overlay] dbus.disable error'); }
  }
}

export default class AiOverlayExtension extends Extension {
  enable() {
    log('[ai-overlay] extension.enable');
    this._config = loadConfig(this.dir);
    this._overlay = new Overlay(this._config); this._overlay.enable();
    this._dbus = new DBusController(this._overlay); this._dbus.enable();
  }
  disable() {
    log('[ai-overlay] extension.disable');
    this._dbus?.disable(); this._dbus = null;
    this._overlay?.disable(); this._overlay = null;
  }
}
