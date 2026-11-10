import type { Metadata } from 'next';
import { ProfileView } from './profile-view';

interface Props {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

/** Client-rendered for now; becomes ISR with stats in Phase 4 (plan §21.2). */
export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  return <ProfileView username={username} />;
}
