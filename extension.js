'use strict';

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

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

// ---------- CONFIG ----------

const CONFIG_DIR  = GLib.build_filenamev([GLib.get_home_dir(), '.config', 'ai-overlay']);
const CONFIG_PATH = GLib.build_filenamev([CONFIG_DIR, 'config.json']);

const DEFAULTS = {
  corner: 'center',
  offset: { x: 24, y: 24 },
  monitor: 'primary',  // или число (индекс)
  showLabel: true,
  dotSize: 30,
  fontSize: 30,        // pt
  padding: [6, 10],
  radius: 12,
  opacity: 0.26,
  pivot: { x: 0.5, y: 0.5 },
  pulse: {
    enabled: true,
    scale: 1.06,
    periodListening: 700,
    periodThinking: 1100
  },
  colors: {
    bg: 'rgba(20,22,28,0.26)',
    bgError: 'rgba(180,32,32,0.28)',
    text: '#ffffff',
    dotListening: '#6ea8ff',
    dotThinking: '#a78bfa',
    dotError: '#ff6b6b',
    dotIdle: 'rgba(128,128,128,0.9)'
  }
};

function deepMerge(a, b) {
  const out = Array.isArray(a) ? [...a] : {...a};
  for (const [k, v] of Object.entries(b ?? {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = deepMerge(a?.[k] ?? {}, v);
    else out[k] = v;
  }
  return out;
}

function ensureConfigFile() {
  try {
    if (!GLib.file_test(CONFIG_DIR, GLib.FileTest.IS_DIR))
      GLib.mkdir_with_parents(CONFIG_DIR, 0o755);
    if (!GLib.file_test(CONFIG_PATH, GLib.FileTest.IS_REGULAR)) {
      const pretty = JSON.stringify(DEFAULTS, null, 2);
      GLib.file_set_contents(CONFIG_PATH, pretty);
    }
  } catch (e) {
    logError(e, '[ai-overlay] ensureConfigFile failed');
  }
}

function loadConfig() {
  try {
    ensureConfigFile();
    const [ok, bytes] = GLib.file_get_contents(CONFIG_PATH);
    if (!ok) throw new Error('cannot read config');
    const text = ByteArray.toString(bytes);
    const userCfg = JSON.parse(text);
    return deepMerge(DEFAULTS, userCfg);
  } catch (e) {
    logError(e, '[ai-overlay] loadConfig failed, using defaults');
    return DEFAULTS;
  }
}

function watchConfig(onChange) {
  const file = Gio.File.new_for_path(CONFIG_PATH);
  try {
    const mon = file.monitor(Gio.FileMonitorFlags.NONE, null);
    let debounce = 0;
    mon.connect('changed', (_m, _f, _of, evt) => {
      // дебаунс 150 мс
      if (debounce) GLib.source_remove(debounce);
      debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
        onChange();
        debounce = 0;
        return GLib.SOURCE_REMOVE;
      });
    });
    return mon;
  } catch (e) {
    logError(e, '[ai-overlay] watchConfig failed');
    return null;
  }
}

// ---------- OVERLAY ----------

class Overlay {
  constructor() {
    this._box = null; this._dot = null; this._label = null;
    this._pulse = 0; this._state = 'idle';
    this._monitorMgr = null; this._monitorsChangedId = 0;
    this._cfg = DEFAULTS;
    this._cfgMon = null;
  }

