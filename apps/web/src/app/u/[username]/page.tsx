import type { ProfilePageView } from '@cb/contracts';
import type { Metadata } from 'next';
import { serverGet } from '@/lib/server-api';
import { ProfileView } from './profile-view';

interface Props {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

/**
 * Server-rendered from the profile BFF (with the visitor's cookie), so the card, stats and history
 * are in the HTML: on a phone the page no longer waits for JS → session → data (LCP 7 s → <2.5 s).
 * The client takes over with the same data and refreshes it live.
 */
export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  const initial = await serverGet<ProfilePageView>(`/bff/profile/${encodeURIComponent(username)}`);
  return <ProfileView username={username} initial={initial} />;
}
