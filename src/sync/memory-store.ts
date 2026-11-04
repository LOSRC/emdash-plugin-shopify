import type { ContentStore, LinkedEntry, NewDraft } from './types';

/**
 * An in-memory {@link ContentStore} for tests. Like EmDash, it derives the slug from the text it is
 * given (`slugify`, then `-2`, `-3` on a collision) and does not let the caller set it, so a test can
 * see the slug policy hold or break.
 */
export interface MemoryContentStore extends ContentStore {
  /** Put an entry in, as if an editor or an earlier sync had made it. */
  seed(entry: LinkedEntry): void;
  /** A snapshot of every entry now, for asserting that nothing changed. */
  entries(): LinkedEntry[];
  /** How many times `createDraft` was called. */
  readonly createCalls: number;
  /** Make the next `createDraft` for this Shopify id reject. */
  failCreateFor(shopifyId: string, error: Error): void;
  /** Make `listLinked` reject. */
  failListWith(error: Error): void;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createMemoryContentStore(): MemoryContentStore {
  const rows: LinkedEntry[] = [];
  const failures = new Map<string, Error>();
  let listFailure: Error | undefined;
  let nextId = 1;
  let createCalls = 0;

  return {
    seed(entry) {
      rows.push({ ...entry });
    },
    entries: () => rows.map((row) => ({ ...row })),
    get createCalls() {
      return createCalls;
    },
    failCreateFor(shopifyId, error) {
      failures.set(shopifyId, error);
    },
    failListWith(error) {
      listFailure = error;
    },
    async listLinked() {
      if (listFailure) throw listFailure;
      return rows.map((row) => ({ ...row }));
    },
    async createDraft(draft: NewDraft) {
      createCalls += 1;
      const failure = failures.get(draft.shopifyId);
      if (failure) throw failure;
      const base = slugify(draft.handle);
      const taken = new Set(rows.map((row) => row.slug));
      let slug = base;
      for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`;
      const entryId = `entry-${nextId++}`;
      rows.push({ entryId, shopifyId: draft.shopifyId, slug, title: draft.title });
      return { entryId, slug };
    },
  };
}
