import type { Metadata } from 'next';
import { ProfileView } from './profile-view';

interface Props {
  params: Promise<{ username: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

/** Client-rendered: one BFF call (profile + stats + own history), refreshed live by socket events. */
export default async function ProfilePage({ params }: Props) {
  const { username } = await params;
  return <ProfileView username={username} />;
}
