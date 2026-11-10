/** 1536 → "1.5 KB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Error details from the API (`{ message }[]`), or none. */
export function detailMessages(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details
    .map((d) => (typeof d === 'object' && d && 'message' in d ? String(d.message) : null))
    .filter((m): m is string => !!m);
}
