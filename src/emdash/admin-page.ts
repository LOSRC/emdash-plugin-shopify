import type { SyncReport } from '../sync/types';

/** One Block Kit block. The host does not validate a native plugin's blocks, so this stays loose. */
export type Block = { type: string } & Record<string, unknown>;

/** What a Block Kit page answers with (`BlockResponse` in `@emdash-cms/blocks`). */
export interface BlockResponse {
  blocks: Block[];
  toast?: { message: string; type: 'success' | 'error' | 'info' };
}

/** The outcome of one run, kept so the page shows the last one when it opens. */
export interface StoredRun {
  at: string;
  report?: SyncReport;
  error?: string;
  /** Set when no run was made because another was still going. Such an outcome is never stored as the last run. */
  busy?: true;
}

export interface AdminDeps {
  /** Run a sync. Resolves with the outcome even when the run was refused or another is running; it does not reject. */
  sync(): Promise<StoredRun>;
  lastRun(): Promise<StoredRun | null>;
  saveRun(run: StoredRun): Promise<void>;
}

export const SYNC_ACTION = 'sync';
const CREATED_PAGE_ACTION = 'created_page';
const FLAGGED_PAGE_ACTION = 'flagged_page';
/** The most rows a table shows; a block response is limited in size. */
const ROW_CAP = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The Sync page's one handler: the host posts `page_load` when the page opens and `block_action`
 * when a button is pressed. Only `block_action` with the Sync button's id runs a sync; everything
 * else re-renders the page, so a stray request cannot start one.
 */
export async function handleAdminInteraction(input: unknown, deps: AdminDeps): Promise<BlockResponse> {
  const interaction = isRecord(input) ? input : {};

  if (interaction.type === 'block_action' && interaction.action_id === SYNC_ACTION) {
    const run = await deps.sync();
    // Another run holds the lock: say so, and keep showing the last real run.
    if (run.busy) {
      return { blocks: renderPage(await deps.lastRun()), toast: { message: run.error ?? 'A sync is already running.', type: 'info' } };
    }
    await deps.saveRun(run);
    return { blocks: renderPage(run), toast: toastFor(run) };
  }
  return { blocks: renderPage(await deps.lastRun()) };
}

function toastFor(run: StoredRun): NonNullable<BlockResponse['toast']> {
  if (!run.report) return { message: 'The sync did not run.', type: 'error' };
  const { created, flagged, unchanged } = run.report;
  return {
    message: `Sync finished: ${created.length} created, ${flagged.length} flagged, ${unchanged} unchanged.`,
    type: 'success',
  };
}

function renderPage(run: StoredRun | null): Block[] {
  const blocks: Block[] = [
    { type: 'header', text: 'Shopify sync' },
    {
      type: 'section',
      text:
        'Makes a draft product for every product on the sales channel that has no entry yet, and lists entries whose product Shopify no longer returns. It never changes or deletes an entry. It also refreshes the shop data the site shows.',
    },
    { type: 'actions', elements: [{ type: 'button', action_id: SYNC_ACTION, label: 'Sync now', style: 'primary' }] },
  ];
  if (!run) return blocks;

  blocks.push({ type: 'divider' });
  if (!run.report) {
    blocks.push({ type: 'banner', variant: 'error', title: 'The sync did not run', description: run.error ?? 'Unknown error.' });
    blocks.push({ type: 'context', text: `Last attempt ${run.at}` });
    return blocks;
  }

  const { created, flagged, unchanged, warnings } = run.report;
  blocks.push({
    type: 'stats',
    items: [
      { label: 'Created', value: created.length },
      { label: 'Flagged', value: flagged.length },
      { label: 'Unchanged', value: unchanged },
    ],
  });
  for (const warning of warnings) blocks.push({ type: 'banner', variant: 'alert', description: warning });

  if (created.length > 0) {
    blocks.push({ type: 'header', text: 'Drafts created' });
    blocks.push({
      type: 'table',
      columns: [
        { key: 'handle', label: 'Handle' },
        { key: 'title', label: 'Title' },
        { key: 'slug', label: 'Slug' },
      ],
      rows: created.slice(0, ROW_CAP).map(({ handle, title, slug }) => ({ handle, title, slug: slug ?? '' })),
      page_action_id: CREATED_PAGE_ACTION,
    });
    blocks.push(...overflow(created.length));
  }
  if (flagged.length > 0) {
    blocks.push({ type: 'header', text: 'Flagged: Shopify no longer returns these' });
    blocks.push({
      type: 'section',
      text: 'Deleted or unpublished in Shopify. Nothing was changed; unpublish or remove the entry yourself if it should go.',
    });
    blocks.push({
      type: 'table',
      columns: [
        { key: 'title', label: 'Title' },
        { key: 'shopifyId', label: 'Shopify ID' },
        { key: 'slug', label: 'Slug' },
      ],
      rows: flagged.slice(0, ROW_CAP).map(({ title, shopifyId, slug }) => ({ title, shopifyId, slug: slug ?? '' })),
      page_action_id: FLAGGED_PAGE_ACTION,
    });
    blocks.push(...overflow(flagged.length));
  }
  blocks.push({ type: 'context', text: `Last run ${run.at}` });
  return blocks;
}

function overflow(total: number): Block[] {
  return total > ROW_CAP ? [{ type: 'context', text: `${total - ROW_CAP} more not shown.` }] : [];
}
