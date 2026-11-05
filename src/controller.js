// SPDX-License-Identifier: GPL-2.0-or-later
//
// Alarm logic, without any UI. Two kinds of alarm:
//  - the countdown, set from the menu (end-time, message);
//  - alarms at a time of day on chosen days, set in the preferences (alarms).
//
// State lives in GSettings instead of memory. GNOME Shell disables
// extensions when the screen locks and enables them again on unlock, so this
// keeps alarms across locks, logouts and reboots. An alarm that went off
// while the extension was disabled is reported on the next enable, together
// with how late it is.
//
// Instead of one long timeout (GLib uses the monotonic clock, which does not
// advance during suspend) the next tick is scheduled at most 30 s ahead and
// always compared against the wall clock.

import GLib from 'gi://GLib';

import {EventEmitter} from 'resource:///org/gnome/shell/misc/signals.js';

import {
    lastAlarmTime, nextAlarmTime, nextOccurrence, parseClockTime, readAlarms, writeAlarms,
} from './utils.js';

const MINUTE_MS = 60 * 1000;
const MAX_IDLE_TICK_MS = 30 * 1000;
const STARTUP_GRACE_MS = 2000;
const MIN_LEFT_AFTER_SUBTRACT_MS = 1000;
// Missed alarms older than this are dropped silently.
const COUNTDOWN_MISSED_WINDOW_MS = 24 * 60 * MINUTE_MS;
const ALARM_MISSED_WINDOW_MS = 12 * 60 * MINUTE_MS;

export const AlarmKind = Object.freeze({
    COUNTDOWN: 'countdown',
    ALARM: 'alarm',
    TEST: 'test',
});

/**
 * Signals:
 *  - 'changed' ()      state changed, or one more second elapsed
 *  - 'fired'   (info)  time to remind; info = {kind, message, scheduledAt, late}
 *                      plus, for alarms: {index, sound, ringMinutes, snoozeMinutes}
 */
export class AlarmController extends EventEmitter {
    constructor(settings) {
        super();

        this._settings = settings;
        this._timeoutId = 0;
        this._fastTick = false;
        this._graceUntil = 0;

        // Alarms between this point and the next tick are due. It is kept in
        // memory and only saved when one rings or on destroy, so ticking does
        // not write to disk.
        this._alarmsCheckedUntil = this._settings.get_int64('alarms-checked-until') || Date.now();

        this._settings.connectObject(
            'changed::end-time', () => this._onStateChanged(),
            'changed::panel-text', () => this._onStateChanged(),
            'changed::alarms', () => this._onAlarmsChanged(),
            'changed::test-reminder', () => this._fireTest(),
            this);
    }

    get endTime() {
        return this._settings.get_int64('end-time');
    }

    get isRunning() {
        return this.endTime > 0;
    }

    /** @returns {number} ms left on the countdown, 0 if none */
    get remaining() {
        return this.isRunning ? Math.max(0, this.endTime - Date.now()) : 0;
    }

    /** @returns {import('./utils.js').Alarm[]} */
    get alarms() {
        return readAlarms(this._settings);
    }

    /**
     * @param {import('./utils.js').Alarm} alarm
     * @param {number} from - Unix time in ms
     * @returns {number} next time after `from` the alarm rings, or 0
     */
    nextRing(alarm, from = Date.now()) {
        const times = [];
        if (alarm.snoozedUntil > from)
            times.push(alarm.snoozedUntil);
        const time = parseClockTime(alarm.time);
        if (alarm.enabled && time)
            times.push(nextAlarmTime(time, alarm.days, from));
        return times.length > 0 ? Math.min(...times) : 0;
    }

    /** @returns {number} Unix time in ms of the next alarm of the day, or 0 */
    get nextAlarm() {
        const now = Date.now();
        const times = this.alarms.map(alarm => this.nextRing(alarm, now)).filter(t => t > 0);
        return times.length > 0 ? Math.min(...times) : 0;
    }

    /**
     * While the menu is open it needs one tick per second, even when the
     * panel does not show the time left.
     *
     * @param {boolean} fast
     */
    setFastTick(fast) {
        if (this._fastTick === fast)
            return;
        this._fastTick = fast;
        this._schedule();
    }

    /**
     * Whether a minute button can be used now. Subtracting needs a running
     * countdown with more time left than the minutes taken away.
     *
     * @param {number} minutes - negative to subtract
     * @returns {boolean}
     */
    canAdd(minutes) {
        return minutes > 0 ||
            this.remaining + minutes * MINUTE_MS >= MIN_LEFT_AFTER_SUBTRACT_MS;
    }

    /**
     * Adds minutes to the running countdown, or counts them from now.
     * Negative minutes subtract, when canAdd() allows it.
     *
     * @param {number} minutes
     */
    addMinutes(minutes) {
        if (!this.canAdd(minutes))
            return;

        const now = Date.now();
        const base = this.endTime > now ? this.endTime : now;
        let target = base + minutes * MINUTE_MS;

        if (this._settings.get_boolean('round-to-minute')) {
            const rounded = new Date(target);
            rounded.setSeconds(0, 0);
            // Do not round down to something that is basically now
            if (rounded.getTime() - now >= 5000)
                target = rounded.getTime();
        }

        this._setEndTime(target);
    }

    /**
     * Sets the countdown for the next time the clock shows that time.
     *
     * @param {{hours: number, minutes: number}} time
     */
    setAt(time) {
        this._setEndTime(nextOccurrence(time));
    }

