import type { Metadata } from 'next';
import { Suspense } from 'react';
import { FriendsView } from './friends-view';

export const metadata: Metadata = { title: 'Friends' };

export default function FriendsPage() {
  return (
    <Suspense>
      <FriendsView />
    </Suspense>
  );
}
