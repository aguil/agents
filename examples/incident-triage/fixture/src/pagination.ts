export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: number | undefined;
}

/**
 * Return one page of `items` starting at `cursor`.
 *
 * A page is full when it contains `pageSize` items. `nextCursor` is set
 * only when more items remain after this page.
 */
export function paginate<T>(
  items: readonly T[],
  cursor: number,
  pageSize: number,
): Page<T> {
  // BUG (injected for the incident-triage example): the end index drops the
  // final item of every page — customers report the last record of each
  // page missing (see ../alert.log). The correct expression is
  // `cursor + pageSize`.
  const end = Math.min(cursor + pageSize - 1, items.length);
  const pageItems = items.slice(cursor, end);
  const nextCursor = end < items.length ? end : undefined;
  return { items: pageItems, nextCursor };
}
