import type { Metadata } from 'next';
import { LobbyView } from './lobby-view';

export const metadata: Metadata = { title: 'Lobby' };

export default function LobbyPage() {
  return <LobbyView />;
}
