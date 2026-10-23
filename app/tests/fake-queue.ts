// An in-memory Cloudflare Queue for tests. drain() runs consumer invocations the way
// Cloudflare does: batches of up to batchSize ready messages, explicit ack() and retry(),
// an implicit ack when the consumer returns, a retry of unacked messages when it throws,
// and the dead letter queue after maxRetries retries.

interface Stored<T> {
  id: string;
  body: T;
  attempts: number;
  availableAt: number;
}

export class FakeQueue<T> {
  pending: Stored<T>[] = [];
  deadLetters: T[] = [];
  invocations = 0;
  failNextSends = 0;
  private clock = 0;
  private nextId = 0;

  async send(body: T, options?: { delaySeconds?: number }): Promise<void> {
    await this.sendBatch([{ body, delaySeconds: options?.delaySeconds }]);
  }

  async sendBatch(items: { body: T; delaySeconds?: number }[]): Promise<void> {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      throw new Error('Queue send failed');
    }
    if (items.length > 100) throw new Error('sendBatch accepts at most 100 messages');
    for (const item of items) {
      this.pending.push({
        id: String(++this.nextId),
        body: structuredClone(item.body),
        attempts: 1,
        availableAt: this.clock + (item.delaySeconds ?? 0),
      });
    }
  }

  async drain(
    consume: (batch: MessageBatch<T>) => Promise<void>,
    { batchSize = 5, maxRetries = 10, maxInvocations = 2000 } = {}
  ): Promise<void> {
    while (this.pending.length) {
      const ready = this.pending.filter((m) => m.availableAt <= this.clock);
      if (!ready.length) {
        this.clock = Math.min(...this.pending.map((m) => m.availableAt));
        continue;
      }
      if (++this.invocations > maxInvocations) throw new Error('The queue did not drain');
      const taken = ready.slice(0, batchSize);
      this.pending = this.pending.filter((m) => !taken.includes(m));

      const results = new Map<string, 'ack' | number>();
      const settle = (id: string, result: 'ack' | number) => {
        if (!results.has(id)) results.set(id, result);
      };
      const messages = taken.map((m) => ({
        id: m.id,
        timestamp: new Date(this.clock * 1000),
        body: m.body,
        attempts: m.attempts,
        ack: () => settle(m.id, 'ack'),
        retry: (options?: { delaySeconds?: number }) => settle(m.id, options?.delaySeconds ?? 0),
      }));
      const batch = {
        queue: 'docturnal-setup',
        messages,
        ackAll: () => messages.forEach((m) => m.ack()),
        retryAll: (options?: { delaySeconds?: number }) => messages.forEach((m) => m.retry(options)),
      } as unknown as MessageBatch<T>;

      let threw = false;
      try {
        await consume(batch);
      } catch {
        threw = true;
      }
      for (const m of taken) {
        const result = results.get(m.id) ?? (threw ? 0 : 'ack');
        if (result === 'ack') continue;
        if (m.attempts > maxRetries) this.deadLetters.push(m.body);
        else this.pending.push({ ...m, attempts: m.attempts + 1, availableAt: this.clock + result });
      }
      this.clock += 1;
    }
  }
}
