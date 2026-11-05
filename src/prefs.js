// SPDX-License-Identifier: GPL-2.0-or-later
//
// Preferences window (GTK 4 + libadwaita). It runs in a separate process,
// so nothing from GNOME Shell can be imported here.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences, gettext as _, ngettext, pgettext,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    DURATION_CHOICES, describeDays, newAlarm, parseClockTime, parsePresets,
    readAlarms, weekdayNames, writeAlarms,
} from './utils.js';

const ALERT_MODES = ['dialog', 'banner', 'notification'];
const PANEL_TEXTS = ['time', 'remaining', 'none'];

const pad2 = n => String(n).padStart(2, '0');

/** One-letter day buttons, Monday first. */
function dayLetters() {
    return [
        pgettext('Monday', 'M'),
        pgettext('Tuesday', 'T'),
        pgettext('Wednesday', 'W'),
        pgettext('Thursday', 'T'),
        pgettext('Friday', 'F'),
        pgettext('Saturday', 'S'),
        pgettext('Sunday', 'S'),
    ];
}

function minutesText(minutes) {
    return ngettext('%d minute', '%d minutes', minutes).replace('%d', String(minutes));
}

function makeTimeSpin(upper, value, cssClasses = []) {
    const spin = new Gtk.SpinButton({
        adjustment: new Gtk.Adjustment({lower: 0, upper, step_increment: 1, page_increment: 5}),
        orientation: Gtk.Orientation.VERTICAL,
        numeric: true,
        wrap: true,
        width_chars: 2,
        valign: Gtk.Align.CENTER,
        css_classes: cssClasses,
    });
    spin.value = value;
    spin.connect('output', () => {
        spin.text = pad2(spin.get_value_as_int());
        return true;
    });
    return spin;
}

/**
 * Combo row offering DURATION_CHOICES.
 *
 * @param {string} title
 * @param {number} minutes - current value
 * @param {Function} onChange - called with the chosen minutes
 * @returns {Adw.ComboRow}
 */
function makeDurationRow(title, minutes, onChange) {
    const choices = DURATION_CHOICES.includes(minutes)
        ? DURATION_CHOICES
        : [...DURATION_CHOICES, minutes].sort((a, b) => a - b);
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(minutesText)),
    });
    row.selected = choices.indexOf(minutes);
    row.connect('notify::selected', () => onChange(choices[row.selected]));
    return row;
}

