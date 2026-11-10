'use client';

import { useState } from 'react';
import { cn } from './components';

const initialsOf = (name: string) =>
  name
    .split(/[s_]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';

export interface UserAvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const SIZE = { sm: 'size-8 text-xs', md: 'size-10 text-sm', lg: 'size-20 text-2xl' } as const;

/** Uploaded avatar, or initials on a tinted circle if there is none or it fails to load. */
export function UserAvatar({ name, src, size = 'md', className }: UserAvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = src && failed !== src;
  return (
    <span className={cn('relative inline-flex shrink-0 overflow-hidden rounded-full', SIZE[size], className)}>
      {showImage ? (
        <img
          src={src}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          onError={() => setFailed(src)}
        />
      ) : (
        <span
          aria-hidden
          className="flex size-full items-center justify-center bg-primary/20 font-semibold text-primary"
        >
          {initialsOf(name)}
        </span>
      )}
    </span>
  );
}
