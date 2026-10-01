import { fail } from './errors.js';

export const TIME_ZONE = 'Africa/Cairo';
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, weekday: 'short', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function cairoParts(date) {
  const parts = Object.fromEntries(formatter.formatToParts(date).map(x => [x.type, x.value]));
  return { weekday: days.indexOf(parts.weekday), hour: Number(parts.hour), minute: Number(parts.minute),
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

export function formatCairo(value) {
  const p = cairoParts(new Date(value));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')} Africa/Cairo`;
}

export function parseInstant(value, name = 'timestamp') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    fail('VALIDATION_ERROR', `${name} must be an ISO timestamp with Z or an offset`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) fail('VALIDATION_ERROR', `${name} is invalid`);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day) {
    fail('VALIDATION_ERROR', `${name} has an invalid calendar date`);
  }
  return new Date(ms).toISOString();
}

export function validateCalendar(config) {
  const weekdays = config?.workingWeekdays;
  if (!Array.isArray(weekdays) || weekdays.length === 0 || weekdays.some(d => !Number.isInteger(d) || d < 0 || d > 6) || new Set(weekdays).size !== weekdays.length) {
    fail('VALIDATION_ERROR', 'workingWeekdays must be a nonempty list of unique integers, Sunday=0 through Saturday=6');
  }
  const holidays = config.holidays ?? [];
  if (!Array.isArray(holidays) || holidays.some(d => typeof d !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(d))) {
    fail('VALIDATION_ERROR', 'holidays must be Cairo calendar dates in YYYY-MM-DD format');
  }
  return { workingWeekdays: new Set(weekdays), holidays: new Set(holidays) };
}

export function normalizeEffort(effort, workingDaysPerWeek) {
  const value = effort?.value;
  const unit = effort?.unit;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || !['hours', 'working_days', 'working_weeks'].includes(unit)) {
    fail('VALIDATION_ERROR', 'effort needs a positive numeric value and unit: hours, working_days, or working_weeks');
  }
  const minutes = value * ({ hours: 60, working_days: 420, working_weeks: 420 * workingDaysPerWeek })[unit];
  if (!Number.isSafeInteger(minutes) || minutes <= 0) fail('VALIDATION_ERROR', 'effort must resolve to a whole number of minutes');
  return { minutes, value, unit };
}

// Walk real UTC minutes so Cairo DST changes cannot shift the working-day calculation.
export function addWorkingMinutes(start, minutes, calendar) {
  let cursor = new Date(start);
  if (!Number.isFinite(cursor.getTime()) || !Number.isSafeInteger(minutes) || minutes < 0) fail('VALIDATION_ERROR', 'invalid working-time input');
  const hadSubMinute = cursor.getUTCSeconds() !== 0 || cursor.getUTCMilliseconds() !== 0;
  cursor.setUTCSeconds(0, 0);
  if (hadSubMinute) cursor = new Date(cursor.getTime() + 60_000);
  let remaining = minutes;
  for (let searched = 0; remaining > 0 && searched < 1_000_000; searched++) {
    const p = cairoParts(cursor);
    const date = `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
    if (calendar.workingWeekdays.has(p.weekday) && !calendar.holidays.has(date) && p.hour >= 10 && p.hour < 17) remaining--;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  if (remaining) fail('VALIDATION_ERROR', 'could not find enough configured working time');
  return cursor.toISOString();
}
