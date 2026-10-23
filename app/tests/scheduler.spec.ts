import { describe, expect, it } from 'vitest';
import { isDue, localHour } from '../src/scheduler';

const HOUR = 60 * 60 * 1000;

const localTime = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).format(date);
const localDate = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

// The cron runs at minute 7 of every UTC hour. Returns the runs that would dispatch.
function runs(chosenHour: number, timeZone: string, fromUtc: string, toUtc: string): Date[] {
  const due: Date[] = [];
  for (let t = Date.parse(fromUtc); t < Date.parse(toUtc); t += HOUR) {
    if (isDue(chosenHour, timeZone, new Date(t))) due.push(new Date(t));
  }
  return due;
}

describe('localHour', () => {
  it('reads the wall-clock hour with daylight saving time', () => {
    expect(localHour(new Date('2026-01-15T10:07:00Z'), 'America/Los_Angeles')).toBe(2);
    expect(localHour(new Date('2026-07-15T09:07:00Z'), 'America/Los_Angeles')).toBe(2);
    expect(localHour(new Date('2026-01-15T05:07:00Z'), 'America/New_York')).toBe(0);
    expect(localHour(new Date('2026-07-15T04:07:00Z'), 'America/New_York')).toBe(0);
  });
});

describe('2 AM in America/Los_Angeles', () => {
  const zone = 'America/Los_Angeles';

  it('runs at 2 AM Pacific on both sides of the spring change, and at 3 AM on the day 2 AM does not exist', () => {
    // Clocks go from 2:00 PST to 3:00 PDT on 8 March 2026 (10:00 UTC).
    const due = runs(2, zone, '2026-03-06T00:07:00Z', '2026-03-11T00:07:00Z');
    expect(due.map((d) => d.toISOString())).toEqual([
      '2026-03-06T10:07:00.000Z',
      '2026-03-07T10:07:00.000Z',
      '2026-03-08T10:07:00.000Z',
      '2026-03-09T09:07:00.000Z',
      '2026-03-10T09:07:00.000Z',
    ]);
    expect(due.map((d) => localTime(d, zone))).toEqual([
      '2026-03-06, 02:07 PST',
      '2026-03-07, 02:07 PST',
      '2026-03-08, 03:07 PDT',
      '2026-03-09, 02:07 PDT',
      '2026-03-10, 02:07 PDT',
    ]);
  });

  it('runs once at 2 AM Pacific on both sides of the fall change', () => {
    // Clocks go from 2:00 PDT back to 1:00 PST on 1 November 2026 (09:00 UTC).
    const due = runs(2, zone, '2026-10-30T00:07:00Z', '2026-11-03T00:07:00Z');
    expect(due.map((d) => localTime(d, zone))).toEqual([
      '2026-10-30, 02:07 PDT',
      '2026-10-31, 02:07 PDT',
      '2026-11-01, 02:07 PST',
      '2026-11-02, 02:07 PST',
    ]);
  });

  it('runs only once at 1 AM when 1 AM happens twice', () => {
    const due = runs(1, zone, '2026-11-01T00:07:00Z', '2026-11-02T00:07:00Z');
    expect(due.map((d) => localTime(d, zone))).toEqual(['2026-11-01, 01:07 PDT']);
  });
});

describe('midnight in America/New_York (the default)', () => {
  const zone = 'America/New_York';

  it('runs at local midnight on both sides of the spring change', () => {
    // Clocks go from 2:00 EST to 3:00 EDT on 8 March 2026.
    const due = runs(0, zone, '2026-03-06T12:07:00Z', '2026-03-10T12:07:00Z');
    expect(due.map((d) => d.toISOString())).toEqual([
      '2026-03-07T05:07:00.000Z',
      '2026-03-08T05:07:00.000Z',
      '2026-03-09T04:07:00.000Z',
      '2026-03-10T04:07:00.000Z',
    ]);
    expect(due.map((d) => localTime(d, zone).slice(12))).toEqual(['00:07 EST', '00:07 EST', '00:07 EDT', '00:07 EDT']);
  });

  it('runs at local midnight on both sides of the fall change', () => {
    const due = runs(0, zone, '2026-10-30T12:07:00Z', '2026-11-03T12:07:00Z');
    expect(due.map((d) => d.toISOString())).toEqual([
      '2026-10-31T04:07:00.000Z',
      '2026-11-01T04:07:00.000Z',
      '2026-11-02T05:07:00.000Z',
      '2026-11-03T05:07:00.000Z',
    ]);
  });
});

describe('every hour, every day around both changes', () => {
  for (const zone of ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Kolkata']) {
    it(`runs exactly once per local day for every chosen hour in ${zone}`, () => {
      for (const [from, to] of [['2026-03-01T00:07:00Z', '2026-04-05T00:07:00Z'], ['2026-10-20T00:07:00Z', '2026-11-10T00:07:00Z']]) {
        for (let hour = 0; hour < 24; hour++) {
          const perDay = new Map<string, number>();
          for (const run of runs(hour, zone, from, to)) {
            const day = localDate(run, zone);
            perDay.set(day, (perDay.get(day) ?? 0) + 1);
          }
          // Drop the partial first and last days of the window.
          const days = [...perDay.keys()].sort().slice(1, -1);
          expect(days.length, `${zone} ${hour}:00`).toBeGreaterThan(15);
          for (const day of days) expect(perDay.get(day), `${zone} ${hour}:00 on ${day}`).toBe(1);
        }
      }
    });
  }
});