    /**
     * Snoozes the countdown (or a test reminder).
     *
     * @param {number} minutes
     * @param {string} [message] - text for the snoozed reminder
     */
    snooze(minutes, message) {
        if (message !== undefined && message !== this._settings.get_string('message'))
            this._settings.set_string('message', message);
        this._setEndTime(Date.now() + minutes * MINUTE_MS);
    }

    /**
     * Makes an alarm ring again later, without touching the countdown.
     *
     * @param {number} index - position in the alarms list
     * @param {number} minutes
     */
    snoozeAlarm(index, minutes) {
        this._updateAlarm(index, alarm => {
            alarm.snoozedUntil = Date.now() + minutes * MINUTE_MS;
        });
    }

    cancel() {
        this._setEndTime(0);
    }

    /**
     * @param {number} index - position in the alarms list
     * @param {boolean} enabled
     */
    setAlarmEnabled(index, enabled) {
        this._updateAlarm(index, alarm => {
            if (alarm.enabled === enabled)
                return false;
            alarm.enabled = enabled;
            alarm.snoozedUntil = 0;
            return true;
        });
    }

    start() {
        // If an alarm went off while the screen was locked, wait for the
        // unlock transition to finish before showing it.
        this._graceUntil = Date.now() + STARTUP_GRACE_MS;
        this._schedule();
        this.emit('changed');
    }

    destroy() {
        this._clearTimeout();
        this._saveAlarmsCheck();
        this._settings.disconnectObject(this);
        this.disconnectAll();
        this._settings = null;
    }

    /**
     * @param {number} index
     * @param {Function} change - edits the alarm; returning false skips saving
     */
    _updateAlarm(index, change) {
        const alarms = readAlarms(this._settings);
        if (!alarms[index] || change(alarms[index]) === false)
            return;
        writeAlarms(this._settings, alarms);
    }

    _setEndTime(ms) {
        this._settings.set_int64('end-time', Math.round(ms));
    }

    _saveAlarmsCheck() {
        this._settings.set_int64('alarms-checked-until', Math.round(this._alarmsCheckedUntil));
    }

    _onStateChanged() {
        this._schedule();
        this.emit('changed');
    }

    _onAlarmsChanged() {
        // After adding or editing alarms, only future occurrences count.
        // Not saved here: destroy() and ringing alarms save it.
        this._alarmsCheckedUntil = Date.now();
        this._onStateChanged();
    }

    _fireTest() {
        this.emit('fired', {
            kind: AlarmKind.TEST,
            message: this._settings.get_string('message'),
            scheduledAt: Date.now(),
            late: 0,
        });
    }

    _tick() {
        const now = Date.now();
        const due = [];

        const end = this.endTime;
        if (end > 0 && now >= end) {
            const message = this._settings.get_string('message');
            this._setEndTime(0);
            if (now - end < COUNTDOWN_MISSED_WINDOW_MS)
                due.push({kind: AlarmKind.COUNTDOWN, message, scheduledAt: end, late: now - end});
        }

        const alarms = readAlarms(this._settings);
        let changed = false;
        let rang = false;
        const ring = (alarm, index, scheduledAt) => {
            rang = true;
            if (now - scheduledAt >= ALARM_MISSED_WINDOW_MS)
                return;
            due.push({
                kind: AlarmKind.ALARM,
                index,
                message: alarm.name,
                sound: alarm.sound,
                ringMinutes: alarm.ringMinutes,
                snoozeMinutes: alarm.snoozeMinutes,
                scheduledAt,
                late: now - scheduledAt,
            });
        };

        alarms.forEach((alarm, index) => {
            if (alarm.snoozedUntil > 0 && alarm.snoozedUntil <= now) {
                ring(alarm, index, alarm.snoozedUntil);
                alarm.snoozedUntil = 0;
                changed = true;
            }

            const time = parseClockTime(alarm.time);
            if (!alarm.enabled || !time)
                return;
            const first = nextAlarmTime(time, alarm.days, this._alarmsCheckedUntil);
            if (first === 0 || first > now)
                return;

            if (alarm.days === 0) {
                // Rings once: on its first occurrence, then switches itself off.
                ring(alarm, index, first);
                alarm.enabled = false;
                changed = true;
            } else {
                ring(alarm, index, lastAlarmTime(time, alarm.days, now));
            }
        });

        if (changed)
            writeAlarms(this._settings, alarms);
        this._alarmsCheckedUntil = now;
        if (rang)
            this._saveAlarmsCheck();

        due.sort((a, b) => a.scheduledAt - b.scheduledAt)
            .forEach(info => this.emit('fired', info));

        this.emit('changed');
        this._schedule();
    }

    _schedule() {
        this._clearTimeout();
        if (!this._settings)
            return;

        const now = Date.now();
        const end = this.endTime;
        const targets = [];
        if (end > 0)
            targets.push(end);
        const next = this.nextAlarm;
        if (next > 0)
            targets.push(next);
        if (targets.length === 0)
            return;

        let delay = Math.min(...targets) - now;

        // While a countdown is on screen, wake up right when the second changes.
        const countdownVisible = this._fastTick ||
            this._settings.get_string('panel-text') === 'remaining';
        if (end > now && countdownVisible)
            delay = Math.min(delay, ((end - now) % 1000 || 1000) + 5);

        delay = Math.min(delay, MAX_IDLE_TICK_MS);
        // Right after enable: a single tick when the grace period ends, which
        // also catches alarms missed while the session was locked.
        if (this._graceUntil > now)
            delay = this._graceUntil - now;
        delay = Math.max(delay, 10);

        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delay), () => {
            this._timeoutId = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }
}
