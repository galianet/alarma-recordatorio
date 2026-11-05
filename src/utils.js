// SPDX-License-Identifier: GPL-2.0-or-later
//
// Helpers shared by GNOME Shell and the preferences window, so nothing from
// GNOME Shell can be imported here. Functions that show text take the
// translation function `_` as a parameter.

import GLib from 'gi://GLib';

const pad2 = n => String(n).padStart(2, '0');
const DAY_MS = 24 * 60 * 60 * 1000;

// Days of the week as a bit mask, Monday = bit 0 … Sunday = bit 6.
export const DAY_COUNT = 7;
export const EVERY_DAY = 0b1111111;
export const WEEKDAYS = 0b0011111;
export const WEEKEND = 0b1100000;

// Minutes offered for how long an alarm rings and how long it is snoozed.
export const DURATION_CHOICES = [1, 2, 3, 5, 10, 15, 20, 30];

const ALARMS_TYPE = 'a(bsissiix)';

/**
 * @typedef {object} Alarm
 * @property {boolean} enabled
 * @property {string} time - "HH:MM", 24-hour clock
 * @property {number} days - bit mask of the days it repeats; 0 rings once
 * @property {string} name - shown as the reminder title
 * @property {string} sound - sound file URI; empty uses the general sound
 * @property {number} ringMinutes - how long the sound keeps repeating
 * @property {number} snoozeMinutes - how long Snooze postpones it
 * @property {number} snoozedUntil - Unix time in ms it rings again, or 0
 */

/**
 * @param {Gio.Settings} settings
 * @returns {Alarm[]}
 */
export function readAlarms(settings) {
    return settings.get_value('alarms').deepUnpack().map(
        ([enabled, time, days, name, sound, ringMinutes, snoozeMinutes, snoozedUntil]) =>
            ({enabled, time, days, name, sound, ringMinutes, snoozeMinutes, snoozedUntil}));
}

/**
 * @param {Gio.Settings} settings
 * @param {Alarm[]} alarms
 */
export function writeAlarms(settings, alarms) {
    settings.set_value('alarms', new GLib.Variant(ALARMS_TYPE, alarms.map(alarm => [
        alarm.enabled, alarm.time, alarm.days, alarm.name, alarm.sound,
        alarm.ringMinutes, alarm.snoozeMinutes, Math.round(alarm.snoozedUntil),
    ])));
}

/** @returns {Alarm} */
export function newAlarm() {
    return {
        enabled: true,
        time: '07:00',
        days: EVERY_DAY,
        name: '',
        sound: '',
        ringMinutes: 1,
        snoozeMinutes: 5,
        snoozedUntil: 0,
    };
}

/**
 * @param {string} text - "H:MM" or "HH:MM", 24-hour clock
 * @returns {{hours: number, minutes: number}|null}
 */
export function parseClockTime(text) {
    const match = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\s*$/.exec(text ?? '');
    return match ? {hours: Number(match[1]), minutes: Number(match[2])} : null;
}

/**
 * @param {Date} date
 * @returns {number} 0 for Monday … 6 for Sunday
 */
function weekdayIndex(date) {
    return (date.getDay() + 6) % 7;
}

function ringsOn(days, date) {
    return days === 0 || (days & (1 << weekdayIndex(date))) !== 0;
}

/**
 * First time strictly after `from` at which the clock shows hh:mm on one of
 * the given days (any day when `days` is 0).
 *
 * @param {{hours: number, minutes: number}} time
 * @param {number} days - bit mask, see EVERY_DAY
 * @param {number} from - Unix time in ms
 * @returns {number} Unix time in ms
 */
export function nextAlarmTime(time, days, from) {
    const date = new Date(from);
    date.setHours(time.hours, time.minutes, 0, 0);
    for (let i = 0; i <= DAY_COUNT; i++) {
        if (date.getTime() > from && ringsOn(days, date))
            return date.getTime();
        date.setDate(date.getDate() + 1);
        date.setHours(time.hours, time.minutes, 0, 0);
    }
    return 0;
}