  enable() {
    log('[ai-overlay] overlay.enable');
    this._cfg = loadConfig();
    this._cfgMon = watchConfig(() => {
      log('[ai-overlay] config changed -> reapply');
      this._cfg = loadConfig();
      this._applyStyles();
      this._reposition();
    });

    this._build();
    this._applyStyles();
    this._reposition();

    // GNOME 46: слушаем изменения конфигурации мониторов через MonitorManager (если доступен)
    this._monitorMgr = global.display.get_monitor_manager?.() ?? null;
    if (this._monitorMgr?.connect) {
      this._monitorsChangedId = this._monitorMgr.connect('monitors-changed', () => this._reposition());
    }

    // лёгкий пинг на старте
    this.setState('listening');
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 700, () => { this.setState('idle'); return GLib.SOURCE_REMOVE; });
  }

  disable() {
    log('[ai-overlay] overlay.disable');
    this._stopPulse();
    if (this._monitorsChangedId && this._monitorMgr) this._monitorMgr.disconnect(this._monitorsChangedId);
    this._monitorsChangedId = 0; this._monitorMgr = null;
    if (this._cfgMon) { this._cfgMon.cancel(); this._cfgMon = null; }
    this._box?.destroy(); this._box = this._dot = this._label = null;
  }

  _build() {
    this._box = new St.BoxLayout({ style_class: 'ai-overlay', reactive: false });
    this._dot = new St.Widget({ style_class: 'ai-dot', reactive: false });
    this._label = new St.Label({ text: '', style_class: 'ai-label', reactive: false });
    this._box.add_child(this._dot); this._box.add_child(this._label);
    global.stage.add_child(this._box);
    this._box.hide();
  }

  _applyStyles() {
    const c = this._cfg;

    // размеры
    this._dot.set_size(c.dotSize, c.dotSize);
    this._label.visible = !!c.showLabel;

    // текст/фон/радиус/паддинги
    const padV = c.padding?.[0] ?? 6;
    const padH = c.padding?.[1] ?? 10;
    // базовые стили контейнера (фон подставим в _apply() по состоянию)
    this._box.set_style(`border-radius:${c.radius}px; padding:${padV}px ${padH}px;`);
    this._label.set_style(`color:${c.colors.text}; font-weight:600; font-size:${c.fontSize}pt;`);

    // pivot
    const px = Math.max(0, Math.min(1, c.pivot?.x ?? 1.0));
    const py = Math.max(0, Math.min(1, c.pivot?.y ?? 0.0));
    this._box.set_pivot_point(px, py);
  }

  _monitorRect() {
    const d = global.display;
    let idx = (this._cfg.monitor === 'primary') ? d.get_primary_monitor()
                                                : Number(this._cfg.monitor);
    if (!Number.isInteger(idx) || idx < 0 || idx >= d.get_n_monitors())
      idx = d.get_primary_monitor();
    return d.get_monitor_geometry(idx);
  }

  _reposition() {
    const rect = this._monitorRect();
    const m = this._cfg.offset ?? { x:24, y:24 };

    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      if (!this._box) return GLib.SOURCE_REMOVE;
      const w = this._box.width;
      const h = this._box.height;

      let x = rect.x;
      let y = rect.y;
      const pos = String(this._cfg.corner || 'top-right').toLowerCase();

      switch (pos) {
        case 'top-left':
          x += m.x; y += m.y; break;
        case 'top-right':
          x += rect.width - w - m.x; y += m.y; break;
        case 'bottom-left':
          x += m.x; y += rect.height - h - m.y; break;
        case 'bottom-right':
          x += rect.width - w - m.x; y += rect.height - h - m.y; break;

        case 'top-center':
          x += Math.floor((rect.width - w) / 2);
          y += m.y; break;
        case 'bottom-center':
          x += Math.floor((rect.width - w) / 2);
          y += rect.height - h - m.y; break;
        case 'left-center':
          x += m.x;
          y += Math.floor((rect.height - h) / 2); break;
        case 'right-center':
          x += rect.width - w - m.x;
          y += Math.floor((rect.height - h) / 2); break;
        case 'center':
          x += Math.floor((rect.width - w) / 2);
          y += Math.floor((rect.height - h) / 2); break;

        default:
          // fallback = top-right
          x += rect.width - w - m.x;
          y += m.y;
      }

      this._box.set_position(x, y);
      return GLib.SOURCE_REMOVE;
    });
  }

  _stopPulse() {
    if (this._pulse) { GLib.source_remove(this._pulse); this._pulse = 0; }
    if (this._box) { this._box.scale_x = 1; this._box.scale_y = 1; }
  }

  _startPulse(period) {
    if (!this._cfg.pulse?.enabled) { this._stopPulse(); return; }
    this._stopPulse();
    const half = Math.max(150, Math.floor(period/2));
    const target = Math.max(1.0, Number(this._cfg.pulse.scale) || 1.06);
    const tick = () => {
      if (!this._box) return GLib.SOURCE_REMOVE;
      this._box.ease({
        scale_x: target, scale_y: target, duration: half,
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

  _applyVisualState() {
    // Сброс inline-цвета точки
    const c = this._cfg;
    let bg = c.colors.bg;
    let dot = c.colors.dotIdle;

    switch (this._state) {
      case 'idle':
        break;
      case 'listening':
        dot = c.colors.dotListening;
        break;
      case 'thinking':
        dot = c.colors.dotThinking;
        break;
      case 'error':
        dot = c.colors.dotError;
        bg  = c.colors.bgError || bg;
        break;
    }

    this._dot.set_style(`background-color:${dot}; width:${c.dotSize}px; height:${c.dotSize}px; border-radius:9999px;`);

    // фон контейнера
    // если в colors.bg/ bgError уже есть rgba — используем его; иначе учитываем opacity
    if (bg.startsWith('rgba(') || bg.startsWith('#') || bg.startsWith('rgb(')) {
      this._box.set_style(`${this._box.get_style()} background-color:${bg};`);
    } else {
      const op = Math.max(0, Math.min(1, c.opacity ?? 0.26));
      this._box.set_style(`${this._box.get_style()} background-color: rgba(20,22,28,${op});`);
    }
  }

  _apply() {
    if (!this._box) return;

    switch (this._state) {
      case 'idle':
        this._label.text = '';
        this._stopPulse();
        this.hide();
        break;
      case 'listening':
        this._label.text = this._cfg.showLabel ? 'Слушаю…' : '';
        this._startPulse(this._cfg.pulse.periodListening);
        this.show();
        break;
      case 'thinking':
        this._label.text = this._cfg.showLabel ? 'Думаю…' : '';
        this._startPulse(this._cfg.pulse.periodThinking);
        this.show();
        break;
      case 'error':
        this._label.text = this._cfg.showLabel ? 'Ошибка' : '';
        this._stopPulse();
        this.show();
        this._box.opacity = 180;
        this._box.ease({ opacity: 255, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
        break;
    }

    this._applyStyles();       // на случай изменения шрифта/паддингов на лету
    this._applyVisualState();  // цвета в зависимости от состояния
    this._reposition();
  }

  setState(s) {
    s = String(s).toLowerCase();
    if (!['idle','listening','thinking','error'].includes(s)) {
      log(`[ai-overlay] unknown state ${s}`);
      return;
    }
    this._state = s;
    this._apply();
  }
  getState() { return this._state; }

  show() {
    if (!this._box) return;
    this._box.opacity = 0; this._box.show();
    // поднимем поверх всех
    if (this._box.get_parent() === global.stage)
      global.stage.set_child_above_sibling(this._box, null);
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

// ---------- DBUS ----------

class DBusController {
  constructor(overlay) { this._overlay = overlay; this._nameId = 0; this._exported = null; this._conn = null; this._regId = 0; }

  enable() {
    log('[ai-overlay] dbus.enable');
    try {
      if (Gio.DBusExportedObject?.wrapJSObject) {
        const impl = {
          SetState: (state) => { this._overlay.setState(state); },
          GetState: () => this._overlay.getState(),
          Show: () => { this._overlay.show(); },
          Hide: () => { this._overlay.hide(); },
          Ping: () => 'ok'
        };
        this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, impl);
        this._exported.export(Gio.DBus.session, OBJ_PATH);
        this._nameId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE, null, null, null);
        log(`[ai-overlay] D-Bus exported as ${BUS_NAME}`);
        return;
      }
      // Fallback (редко нужен)
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
      this._nameId = Gio.DBus.own_name(
        Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.REPLACE,
        conn => { this._conn = conn; this._regId = conn.register_object(OBJ_PATH, iface, vtable); log(`[ai-overlay] D-Bus exported (fallback) as ${BUS_NAME}`); },
        null, (conn, name) => log(`[ai-overlay] name lost: ${name}`)
      );
    } catch (e) { logError(e, '[ai-overlay] dbus.enable error'); }
  }

  disable() {
    log('[ai-overlay] dbus.disable');
    try {
      if (this._exported) { this._exported.unexport(); this._exported = null; }
      if (this._conn && this._regId) { this._conn.unregister_object(this._regId); this._regId = 0; }
      if (this._nameId) { Gio.bus_unown_name?.(this._nameId); Gio.DBus.unown_name?.(this._nameId); this._nameId = 0; }
    } catch (e) { logError(e, '[ai-overlay] dbus.disable error'); }
  }
}

export default class AiOverlayExtension extends Extension {
  enable() {
    log('[ai-overlay] extension.enable');
    this._overlay = new Overlay(); this._overlay.enable();
    this._dbus = new DBusController(this._overlay); this._dbus.enable();
  }
  disable() {
    log('[ai-overlay] extension.disable');
    this._dbus?.disable(); this._dbus = null;
    this._overlay?.disable(); this._overlay = null;
  }
}
