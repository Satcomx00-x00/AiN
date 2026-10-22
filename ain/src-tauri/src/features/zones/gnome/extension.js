// AiN zones: GNOME doesn't let apps move other apps' windows on Wayland, so AiN installs this
// extension, which does it for them over D-Bus. It only answers what zones need: the window the
// user is in and its frame, where the pointer is while a window is being moved, and moving,
// resizing or focusing a window. It draws nothing and keeps nothing.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const NAME = 'dev.satcom.AiN.Zones';
const PATH = '/dev/satcom/AiN/Zones';
/** Bumped when the interface changes, so AiN can tell an outdated helper. */
const VERSION = 1;

const INTERFACE = `<node>
  <interface name="dev.satcom.AiN.Zones">
    <method name="Version">
      <arg type="u" direction="out" name="version"/>
    </method>
    <method name="Pointer">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="u" direction="out" name="modifiers"/>
    </method>
    <method name="Focused">
      <arg type="u" direction="in" name="ignored_pid"/>
      <arg type="t" direction="out" name="window"/>
    </method>
    <method name="Frame">
      <arg type="t" direction="in" name="window"/>
      <arg type="b" direction="out" name="found"/>
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
      <arg type="i" direction="out" name="width"/>
      <arg type="i" direction="out" name="height"/>
    </method>
    <method name="Place">
      <arg type="t" direction="in" name="window"/>
      <arg type="i" direction="in" name="x"/>
      <arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/>
      <arg type="i" direction="in" name="height"/>
      <arg type="b" direction="out" name="placed"/>
    </method>
    <method name="Activate">
      <arg type="t" direction="in" name="window"/>
    </method>
    <signal name="MovingChanged">
      <arg type="b" name="moving"/>
    </signal>
  </interface>
</node>`;

/** The window with `id`, if it is still there. */
function windowById(id) {
    return global.display.list_all_windows().find(w => w.get_id() === id) ?? null;
}

/** Whether a window is one zones may move: a normal, resizable window, not full screen. Mutter says
 *  a maximized window doesn't allow resizing: the `resizeable` property says whether it can be. */
function movable(w) {
    return w.get_window_type() === Meta.WindowType.NORMAL && w.resizeable && !w.is_fullscreen();
}

/** Out of maximized, before a move: GNOME 49 dropped the flags from `unmaximize()`. */
function unmaximize(w) {
    if (typeof w.is_maximized === 'function') {
        if (w.is_maximized())
            w.unmaximize();
    } else if (w.get_maximized()) {
        w.unmaximize(Meta.MaximizeFlags.BOTH);
    }
}

class Zones {
    Version() {
        return VERSION;
    }

    Pointer() {
        const [x, y, modifiers] = global.get_pointer();
        return [x, y, modifiers];
    }

    Focused(ignoredPid) {
        const w = global.display.focus_window;
        if (!w || !movable(w) || w.get_pid() === ignoredPid)
            return 0;
        return w.get_id();
    }

    Frame(id) {
        const w = windowById(id);
        if (!w)
            return [false, 0, 0, 0, 0];
        const r = w.get_frame_rect();
        return [true, r.x, r.y, r.width, r.height];
    }

    Place(id, x, y, width, height) {
        const w = windowById(id);
        if (!w || !movable(w))
            return false;
        unmaximize(w);
        w.move_resize_frame(false, x, y, width, height);
        return true;
    }

    Activate(id) {
        windowById(id)?.activate(global.get_current_time());
    }
}

export default class AinZonesExtension extends Extension {
    enable() {
        this._service = Gio.DBusExportedObject.wrapJSObject(INTERFACE, new Zones());
        this._service.export(Gio.DBus.session, PATH);
        this._owner = Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
        // A move or a resize under way: AiN looks at the pointer only then.
        const moving = value => this._service.emit_signal('MovingChanged', new GLib.Variant('(b)', [value]));
        this._grabs = [
            global.display.connect('grab-op-begin', () => moving(true)),
            global.display.connect('grab-op-end', () => moving(false)),
        ];
    }

    disable() {
        this._grabs?.forEach(id => global.display.disconnect(id));
        this._grabs = null;
        if (this._owner)
            Gio.bus_unown_name(this._owner);
        this._owner = 0;
        this._service?.unexport();
        this._service = null;
    }
}
