'use client';

import type { LanguageKey } from '@cb/contracts/constants';
import { get, set } from 'idb-keyval';

/**
 * Editor drafts per match and language in IndexedDB (plan §21.4), so a reload or a crashed tab
 * never loses code. Failures (private mode, quota) are ignored: the editor still works.
 */
const key = (matchId: string, lang: LanguageKey) => `draft:${matchId}:${lang}`;

export async function loadDraft(matchId: string, lang: LanguageKey): Promise<string | undefined> {
  try {
    return await get<string>(key(matchId, lang));
  } catch {
    return undefined;
  }
}

export async function saveDraft(matchId: string, lang: LanguageKey, code: string): Promise<void> {
  try {
    await set(key(matchId, lang), code);
  } catch {
    /* best effort */
  }
}

/** The language picked last in this match (so a reload opens the same tab). */
export async function loadLanguage(matchId: string): Promise<LanguageKey | undefined> {
  try {
    return await get<LanguageKey>(`lang:${matchId}`);
  } catch {
    return undefined;
  }
}
export async function saveLanguage(matchId: string, lang: LanguageKey): Promise<void> {
  try {
    await set(`lang:${matchId}`, lang);
  } catch {
    /* best effort */
  }
}
