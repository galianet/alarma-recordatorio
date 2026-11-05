// SPDX-License-Identifier: GPL-2.0-or-later
//
// Alarma Recordatorio for GNOME Shell 50.
// Inspired by "Reminder Alarm Clock" (extension 2482); written from scratch.

import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlarmController} from './controller.js';
import {AlarmIndicator} from './indicator.js';
import {ReminderPresenter} from './reminder.js';
import {formatClock} from './utils.js';

export default class AlarmaRecordatorioExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._desktopSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});

        this._controller = new AlarmController(this._settings);
        this._presenter = new ReminderPresenter(this, this._settings, this._controller);
        this._controller.connectObject('fired',
            (_controller, info) => this._presenter.show(info), this);

        this._indicator = new AlarmIndicator(this, this._settings, this._controller);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._controller.start();
    }

    disable() {
        // Disabled on screen lock too. The alarm state is stored in GSettings,
        // so it carries on after unlocking.
        this._indicator?.destroy();
        this._indicator = null;

        this._controller?.disconnectObject(this);

        this._presenter?.destroy();
        this._presenter = null;

        this._controller?.destroy();
        this._controller = null;

        this._desktopSettings = null;
        this._settings = null;
    }

    /**
     * Local time, following the desktop 12/24-hour setting.
     *
     * @param {number} ms - Unix time in ms
     * @returns {string}
     */
    formatClock(ms) {
        const use24h = this._desktopSettings?.get_string('clock-format') !== '12h';
        return formatClock(ms, use24h);
    }
}
