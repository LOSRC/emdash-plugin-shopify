/**
 * The run lock: one sync at a time. EmDash's Block Kit page leaves the Sync button clickable while a
 * run is going, and a script may call the route too, so two runs can overlap and make a draft each for
 * the same product. The lock lives in the plugin's `ctx.kv`, which can write a key only when nobody
 * else has (`compareAndSet`), so taking it is atomic.
 *
 * A lock carries the time it was taken and goes stale after {@link RUN_LOCK_TTL_MS}: a run that dies
 * (the Worker is killed mid-sync) never releases it, and a later press takes it over. Nothing here
 * imports `emdash`.
 */

/** A run is given this long. A sync of a few hundred products takes seconds; ten minutes is generous. */
export const RUN_LOCK_TTL_MS = 10 * 60 * 1000;

const LOCK_KEY = 'sync:lock';

/** The part of `ctx.kv` the lock uses. */
export interface LockKv {
  getVersioned<T>(key: string): Promise<{ value: T; revision: string } | null>;
  compareAndSet(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: true; revision: string } | { applied: false }>;
  compareAndDelete(key: string, expectedRevision: string): Promise<{ applied: boolean }>;
}

export interface RunLock {
  /** Let go of the lock. A no-op if the lock has since been taken over by another run. Never rejects. */
  release(): Promise<void>;
}

interface StoredLock {
  at?: unknown;
}

/** Is a stored lock still within its time? One with no readable timestamp counts as stale, so junk cannot block syncing for good. */
function isLive(stored: StoredLock | null, now: number): boolean {
  const taken = typeof stored?.at === 'string' ? Date.parse(stored.at) : Number.NaN;
  return Number.isFinite(taken) && now - taken < RUN_LOCK_TTL_MS;
}

/**
 * Try to take the lock. Resolves the lock, or `null` when a live run holds it. A stale lock is taken
 * over, and still atomically: two presses that both see the stale lock race on its revision, and one wins.
 */
export async function acquireRunLock(kv: LockKv, now: number = Date.now()): Promise<RunLock | null> {
  const held = await kv.getVersioned<StoredLock>(LOCK_KEY);
  if (held && isLive(held.value, now)) return null;

  const taken = await kv.compareAndSet(LOCK_KEY, held ? held.revision : null, { at: new Date(now).toISOString() });
  if (!taken.applied) return null;

  // `taken.revision` is how this run's lock is told from a later holder's.
  const { revision } = taken;
  return {
    async release() {
      try {
        await kv.compareAndDelete(LOCK_KEY, revision);
      } catch {
        // A lock that cannot be released goes stale by itself.
      }
    },
  };
}
