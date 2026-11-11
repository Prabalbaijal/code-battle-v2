import type { Metadata } from 'next';
import { BattleRoom } from './battle-room';

export const metadata: Metadata = { title: 'Battle', robots: { index: false, follow: false } };

export default async function BattlePage({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  return <BattleRoom matchId={matchId} />;
}
