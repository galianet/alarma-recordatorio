// SPDX-License-Identifier: GPL-2.0-or-later
//
// How the reminder is shown (modal dialog, fading on-screen message or
// system notification) and the alarm sound.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {AlarmKind} from './controller.js';

const THEME_SOUND = 'alarm-clock-elapsed';
const SOUND_REPEAT_SECONDS = 6;
const COUNTDOWN_RING_SECONDS = 120;
const LATE_THRESHOLD_MS = 60 * 1000;

const ReminderDialog = GObject.registerClass(
class ReminderDialog extends ModalDialog.ModalDialog {
    _init({title, description, snoozeMinutes, onSnooze}) {
        super._init({styleClass: 'alarma-dialog', destroyOnClose: true});

        const content = new Dialog.MessageDialogContent({title, description});
        this.contentLayout.add_child(content);

        this.setButtons([{
            label: _('Snooze %d min').format(snoozeMinutes),
            action: () => {
                onSnooze();
                this.close();
            },
        }, {
            // Escape only, so an Enter typed by accident does not dismiss it
            // before it has been read.
            label: _('Dismiss'),
            action: () => this.close(),
            key: Clutter.KEY_Escape,
            default: true,
        }]);
    }
});

export class ReminderPresenter {
    constructor(extension, settings, controller) {
        this._extension = extension;
        this._settings = settings;
        this._controller = controller;

        this._dialog = null;
        this._banner = null;
        this._pending = [];
        this._source = null;
        this._soundCancellable = null;
        this._soundTimeoutId = 0;
    }

    /**
     * Reminders that arrive while a dialog or on-screen message is visible
     * wait until it is closed, so none of them hides another.
     *
     * @param {{kind: string, message: string, scheduledAt: number, late: number}} info
     */
    show(info) {
        if (this._dialog || this._banner)
            this._pending.push(info);
        else
            this._present(info);
    }

    _present(info) {
        this._stopSound();

        const title = info.message.trim() || _('Time is up!');
        const description = this._describe(info);
        // Alarms bring their own snooze, sound and ringing time; the
        // countdown and the test use the general settings.
        const isAlarm = info.kind === AlarmKind.ALARM;
        const snoozeMinutes = isAlarm ? info.snoozeMinutes : this._settings.get_int('snooze-minutes');
        const onSnooze = isAlarm
            ? () => this._controller.snoozeAlarm(info.index, snoozeMinutes)
            : () => this._controller.snooze(snoozeMinutes, info.message);

        switch (this._settings.get_string('alert-mode')) {
        case 'banner':
            this._showBanner(title, description);
            break;
        case 'notification':
            this._showNotification(title, description, snoozeMinutes, onSnooze);
            break;
        default:
            if (!this._showDialog(title, description, snoozeMinutes, onSnooze)) {
                // Another modal dialog holds the grab; a notification always gets through.
                this._showNotification(title, description, snoozeMinutes, onSnooze);
            }
        }

        if (this._settings.get_boolean('play-sound')) {
            const uri = (isAlarm && info.sound) || this._settings.get_string('sound-file');
            let ringSeconds = 0;
            if (isAlarm)
                ringSeconds = info.ringMinutes * 60;
            else if (this._settings.get_boolean('repeat-sound'))
                ringSeconds = COUNTDOWN_RING_SECONDS;
            this._startSound(uri, ringSeconds);
        }
    }

    destroy() {
        this._pending = [];
        this._stopSound();
        this._dismissVisual();
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._source = null;
        this._settings = null;
        this._controller = null;
        this._extension = null;
    }

    _describe({kind, scheduledAt, late}) {
        if (kind === AlarmKind.TEST)
            return _('This is a test reminder.');

        const time = this._extension.formatClock(scheduledAt);
        let text = kind === AlarmKind.ALARM
            ? _('Alarm at %s').format(time)
            : _('Countdown set for %s').format(time);

        if (late >= LATE_THRESHOLD_MS) {
            const minutes = Math.round(late / 60000);
            text += '\n';
            text += _('It went off %d min ago, while the session was locked or closed.').format(minutes);
        }
        return text;
    }

