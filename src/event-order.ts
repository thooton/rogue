// Relays answer a NIP-01 filter in no guaranteed order, and a Rogue reading its
// network wants the newest thing first and a way to walk backwards from there.
// Both are done here so the public reader and the direct-message reader agree.

export interface OrderedEvent {
  id: string;
  created_at: number;
}

/**
 * Newest first, oldest last. Events sharing a timestamp fall back to their id
 * so that repeated reads of the same page return the same order, which is what
 * makes a cursor mean anything.
 */
export function newestFirst<T extends OrderedEvent>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The cursor for the page after these events, or undefined when there is no
 * next page.
 *
 * A relay that returned fewer events than were asked for had nothing older to
 * give, so a short page ends the walk. Otherwise the cursor is the oldest
 * timestamp received — including from events the caller went on to discard,
 * since the walk has still passed them.
 *
 * NIP-01's `until` is inclusive, so an event sharing the cursor's exact
 * timestamp appears on both pages. Callers de-duplicate by id.
 */
export function nextCursor(received: readonly OrderedEvent[], limit: number): number | undefined {
  if (received.length === 0 || received.length < limit) return undefined;
  return received.reduce((oldest, event) => Math.min(oldest, event.created_at), Number.POSITIVE_INFINITY);
}

/** Drop repeats of an id, keeping the first occurrence. */
export function uniqueById<T extends { id: string }>(events: readonly T[]): T[] {
  const seen = new Set<string>();
  return events.filter((event) => !seen.has(event.id) && (seen.add(event.id), true));
}
