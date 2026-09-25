/** Remembers which `data.event_id`s were handled. Delivery is at least once. */
export interface DedupeStore {
  /** Returns true the first time an id is seen, false for a repeat. */
  claim(eventId: string): Promise<boolean> | boolean;
}

/** In-process dedupe, bounded by age and by count. Use a shared store with several replicas. */
export class MemoryDedupeStore implements DedupeStore {
  readonly #seen = new Map<string, number>();
  constructor(
    private readonly options: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  claim(eventId: string): boolean {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 24 * 60 * 60 * 1000;
    const seenAt = this.#seen.get(eventId);
    if (seenAt !== undefined && now - seenAt < ttl) return false;
    this.#seen.delete(eventId);
    this.#seen.set(eventId, now);
    const max = this.options.maxEntries ?? 10_000;
    for (const [id, at] of this.#seen) {
      if (this.#seen.size <= max && now - at < ttl) break;
      this.#seen.delete(id);
    }
    return true;
  }
}
