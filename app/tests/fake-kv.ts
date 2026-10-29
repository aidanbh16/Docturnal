// An in-memory Workers KV namespace for tests, with key metadata and paged listing.

interface Entry {
  value: string;
  metadata: unknown;
}

interface Installation {
  time: number;
  timeZone: string;
  commentLevel: string;
  existingCode?: string;
  privateMinutes?: number;
  repos: string[];
}

export class FakeKV {
  data = new Map<string, Entry>();
  // Keys read with get or listed by prefix, in order.
  reads: string[] = [];
  private hold: { count: number; pending: number; reached: () => void; gate: Promise<void> } | null = null;

  constructor(private readonly pageSize = 1000) {}

  // Holds every put until `count` puts are waiting, then applies them when release() is
  // called, so a test can make writes from separate requests overlap.
  holdWrites(count: number): { reached: Promise<void>; release: () => void } {
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    this.hold = { count, pending: 0, reached, gate };
    return { reached: reachedPromise, release: () => { this.hold = null; release(); } };
  }

  async get(key: string, type?: string | { type: string }): Promise<unknown> {
    this.reads.push(key);
    const entry = this.data.get(key);
    if (!entry) return null;
    const kind = typeof type === 'string' ? type : type?.type;
    return kind === 'json' ? JSON.parse(entry.value) : entry.value;
  }

  async put(key: string, value: string, options?: { metadata?: unknown }): Promise<void> {
    const hold = this.hold;
    if (hold) {
      if (++hold.pending >= hold.count) hold.reached();
      await hold.gate;
    }
    this.data.set(key, { value, metadata: options?.metadata ?? null });
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  // Returns a paginated list of keys from the FakeKV store, filtered by prefix and sorted.
  async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
    this.reads.push(`${prefix}*`);
    const names = [...this.data.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + this.pageSize);
    const complete = start + this.pageSize >= names.length;
    return {
      keys: page.map((name) => ({ name, metadata: this.data.get(name)!.metadata })),
      list_complete: complete,
      cursor: complete ? undefined : String(start + this.pageSize),
    };
  }

  // Writes an installation's two keys the way the app stores them.
  seed(id: number, { time, timeZone, commentLevel, existingCode, privateMinutes, repos }: Installation): void {
    for (const repo of repos) this.data.set(`install:${id}:repo:${repo}`, { value: '', metadata: null });
    this.data.set(`install:${id}:settings`, { value: JSON.stringify({ time, timeZone, commentLevel, ...(existingCode ? { existingCode } : {}), ...(privateMinutes ? { privateMinutes } : {}) }), metadata: { time, timeZone } });
  }

  // The repositories that have a key, sorted.
  repos(id: number): string[] {
    const prefix = `install:${id}:repo:`;
    return [...this.data.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
  }

  // Reads the keys back as one object; a missing settings key means the defaults.
  installation(id: number): Installation | undefined {
    const repos = this.repos(id);
    const settings = this.json(`install:${id}:settings`) as Omit<Installation, 'repos'> | undefined;
    if (!repos.length && !settings) return undefined;
    return { ...(settings ?? { time: 0, timeZone: 'America/New_York', commentLevel: 'medium' }), repos };
  }

  json(key: string): unknown {
    const entry = this.data.get(key);
    return entry ? JSON.parse(entry.value) : undefined;
  }
}