export default class AlarmaRecordatorioPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        // Nothing is stored on `this`: the window owns everything, and the
        // settings handlers are dropped when it closes.
        const handlerIds = [];
        const watch = (key, callback) => {
            handlerIds.push(settings.connect(`changed::${key}`, callback));
            callback();
        };
        window.connect('close-request', () => {
            handlerIds.forEach(id => settings.disconnect(id));
            handlerIds.length = 0;
            return false;
        });

        window.set_default_size(640, 760);

        const alarmsPage = new Adw.PreferencesPage({
            title: _('Alarms'),
            icon_name: 'preferences-system-time-symbolic',
        });
        alarmsPage.add(this._buildAlarmsGroup(settings, watch, window));

        const generalPage = new Adw.PreferencesPage({
            title: _('Settings'),
            icon_name: 'preferences-system-symbolic',
        });
        generalPage.add(this._buildPanelGroup(settings, watch));
        generalPage.add(this._buildMenuGroup(settings, watch));
        generalPage.add(this._buildAlertGroup(settings, watch));
        generalPage.add(this._buildSoundGroup(settings, watch, window));

        // The menu has one entry for each section, so the window shows only
        // the one asked for, and switches if the other entry is used while
        // it is open. The title starts with the extension name: the
        // extension uses that to find this window.
        const pages = {alarms: alarmsPage, general: generalPage};
        let shown = null;
        watch('prefs-page', () => {
            const page = pages[settings.get_string('prefs-page')] ?? generalPage;
            if (page === shown)
                return;
            if (shown)
                window.remove(shown);
            window.add(page);
            shown = page;
            window.title = `${this.metadata.name} – ${page.title}`;
        });
    }

    /**
     * Keeps a combo row and a string setting with fixed choices in sync.
     *
     * @param {Gio.Settings} settings
     * @param {Function} watch
     * @param {string} key
     * @param {string[]} values - setting value for each row of the combo
     * @param {Adw.ComboRow} row
     * @param {Function} [onChange] - called with the current value
     */
    _bindChoice(settings, watch, key, values, row, onChange = () => {}) {
        watch(key, () => {
            const index = Math.max(0, values.indexOf(settings.get_string(key)));
            if (row.selected !== index)
                row.selected = index;
            onChange(values[index]);
        });
        row.connect('notify::selected', () => {
            const value = values[row.selected] ?? values[0];
            if (settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
    }

    _buildAlarmsGroup(settings, watch, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Alarms'),
            description: _('They ring at a time of day, on the days you choose. Independent from the countdown. If one goes off while the screen is locked, you will see it when you unlock.'),
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            tooltip_text: _('Add alarm'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        addButton.connect('clicked', () => this._editAlarm(settings, window, null));
        group.set_header_suffix(addButton);

        let rows = [];
        let toggling = false;

        const setEnabled = (index, enabled) => {
            const alarms = readAlarms(settings);
            if (!alarms[index] || alarms[index].enabled === enabled)
                return;
            alarms[index].enabled = enabled;
            alarms[index].snoozedUntil = 0;
            toggling = true;
            writeAlarms(settings, alarms);
            toggling = false;
        };
        const rebuild = () => {
            rows.forEach(row => group.remove(row));
            rows = readAlarms(settings).map((alarm, index) =>
                this._buildAlarmRow(alarm, enabled => setEnabled(index, enabled),
                    () => this._editAlarm(settings, window, index)));
            if (rows.length === 0) {
                rows.push(new Adw.ActionRow({
                    title: _('No alarms'),
                    subtitle: _('Add one with the + button'),
                }));
            }
            rows.forEach(row => group.add(row));
        };

        // Any change rebuilds the list, except a switch of the list itself,
        // which already shows its new state.
        watch('alarms', () => {
            if (!toggling)
                rebuild();
        });

        return group;
    }

    /**
     * @param {import('./utils.js').Alarm} alarm
     * @param {Function} onToggle - called with the new enabled state
     * @param {Function} onEdit
     * @returns {Adw.ActionRow}
     */
    _buildAlarmRow(alarm, onToggle, onEdit) {
        const row = new Adw.ActionRow({
            title: alarm.name || _('Alarm'),
            subtitle: describeDays(alarm.days, _),
            use_markup: false,
            activatable: true,
        });
        row.add_prefix(new Gtk.Label({
            label: alarm.time,
            css_classes: ['title-2', 'numeric'],
            valign: Gtk.Align.CENTER,
        }));

        const toggle = new Gtk.Switch({active: alarm.enabled, valign: Gtk.Align.CENTER});
        toggle.connect('notify::active', () => onToggle(toggle.active));
        row.add_suffix(toggle);
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', onEdit);
        return row;
    }

    /**
     * Opens the "Edit alarm" dialog. Changes are saved only on Done.
     *
     * @param {Gio.Settings} settings
     * @param {Adw.PreferencesWindow} window
     * @param {?number} index - position in the alarms list; null adds one
     */
    _editAlarm(settings, window, index) {
        const isNew = index === null;
        const alarm = isNew ? newAlarm() : readAlarms(settings)[index];
        if (!alarm)
            return;

        const dialog = new Adw.Dialog({
            title: isNew ? _('New alarm') : _('Edit alarm'),
            content_width: 440,
        });
        const cancelButton = new Gtk.Button({label: _('Cancel')});
        const doneButton = new Gtk.Button({label: _('Done'), css_classes: ['suggested-action']});
        const header = new Adw.HeaderBar({
            show_start_title_buttons: false,
            show_end_title_buttons: false,
        });
        header.pack_start(cancelButton);
        header.pack_end(doneButton);
        const page = new Adw.PreferencesPage();
        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(header);
        dialog.set_child(toolbar);

        // Time
        const time = parseClockTime(alarm.time) ?? {hours: 7, minutes: 0};
        const hours = makeTimeSpin(23, time.hours, ['title-1']);
        const minutes = makeTimeSpin(59, time.minutes, ['title-1']);
        const timeBox = new Gtk.Box({spacing: 12, halign: Gtk.Align.CENTER});
        timeBox.append(hours);
        timeBox.append(new Gtk.Label({label: ':', css_classes: ['title-1']}));
        timeBox.append(minutes);
        const timeGroup = new Adw.PreferencesGroup();
        timeGroup.add(timeBox);
        page.add(timeGroup);

        const group = new Adw.PreferencesGroup();
        page.add(group);

        // Repeat: one toggle per day; none means it rings once
        const repeatBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12,
        });
        const repeatLabel = new Gtk.Label({xalign: 0});
        const updateRepeatLabel = () => {
            repeatLabel.label = `${_('Repeat')}: ${describeDays(alarm.days, _)}`;
        };
        updateRepeatLabel();
        repeatBox.append(repeatLabel);
        const daysBox = new Gtk.Box({spacing: 6});
        const names = weekdayNames();
        dayLetters().forEach((letter, day) => {
            const button = new Gtk.ToggleButton({
                label: letter,
                tooltip_text: names[day],
                active: (alarm.days & (1 << day)) !== 0,
                css_classes: ['circular'],
            });
            button.connect('toggled', () => {
                alarm.days = button.active ? alarm.days | (1 << day) : alarm.days & ~(1 << day);
                updateRepeatLabel();
            });
            daysBox.append(button);
        });
        repeatBox.append(daysBox);
        const repeatRow = new Adw.PreferencesRow({title: _('Repeat'), activatable: false});
        repeatRow.set_child(repeatBox);
        group.add(repeatRow);

        // Name
        const nameRow = new Adw.EntryRow({title: _('Name'), text: alarm.name});
        nameRow.connect('changed', () => {
            alarm.name = nameRow.text;
        });
        group.add(nameRow);

        // Sound
        const soundRow = new Adw.ActionRow({title: _('Alarm sound'), use_markup: false});
        const resetSound = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Same sound as the countdown'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const chooseSound = new Gtk.Button({label: _('Choose…'), valign: Gtk.Align.CENTER});
        const updateSound = () => {
            soundRow.subtitle = alarm.sound
                ? Gio.File.new_for_uri(alarm.sound).get_basename() ?? alarm.sound
                : _('Same as the countdown');
            resetSound.sensitive = alarm.sound !== '';
        };
        updateSound();
        resetSound.connect('clicked', () => {
            alarm.sound = '';
            updateSound();
        });
        chooseSound.connect('clicked', () => this._chooseSound(window, alarm.sound, uri => {
            alarm.sound = uri;
            updateSound();
        }));
        soundRow.add_suffix(resetSound);
        soundRow.add_suffix(chooseSound);
        group.add(soundRow);

        // Ringing time and snooze
        group.add(makeDurationRow(_('Alarm duration'), alarm.ringMinutes, value => {
            alarm.ringMinutes = value;
        }));
        group.add(makeDurationRow(_('Snooze duration'), alarm.snoozeMinutes, value => {
            alarm.snoozeMinutes = value;
        }));

        // Delete
        if (!isNew) {
            const deleteGroup = new Adw.PreferencesGroup();
            const deleteRow = new Adw.ButtonRow({
                title: _('Delete alarm'),
                css_classes: ['destructive-action'],
            });
            deleteRow.connect('activated', () => {
                const alarms = readAlarms(settings);
                alarms.splice(index, 1);
                writeAlarms(settings, alarms);
                dialog.close();
            });
            deleteGroup.add(deleteRow);
            page.add(deleteGroup);
        }

        cancelButton.connect('clicked', () => dialog.close());
        doneButton.connect('clicked', () => {
            alarm.time = `${pad2(hours.get_value_as_int())}:${pad2(minutes.get_value_as_int())}`;
            alarm.snoozedUntil = 0;
            // Saving an alarm switches it on, also a one-time alarm that
            // already rang. Read again: the menu may have changed other
            // alarms meanwhile.
            alarm.enabled = true;
            const alarms = readAlarms(settings);
            if (isNew)
                alarms.push(alarm);
            else if (alarms[index])
                alarms[index] = alarm;
            writeAlarms(settings, alarms);
            dialog.close();
        });

        dialog.present(window);
    }

    _buildPanelGroup(settings, watch) {
        const group = new Adw.PreferencesGroup({title: _('Top bar')});

        const panelRow = new Adw.ComboRow({
            title: _('Next to the icon, show'),
            model: Gtk.StringList.new([
                _('Time of the next alarm, if it is today'),
                _('Time left on the countdown'),
                _('Nothing, only the icon'),
            ]),
        });
        this._bindChoice(settings, watch, 'panel-text', PANEL_TEXTS, panelRow);
        group.add(panelRow);

        return group;
    }

    _buildMenuGroup(settings, watch) {
        const group = new Adw.PreferencesGroup({
            title: _('Menu'),
            description: _('Minutes added by each button, separated by spaces. Negative values subtract and are only enabled while enough time is left (e.g. -5 -1 1 5 10 30).'),
        });

        const presetsRow = new Adw.EntryRow({
            title: _('Minute buttons'),
            show_apply_button: true,
        });
        watch('presets', () => {
            presetsRow.text = settings.get_value('presets').deepUnpack().join(' ');
        });
        presetsRow.connect('changed', () => presetsRow.remove_css_class('error'));
        presetsRow.connect('apply', () => {
            const values = parsePresets(presetsRow.text);
            if (!values) {
                presetsRow.add_css_class('error');
                return;
            }
            settings.set_value('presets', new GLib.Variant('ai', values));
        });
        group.add(presetsRow);

        const roundRow = new Adw.SwitchRow({
            title: _('Round to the minute'),
            subtitle: _('The alarm goes off at hh:mm:00'),
        });
        settings.bind('round-to-minute', roundRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(roundRow);

        return group;
    }

    _buildAlertGroup(settings, watch) {
        const group = new Adw.PreferencesGroup({title: _('Reminder')});

        const modeRow = new Adw.ComboRow({
            title: _('Show the reminder as'),
            model: Gtk.StringList.new([
                _('Dialog with buttons'),
                _('On-screen message that fades out'),
                _('System notification'),
            ]),
        });
        group.add(modeRow);

        const bannerRow = new Adw.SpinRow({
            title: _('On-screen message duration'),
            subtitle: _('Seconds'),
            adjustment: new Gtk.Adjustment({lower: 2, upper: 60, step_increment: 1, page_increment: 5}),
        });
        settings.bind('banner-seconds', bannerRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(bannerRow);

        this._bindChoice(settings, watch, 'alert-mode', ALERT_MODES, modeRow,
            mode => {
                bannerRow.sensitive = mode === 'banner';
            });

        const snoozeRow = new Adw.SpinRow({
            title: _('Snooze the countdown'),
            subtitle: _('Minutes added by the Snooze button. Each alarm has its own.'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 120, step_increment: 1, page_increment: 5}),
        });
        settings.bind('snooze-minutes', snoozeRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(snoozeRow);

        const testRow = new Adw.ActionRow({
            title: _('Try it'),
            subtitle: _('Shows a reminder now with the current settings'),
        });
        const testButton = new Gtk.Button({
            label: _('Show test reminder'),
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => {
            settings.set_boolean('test-reminder', !settings.get_boolean('test-reminder'));
        });
        testRow.add_suffix(testButton);
        group.add(testRow);

        return group;
    }

    _buildSoundGroup(settings, watch, window) {
        const group = new Adw.PreferencesGroup({
            title: _('Sound'),
            description: _('Used by the countdown. Each alarm has its own sound and ringing time, but they are muted too when sound is off.'),
        });

        const playRow = new Adw.SwitchRow({title: _('Play a sound')});
        settings.bind('play-sound', playRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(playRow);

        const fileRow = new Adw.ActionRow({title: _('Sound file'), use_markup: false});
        const resetButton = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: _('Use the default alarm sound'),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        resetButton.connect('clicked', () => settings.reset('sound-file'));
        const chooseButton = new Gtk.Button({
            label: _('Choose…'),
            valign: Gtk.Align.CENTER,
        });
        chooseButton.connect('clicked', () => this._chooseSound(window,
            settings.get_string('sound-file'), uri => settings.set_string('sound-file', uri)));
        fileRow.add_suffix(resetButton);
        fileRow.add_suffix(chooseButton);
        group.add(fileRow);

        watch('sound-file', () => {
            const uri = settings.get_string('sound-file');
            fileRow.subtitle = uri
                ? Gio.File.new_for_uri(uri).get_basename() ?? uri
                : _('Default alarm sound');
            resetButton.sensitive = uri !== '';
        });

        const repeatRow = new Adw.SwitchRow({
            title: _('Repeat until dismissed'),
            subtitle: _('Every 6 seconds, for 2 minutes at most. Best with short sounds.'),
        });
        settings.bind('repeat-sound', repeatRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(repeatRow);

        for (const row of [fileRow, repeatRow])
            settings.bind('play-sound', row, 'sensitive', Gio.SettingsBindFlags.GET);

        return group;
    }

    /**
     * @param {Gtk.Window} window
     * @param {string} current - URI of the current sound, or empty
     * @param {Function} onChosen - called with the URI of the chosen file
     */
    _chooseSound(window, current, onChosen) {
        const filter = new Gtk.FileFilter({name: _('Audio files')});
        filter.add_mime_type('audio/*');
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);

        const dialog = new Gtk.FileDialog({
            title: _('Choose a sound'),
            modal: true,
            filters,
            default_filter: filter,
        });

        if (current)
            dialog.set_initial_file(Gio.File.new_for_uri(current));
        else
            dialog.set_initial_folder(Gio.File.new_for_path('/usr/share/sounds'));

        dialog.open(window, null, (_dialog, result) => {
            try {
                const file = dialog.open_finish(result);
                if (file)
                    onChosen(file.get_uri());
            } catch (e) {
                if (!e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED))
                    console.error(e);
            }
        });
    }
}
