// The hourly cron. It finds installations whose chosen local hour has arrived and queues a
// run of docturnal.yml for each of their repositories.

import type { QueueMessage } from './handlers';
import { type CommentLevel, DEFAULT_SETTINGS, type ExistingCode, SettingsStore } from './settings';

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

// Returns how many installations were due and how many runs were queued. One installation's
// failure never stops the others: its runs wait for the next night, and batches are sent as
// they fill, so the runs queued before a failure still go.
export async function runSchedule(env: ScheduleEnv, now: Date, log: (line: string) => void) {
  const store = new SettingsStore(env.SETTINGS);
  let pending: { body: QueueMessage }[] = [];
  let due = 0;
  let queued = 0;
  let failed = 0;
  const flush = async () => {
    const batch = pending;
    pending = [];
    try {
      await env.SETUP_QUEUE.sendBatch(batch);
      queued += batch.length;
    } catch (err) {
      failed += batch.length;
      log(`cron ${now.toISOString()}: could not queue ${batch.length} runs, ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  // The key list gives each installation's repositories, schedule, and choices. Only a
  // settings key saved before the choices were in its metadata is read.
  for await (const { installationId, schedule, repos, hasSettings } of store.schedules()) {
    if (!isDue(schedule.time, schedule.timeZone, now)) continue;
    let choices: { commentLevel: CommentLevel; existingCode: ExistingCode } = DEFAULT_SETTINGS;
    if (schedule.commentLevel && schedule.existingCode) {
      choices = { commentLevel: schedule.commentLevel, existingCode: schedule.existingCode };
    } else if (hasSettings) {
      try {
        choices = (await store.getChoices(installationId)) ?? DEFAULT_SETTINGS;
      } catch (err) {
        // Never run with the defaults instead: they might comment code the owner turned off.
        log(`cron ${now.toISOString()}: skipped installation ${installationId} this hour, could not read its settings (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
    }
    due++;
    for (const repo of repos) {
      pending.push({ body: { kind: 'dispatch', installationId, repo, reason: 'nightly', commentLevel: choices.commentLevel, existingCode: choices.existingCode } });
      if (pending.length >= QUEUE_BATCH_LIMIT) await flush();
    }
  }
  if (pending.length) await flush();
  log(`cron ${now.toISOString()}: ${due} ${due === 1 ? 'installation' : 'installations'} due, queued ${queued} ${queued === 1 ? 'run' : 'runs'}${failed ? `, ${failed} not queued` : ''}`);
  return { due, queued };
}