    _showDialog(title, description, snoozeMinutes, onSnooze) {
        const dialog = new ReminderDialog({title, description, snoozeMinutes, onSnooze});
        dialog.connect('destroy', () => {
            if (this._dialog === dialog) {
                this._dialog = null;
                this._onVisualClosed();
            }
        });

        if (!dialog.open()) {
            dialog.destroy();
            return false;
        }
        this._dialog = dialog;
        return true;
    }

    _showBanner(title, description) {
        const banner = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'osd-window alarma-banner',
            reactive: true,
            opacity: 0,
        });
        for (const [text, styleClass] of [
            [title, 'alarma-banner-title'],
            [description, 'alarma-banner-body'],
        ]) {
            const label = new St.Label({text, style_class: styleClass});
            label.clutter_text.line_wrap = true;
            banner.add_child(label);
        }

        // A click dismisses it early
        banner.connect('button-press-event', () => {
            banner.remove_all_transitions();
            banner.destroy();
            return Clutter.EVENT_STOP;
        });
        banner.connect('destroy', () => {
            if (this._banner === banner) {
                this._banner = null;
                this._onVisualClosed();
            }
        });

        Main.layoutManager.uiGroup.add_child(banner);
        this._banner = banner;

        const monitor = Main.layoutManager.primaryMonitor;
        banner.set_position(
            monitor.x + Math.floor((monitor.width - banner.width) / 2),
            monitor.y + Math.floor((monitor.height - banner.height) / 2));

        const visibleMs = this._settings.get_int('banner-seconds') * 1000;
        banner.ease({
            opacity: 255,
            duration: 250,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                banner.ease({
                    opacity: 0,
                    delay: Math.max(0, visibleMs - 1500),
                    duration: 1500,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => banner.destroy(),
                });
            },
        });
    }

    _onVisualClosed() {
        this._stopSound();
        const next = this._pending.shift();
        if (next)
            this._present(next);
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: this._extension.metadata.name,
                icon: Gio.FileIcon.new(
                    this._extension.dir.resolve_relative_path('icons/alarma-on-symbolic.svg')),
            });
            this._source.connect('destroy', () => {
                this._source = null;
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _showNotification(title, description, snoozeMinutes, onSnooze) {
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body: description,
            // CRITICAL: it stays until dismissed and is shown even in Do Not Disturb,
            // as expected from an alarm the user set on purpose.
            urgency: MessageTray.Urgency.CRITICAL,
        });
        notification.addAction(_('Snooze %d min').format(snoozeMinutes), onSnooze);
        notification.addAction(_('Dismiss'), () => {});
        notification.connect('destroy', () => this._stopSound());
        notification.connect('notify::acknowledged', () => {
            if (notification.acknowledged)
                this._stopSound();
        });
        source.addNotification(notification);
    }

    /**
     * @param {string} uri - sound file; empty plays the theme alarm sound
     * @param {number} ringSeconds - keep repeating it this long; 0 plays it once
     */
    _startSound(uri, ringSeconds) {
        const player = global.display.get_sound_player();
        const cancellable = new Gio.Cancellable();
        this._soundCancellable = cancellable;

        const play = () => {
            if (uri)
                player.play_from_file(Gio.File.new_for_uri(uri), _('Reminder alarm'), cancellable);
            else
                player.play_from_theme(THEME_SOUND, _('Reminder alarm'), cancellable);
        };
        play();

        const repeats = Math.ceil(ringSeconds / SOUND_REPEAT_SECONDS);
        if (repeats <= 1)
            return;

        let count = 1;
        this._soundTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            SOUND_REPEAT_SECONDS, () => {
                if (count++ >= repeats) {
                    this._soundTimeoutId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                play();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopSound() {
        if (this._soundTimeoutId) {
            GLib.source_remove(this._soundTimeoutId);
            this._soundTimeoutId = 0;
        }
        this._soundCancellable?.cancel();
        this._soundCancellable = null;
    }

    _dismissVisual() {
        if (this._dialog) {
            const dialog = this._dialog;
            this._dialog = null;
            dialog.close();
        }
        if (this._banner) {
            const banner = this._banner;
            this._banner = null;
            banner.remove_all_transitions();
            banner.destroy();
        }
    }
}
