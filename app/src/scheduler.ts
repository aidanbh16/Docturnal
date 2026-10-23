// The hourly cron. It finds installations whose chosen local hour has arrived and queues a
// run of docturnal.yml for each of their repositories.

import type { QueueMessage } from './handlers';
import { DEFAULT_SETTINGS, SettingsStore } from './settings';

const HOUR_MS = 60 * 60 * 1000;
const QUEUE_BATCH_LIMIT = 100;

const formatters = new Map<string, Intl.DateTimeFormat>();

// The hour on the wall clock in timeZone, 0 to 23. Intl handles daylight saving time.
export function localHour(date: Date, timeZone: string): number {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const hour = formatter
    .formatToParts(date)
    .find((part) => part.type === 'hour');
  return Number(hour?.value ?? 0) % 24;
}

// True when the chosen local hour arrived since the previous hourly run. Comparing with the
// previous run, instead of testing for equality, makes daylight saving time work:
// - When clocks go forward and the chosen hour does not exist that day (2 AM in the US),
//   the run happens at the next run, an hour later on the clock.
// - When clocks go back and an hour repeats (1 AM in the US), the run happens only once.
export function isDue(chosenHour: number, timeZone: string, now: Date): boolean {
  const current = localHour(now, timeZone);
  const previous = localHour(new Date(now.getTime() - HOUR_MS), timeZone);
  if (current === previous) return false;
  if (previous < current) return chosenHour > previous && chosenHour <= current;
  // The clock passed midnight between the two runs.
  return chosenHour > previous || chosenHour <= current;
}

export interface ScheduleEnv {
  SETTINGS: KVNamespace;
  SETUP_QUEUE: Queue<QueueMessage>;
}

// Returns how many installations were due and how many runs were queued.
export async function runSchedule(env: ScheduleEnv, now: Date, log: (line: string) => void) {
  const store = new SettingsStore(env.SETTINGS);
  const messages: { body: QueueMessage }[] = [];
  let due = 0;
  // The key list gives each installation's repositories and schedule; only due installations
  // read their settings key, for the comment level.
  for await (const { installationId, schedule, repos } of store.schedules()) {
    if (!isDue(schedule.time, schedule.timeZone, now)) continue;
    const { commentLevel } = (await store.getChoices(installationId)) ?? DEFAULT_SETTINGS;
    due++;
    for (const repo of repos) {
      messages.push({ body: { kind: 'dispatch', installationId, repo, reason: 'nightly', commentLevel } });
    }
  }
  for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
    await env.SETUP_QUEUE.sendBatch(messages.slice(i, i + QUEUE_BATCH_LIMIT));
  }
  log(`cron ${now.toISOString()}: ${due} ${due === 1 ? 'installation' : 'installations'} due, queued ${messages.length} ${messages.length === 1 ? 'run' : 'runs'}`);
  return { due, queued: messages.length };
}
