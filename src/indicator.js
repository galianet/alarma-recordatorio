// SPDX-License-Identifier: GPL-2.0-or-later
//
// Top bar indicator and its menu.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {
    describeDays, formatRemaining, isToday, nextOccurrence, parseClockTime, relativeDay,
} from './utils.js';

const PRESETS_PER_ROW = 3;
const MAX_MESSAGE_IN_MENU = 28;
// Application ID of the service that shows extension preferences
const PREFS_APP_ID = 'org.gnome.Shell.Extensions';
const PREFS_WINDOW_WAIT_MS = 10 * 1000;

function presetLabel(minutes) {
    const sign = minutes < 0 ? '−' : '+';
    const amount = Math.abs(minutes);
    return amount >= 60 && amount % 60 === 0
        ? `${sign}${amount / 60} h`
        : `${sign}${amount} min`;
}

export const AlarmIndicator = GObject.registerClass(
class AlarmIndicator extends PanelMenu.Button {
    _init(extension, settings, controller) {
        super._init(0.5, extension.metadata.name, false);

        this._extension = extension;
        this._settings = settings;
        this._controller = controller;
        this._prefsWindow = null;
        this._prefsWaitId = 0;
        this._reopenId = 0;

        const iconFile = name => Gio.FileIcon.new(extension.dir.resolve_relative_path(`icons/${name}`));
        this._iconOn = iconFile('alarma-on-symbolic.svg');
        this._iconOff = iconFile('alarma-off-symbolic.svg');

        // Top bar: icon and the time of what rings next today
        const panelBox = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({gicon: this._iconOff, style_class: 'system-status-icon'});
        this._panelLabel = new St.Label({
            style_class: 'alarma-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        panelBox.add_child(this._icon);
        panelBox.add_child(this._panelLabel);
        this.add_child(panelBox);

        this._buildMenu();

        this._controller.connectObject('changed', () => this._sync(), this);

        this._settings.connectObject(
            'changed::presets', () => {
                this._rebuildPresets();
                this._sync();
            },
            'changed::message', () => this._syncMessageEntry(),
            'changed::alarms', () => this._syncAlarmItems(),
            this);

        this._syncAlarmItems();
        this._sync();
    }

    _buildMenu() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'alarma-menu-item',
        });
        this.menu.addMenuItem(item);

        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            style_class: 'alarma-menu-box',
        });
        item.add_child(column);

        // Target time and time left
        this._timeLabel = new St.Label({
            style_class: 'alarma-time-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._statusLabel = new St.Label({
            style_class: 'alarma-status-label',
            x_align: Clutter.ActorAlign.CENTER,
        });
        column.add_child(this._timeLabel);
        column.add_child(this._statusLabel);

        // Minute buttons
        this._presetsBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'alarma-presets',
        });
        column.add_child(this._presetsBox);
        this._rebuildPresets();

        // At a given time
        const atRow = new St.BoxLayout({style_class: 'alarma-row'});
        this._atEntry = new St.Entry({
            hint_text: _('At HH:MM'),
            can_focus: true,
            x_expand: true,
            style_class: 'alarma-entry',
        });
        this._atEntry.clutter_text.connect('activate', () => this._applyAtEntry());
        this._atEntry.clutter_text.connect('text-changed',
            () => this._atEntry.remove_style_class_name('alarma-entry-error'));
        const atButton = new St.Button({
            label: _('Set'),
            can_focus: true,
            style_class: 'button alarma-button',
        });
        atButton.connect('clicked', () => this._applyAtEntry());
        atRow.add_child(this._atEntry);
        atRow.add_child(atButton);
        column.add_child(atRow);

        // Message
        this._messageEntry = new St.Entry({
            hint_text: _('Reminder message…'),
            text: this._settings.get_string('message'),
            can_focus: true,
            x_expand: true,
            style_class: 'alarma-entry alarma-message-entry',
        });
        this._messageEntry.clutter_text.connect('activate', () => this._saveMessage());
        column.add_child(this._messageEntry);

        // Cancel / Accept: without Accept, Cancel would be the only way
        // out of the menu that looks like a confirmation.
        const buttonRow = new St.BoxLayout({style_class: 'alarma-row alarma-buttons-row'});
        this._cancelButton = new St.Button({
            label: _('Cancel alarm'),
            can_focus: true,
            x_expand: true,
            style_class: 'button alarma-button',
        });
        this._cancelButton.connect('clicked', () => this._controller.cancel());
        const acceptButton = new St.Button({
            label: _('Accept'),
            can_focus: true,
            x_expand: true,
            style_class: 'button default alarma-button',
        });
        acceptButton.connect('clicked', () => this._accept());
        buttonRow.add_child(this._cancelButton);
        buttonRow.add_child(acceptButton);
        column.add_child(buttonRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Alarms of the day, one switch each
        this._alarmsSection = new PopupMenu.PopupMenuSection();
        this._alarmItems = [];
        this._alarmsLayout = null;
        this.menu.addMenuItem(this._alarmsSection);

        // Alarms and Settings open the same preferences window on different
        // sections; closing it comes back to this menu.
        const alarmsItem = new PopupMenu.PopupMenuItem(_('Alarms'));
        alarmsItem.connect('activate', () => this._openPrefs('alarms'));
        this.menu.addMenuItem(alarmsItem);

        const prefsItem = new PopupMenu.PopupMenuItem(_('Settings'));
        prefsItem.connect('activate', () => this._openPrefs('general'));
        this.menu.addMenuItem(prefsItem);

        this.menu.connectObject('open-state-changed', (_menu, open) => {
            this._controller.setFastTick(open);
            if (open)
                this._sync();
            else
                this._saveMessage();
        }, this);
    }

    _rebuildPresets() {
        this._presetsBox.destroy_all_children();

        this._subtractButtons = [];

        const presets = this._settings.get_value('presets').deepUnpack()
            .filter(m => Number.isInteger(m) && m !== 0);

        // Subtracting buttons get their own rows, above the adding ones.
        for (const group of [presets.filter(m => m < 0), presets.filter(m => m > 0)]) {
            let row = null;
            group.forEach((minutes, index) => {
                if (index % PRESETS_PER_ROW === 0) {
                    row = new St.BoxLayout({style_class: 'alarma-row'});
                    this._presetsBox.add_child(row);
                }
                const button = new St.Button({
                    label: presetLabel(minutes),
                    can_focus: true,
                    x_expand: true,
                    style_class: 'button alarma-button alarma-preset-button',
                });
                button.connect('clicked', () => {
                    this._saveMessage();
                    this._controller.addMinutes(minutes);
                });
                row.add_child(button);

                if (minutes < 0)
                    this._subtractButtons.push({button, minutes});
            });
        }
    }

    _alarmItemLabel(alarm) {
        const time = parseClockTime(alarm.time);
        const parts = [
            time ? this._extension.formatClock(nextOccurrence(time)) : alarm.time,
            alarm.name.length > MAX_MESSAGE_IN_MENU
                ? `${alarm.name.slice(0, MAX_MESSAGE_IN_MENU - 1)}…`
                : alarm.name,
            describeDays(alarm.days, _),
        ];
        if (alarm.snoozedUntil > Date.now())
            parts.push(_('snoozed until %s').format(this._extension.formatClock(alarm.snoozedUntil)));
        return parts.filter(Boolean).join(' · ');
    }

    _syncAlarmItems() {
        const alarms = this._controller.alarms;

        // Toggling a switch only changes `enabled`: update the items in place
        // instead of destroying the one that is emitting the signal.
        const layout = JSON.stringify(alarms.map(alarm =>
            [alarm.time, alarm.name, alarm.days, alarm.snoozedUntil]));
        if (layout === this._alarmsLayout) {
            alarms.forEach((alarm, i) => this._alarmItems[i].setToggleState(alarm.enabled));
            return;
        }

        this._alarmsLayout = layout;
        this._alarmsSection.removeAll();
        this._alarmItems = alarms.map((alarm, index) => {
            const item = new PopupMenu.PopupSwitchMenuItem(this._alarmItemLabel(alarm), alarm.enabled);
            item.connect('toggled',
                (_item, state) => this._controller.setAlarmEnabled(index, state));
            this._alarmsSection.addMenuItem(item);
            return item;
        });
    }

    /** @returns {boolean} whether the entry held a valid time */
    _applyAtEntry() {
        const time = parseClockTime(this._atEntry.get_text());
        if (!time) {
            this._atEntry.add_style_class_name('alarma-entry-error');
            return false;
        }
        this._saveMessage();
        this._controller.setAt(time);
        this._atEntry.set_text('');
        return true;
    }

    _accept() {
        // A time typed but not applied yet is applied now; a wrong one keeps
        // the menu open so it can be fixed.
        if (this._atEntry.get_text().trim() !== '' && !this._applyAtEntry())
            return;
        this._saveMessage();
        this.menu.close();
    }

    _saveMessage() {
        const text = this._messageEntry.get_text();
        if (text !== this._settings.get_string('message'))
            this._settings.set_string('message', text);
    }

    _syncMessageEntry() {
        const text = this._settings.get_string('message');
        if (text !== this._messageEntry.get_text())
            this._messageEntry.set_text(text);
    }

    _sync() {
        const controller = this._controller;
        const running = controller.isRunning;
        const nextAlarm = controller.nextAlarm;

        const gicon = running || nextAlarm > 0 ? this._iconOn : this._iconOff;
        if (this._icon.gicon !== gicon)
            this._icon.gicon = gicon;

        // Only what rings today: anything later just keeps the icon filled.
        // The controller ticks at least every 30 s while something is set,
        // so after midnight the new day's alarm shows up on its own.
        const panelText = this._settings.get_string('panel-text');
        let text = null;
        if (panelText === 'remaining' && running) {
            text = formatRemaining(controller.remaining);
        } else if (panelText !== 'none') {
            const today = [running ? controller.endTime : 0, nextAlarm]
                .filter(time => time > 0 && isToday(time));
            if (today.length > 0)
                text = this._extension.formatClock(Math.min(...today));
        }
        this._panelLabel.visible = text !== null;
        if (text !== null)
            this._panelLabel.text = text;

        if (!this.menu.isOpen)
            return;

        if (running) {
            this._timeLabel.text = this._extension.formatClock(controller.endTime);
            const left = _('%s left').format(formatRemaining(controller.remaining));
            const day = relativeDay(controller.endTime, _);
            this._statusLabel.text = day ? `${day} · ${left}` : left;
        } else {
            this._timeLabel.text = '--:--';
            this._statusLabel.text = _('No alarm set');
        }
        this._cancelButton.visible = running;

        // The menu ticks every second while open, so these follow the countdown.
        for (const {button, minutes} of this._subtractButtons) {
            const usable = controller.canAdd(minutes);
            button.reactive = usable;
            button.can_focus = usable;
        }
    }

    /**
     * @param {string} page - 'alarms' or 'general'
     */
    _openPrefs(page) {
        this._settings.set_string('prefs-page', page);

        // Only one preferences window can be open: if it is, it switches to
        // the section on its own (it watches prefs-page), so just raise it.
        const existing = global.get_window_actors()
            .map(actor => actor.meta_window)
            .find(window => this._isPrefsWindow(window, true));
        if (existing) {
            this._watchPrefsWindow(existing);
            Main.activateWindow(existing);
            return;
        }

        this._stopWaitingForPrefs();
        global.display.connectObject('window-created', (_display, window) => {
            if (!this._isPrefsWindow(window, false))
                return;
            this._stopWaitingForPrefs();
            this._watchPrefsWindow(window);
        }, this);
        this._prefsWaitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PREFS_WINDOW_WAIT_MS, () => {
            this._prefsWaitId = 0;
            this._stopWaitingForPrefs();
            return GLib.SOURCE_REMOVE;
        });

        this._extension.openPreferences();
    }

    /**
     * @param {Meta.Window} window
     * @param {boolean} checkTitle - false right after asking for it, when
     *   the title may not be set yet
     * @returns {boolean}
     */
    _isPrefsWindow(window, checkTitle) {
        if (window.get_wm_class() !== PREFS_APP_ID)
            return false;
        return !checkTitle || (window.get_title() ?? '').startsWith(this._extension.metadata.name);
    }

    _stopWaitingForPrefs() {
        global.display.disconnectObject(this);
        if (this._prefsWaitId) {
            GLib.source_remove(this._prefsWaitId);
            this._prefsWaitId = 0;
        }
    }

    _watchPrefsWindow(window) {
        if (this._prefsWindow === window)
            return;
        this._prefsWindow?.disconnectObject(this);
        this._prefsWindow = window;
        window.connectObject('unmanaged', () => {
            this._prefsWindow = null;
            // Back to the main screen: the menu
            this._reopenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._reopenId = 0;
                if (!this.menu.isOpen)
                    this.menu.toggle();
                return GLib.SOURCE_REMOVE;
            });
        }, this);
    }

    _onDestroy() {
        this._stopWaitingForPrefs();
        this._prefsWindow?.disconnectObject(this);
        this._prefsWindow = null;
        if (this._reopenId) {
            GLib.source_remove(this._reopenId);
            this._reopenId = 0;
        }
        this._controller.disconnectObject(this);
        this._controller.setFastTick(false);
        this._settings.disconnectObject(this);
        super._onDestroy();
    }
});
