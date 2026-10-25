// Per-installation settings in Cloudflare KV. No key is ever read and written back, so two
// writers can never overwrite each other:
// - install:<id>:repo:<owner>/<name>  one empty key per repository, created and deleted by
//                                     webhooks.
// - install:<id>:settings             the run time, time zone, comment level, and what to do
//                                     with existing code, written only by the settings page.
//                                     Without it, the defaults apply.
// Nothing else is stored, and never code.

export const COMMENT_LEVELS = ['low', 'medium', 'heavy', 'off'] as const;
export type CommentLevel = (typeof COMMENT_LEVELS)[number];

// Existing code: "gradual" comments it in small batches after the first run documents the
// project; "none" comments only new and changed code.
export const EXISTING_CODE = ['gradual', 'none'] as const;
export type ExistingCode = (typeof EXISTING_CODE)[number];

export interface Settings {
  time: number;
  timeZone: string;
  commentLevel: CommentLevel;
  existingCode: ExistingCode;
  repos: string[];
}

export type Choices = Omit<Settings, 'repos'>;

export const DEFAULT_SETTINGS: Choices = { time: 0, timeZone: 'America/New_York', commentLevel: 'medium', existingCode: 'gradual' };

// The schedule is copied into the settings key's metadata, so the hourly cron can find due
// installations from the key list without reading every entry.
export interface ScheduleMetadata {
  time: number;
  timeZone: string;
}

const PREFIX = 'install:';
const KEY = /^install:(\d+):(?:settings|repo:(.+))$/;

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function isValidHour(hour: unknown): hour is number {
  return Number.isInteger(hour) && (hour as number) >= 0 && (hour as number) <= 23;
}

export function isCommentLevel(level: unknown): level is CommentLevel {
  return COMMENT_LEVELS.includes(level as CommentLevel);
}

export function isExistingCode(value: unknown): value is ExistingCode {
  return EXISTING_CODE.includes(value as ExistingCode);
}

function parseChoices(raw: unknown): Choices | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<Choices>;
  return {
    time: isValidHour(data.time) ? data.time : DEFAULT_SETTINGS.time,
    timeZone: isValidTimeZone(data.timeZone) ? data.timeZone : DEFAULT_SETTINGS.timeZone,
    commentLevel: isCommentLevel(data.commentLevel) ? data.commentLevel : DEFAULT_SETTINGS.commentLevel,
    existingCode: isExistingCode(data.existingCode) ? data.existingCode : DEFAULT_SETTINGS.existingCode,
  };
}

export function isDefault(settings: Choices): boolean {
  return settings.time === DEFAULT_SETTINGS.time && settings.timeZone === DEFAULT_SETTINGS.timeZone &&
    settings.commentLevel === DEFAULT_SETTINGS.commentLevel && settings.existingCode === DEFAULT_SETTINGS.existingCode;
}

export class SettingsStore {
  constructor(private readonly kv: KVNamespace) {}

  private prefix(installationId: number): string {
    return `${PREFIX}${installationId}:`;
  }

  private repoPrefix(installationId: number): string {
    return `${this.prefix(installationId)}repo:`;
  }

  private settingsKey(installationId: number): string {
    return `${this.prefix(installationId)}settings`;
  }

  // Lists every key name under a prefix, following the cursor across pages.
  private async *keys<M = unknown>(prefix: string): AsyncGenerator<{ name: string; metadata?: M | null }> {
    let cursor: string | undefined;
    do {
      const page = await this.kv.list<M>({ prefix, cursor });
      yield* page.keys;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }

  // Returns the settings and repositories combined, or null when the installation has neither.
  async get(installationId: number): Promise<Settings | null> {
    const [choices, repos] = await Promise.all([this.getChoices(installationId), this.getRepos(installationId)]);
    if (!choices && !repos.length) return null;
    return { ...(choices ?? DEFAULT_SETTINGS), repos };
  }

  // Returns the stored settings, or the defaults when the installation has none yet.
  async getOrDefault(installationId: number): Promise<Settings> {
    return (await this.get(installationId)) ?? { ...DEFAULT_SETTINGS, repos: [] };
  }

  async getChoices(installationId: number): Promise<Choices | null> {
    return parseChoices(await this.kv.get(this.settingsKey(installationId), 'json'));
  }

  async getRepos(installationId: number): Promise<string[]> {
    const prefix = this.repoPrefix(installationId);
    const repos: string[] = [];
    for await (const key of this.keys(prefix)) repos.push(key.name.slice(prefix.length));
    return repos.sort();
  }

  // Saves the settings page's choices. It never touches the repository keys.
  async putChoices(installationId: number, choices: Choices): Promise<void> {
    const metadata: ScheduleMetadata = { time: choices.time, timeZone: choices.timeZone };
    const value: Choices = { time: choices.time, timeZone: choices.timeZone, commentLevel: choices.commentLevel, existingCode: choices.existingCode };
    await this.kv.put(this.settingsKey(installationId), JSON.stringify(value), { metadata });
  }

  // Webhooks create and delete one key per repository; nothing is read first.
  async addRepos(installationId: number, repos: string[]): Promise<void> {
    await Promise.all([...new Set(repos)].map((repo) => this.kv.put(`${this.repoPrefix(installationId)}${repo}`, '')));
  }

  async removeRepos(installationId: number, repos: string[]): Promise<void> {
    await Promise.all([...new Set(repos)].map((repo) => this.kv.delete(`${this.repoPrefix(installationId)}${repo}`)));
  }

  // Deletes every key with the install:<id>: prefix.
  async delete(installationId: number): Promise<void> {
    const names: string[] = [];
    for await (const key of this.keys(this.prefix(installationId))) names.push(key.name);
    await Promise.all(names.map((name) => this.kv.delete(name)));
  }

  // Yields every installation with at least one repository, its repositories, and its
  // schedule from the settings key's metadata, or the default schedule without one.
  async *schedules(): AsyncGenerator<{ installationId: number; schedule: ScheduleMetadata; repos: string[] }> {
    const installations = new Map<number, { repos: string[]; schedule: ScheduleMetadata }>();
    for await (const key of this.keys<ScheduleMetadata>(PREFIX)) {
      const match = KEY.exec(key.name);
      if (!match) continue;
      const installationId = Number(match[1]);
      const entry = installations.get(installationId) ?? { repos: [], schedule: { time: DEFAULT_SETTINGS.time, timeZone: DEFAULT_SETTINGS.timeZone } };
      if (match[2] !== undefined) {
        entry.repos.push(match[2]);
      } else {
        const meta = key.metadata;
        entry.schedule = {
          time: meta && isValidHour(meta.time) ? meta.time : DEFAULT_SETTINGS.time,
          timeZone: meta && isValidTimeZone(meta.timeZone) ? meta.timeZone : DEFAULT_SETTINGS.timeZone,
        };
      }
      installations.set(installationId, entry);
    }
    for (const [installationId, entry] of installations) {
      if (entry.repos.length) yield { installationId, schedule: entry.schedule, repos: entry.repos.sort() };
    }
  }
}