/**
 * Last time at or before `until` at which the clock showed hh:mm on one of
 * the given days.
 *
 * @param {{hours: number, minutes: number}} time
 * @param {number} days - bit mask, see EVERY_DAY
 * @param {number} until - Unix time in ms
 * @returns {number} Unix time in ms
 */
export function lastAlarmTime(time, days, until) {
    const date = new Date(until);
    date.setHours(time.hours, time.minutes, 0, 0);
    for (let i = 0; i <= DAY_COUNT; i++) {
        if (date.getTime() <= until && ringsOn(days, date))
            return date.getTime();
        date.setDate(date.getDate() - 1);
        date.setHours(time.hours, time.minutes, 0, 0);
    }
    return 0;
}

/**
 * Next time strictly after `now` at which the clock shows hh:mm.
 *
 * @param {{hours: number, minutes: number}} time
 * @param {number} now - Unix time in ms
 * @returns {number} Unix time in ms
 */
export function nextOccurrence(time, now = Date.now()) {
    return nextAlarmTime(time, 0, now);
}

/**
 * Compact time left: "4:05", "1:02:09".
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatRemaining(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours > 0
        ? `${hours}:${pad2(minutes)}:${pad2(seconds)}`
        : `${minutes}:${pad2(seconds)}`;
}

/**
 * Local time in 12- or 24-hour format.
 *
 * @param {number} ms - Unix time in ms
 * @param {boolean} use24h
 * @returns {string}
 */
export function formatClock(ms, use24h = true) {
    const dateTime = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    return dateTime.format(use24h ? '%H:%M' : '%-l:%M %p');
}

function midnight(ms) {
    return new Date(ms).setHours(0, 0, 0, 0);
}

/**
 * @param {number} ms - Unix time in ms
 * @param {number} now - Unix time in ms
 * @returns {boolean} whether `ms` falls on the same calendar day as `now`
 */
export function isToday(ms, now = Date.now()) {
    return midnight(ms) === midnight(now);
}

/**
 * The day of `ms` relative to `now`: empty for today, "tomorrow", or the
 * abbreviated day of the week further on.
 *
 * @param {number} ms - Unix time in ms
 * @param {Function} _ - gettext
 * @param {number} now - Unix time in ms
 * @returns {string}
 */
export function relativeDay(ms, _, now = Date.now()) {
    const days = Math.round((midnight(ms) - midnight(now)) / DAY_MS);
    if (days <= 0)
        return '';
    if (days === 1)
        return _('tomorrow');
    return GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000)).format('%a');
}

/**
 * Abbreviated names of the days of the week, Monday first, in the user's
 * language.
 *
 * @returns {string[]}
 */
export function weekdayNames() {
    // 1 January 2024 was a Monday
    return Array.from({length: DAY_COUNT},
        (_unused, i) => GLib.DateTime.new_local(2024, 1, 1 + i, 12, 0, 0).format('%a'));
}

/**
 * "Every day", "Weekdays", "Once", "Mon, Wed, Fri"…
 *
 * @param {number} days - bit mask, see EVERY_DAY
 * @param {Function} _ - gettext
 * @returns {string}
 */
export function describeDays(days, _) {
    switch (days) {
    case EVERY_DAY:
        return _('Every day');
    case WEEKDAYS:
        return _('Weekdays');
    case WEEKEND:
        return _('Weekends');
    case 0:
        return _('Once');
    default:
        return weekdayNames().filter((_name, i) => days & (1 << i)).join(', ');
    }
}

/**
 * Parses "-5 1 5, 30" into [-5, 1, 5, 30]; null if anything is invalid.
 * Negative values are buttons that subtract minutes.
 *
 * @param {string} text
 * @returns {number[]|null}
 */
export function parsePresets(text) {
    const parts = text.replaceAll('−', '-').split(/[\s,;]+/).filter(Boolean);
    if (parts.length === 0 || parts.length > 12)
        return null;

    const values = [];
    for (const part of parts) {
        if (!/^-?\d+$/.test(part))
            return null;
        const value = Number(part);
        if (value === 0 || Math.abs(value) > 1440)
            return null;
        if (!values.includes(value))
            values.push(value);
    }
    return values;
}
