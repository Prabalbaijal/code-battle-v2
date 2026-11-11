'use client';

import { useSyncExternalStore } from 'react';

// ---------------- notices (small, transient) ----------------

interface Notice {
  id: number;
  text: string;
}
let notices: Notice[] = [];
const noticeListeners = new Set<() => void>();
let nextNotice = 1;
export function notify(text: string) {
  const id = nextNotice++;
  notices = [...notices, { id, text }];
  noticeListeners.forEach((f) => f());
  setTimeout(() => {
    notices = notices.filter((n) => n.id !== id);
    noticeListeners.forEach((f) => f());
  }, 5000);
}
export function Notices() {
  const list = useSyncExternalStore(
    (f) => {
      noticeListeners.add(f);
      return () => noticeListeners.delete(f);
    },
    () => notices,
    () => [],
  );
  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 grid gap-2"
      role="status"
      aria-live="polite"
    >
      {list.map((n) => (
        <div
          key={n.id}
          className="animate-rise rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-lg"
        >
          {n.text}
        </div>
      ))}
    </div>
  );
}
