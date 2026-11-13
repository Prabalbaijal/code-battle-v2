import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** prompts/ sits two levels above both src/llm and dist/llm. */
export const PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));

export interface Prompt {
  name: string;
  /** Stored with every response (plan §22.3: prompts are versioned in the repo). */
  version: string;
  system: string;
  user: string;
}

/**
 * A prompt file is front matter (`version:`) and two sections, `## system` and `## user`, with
 * `{{name}}` placeholders. Untrusted text (code, questions) is only ever substituted into the user
 * section, inside delimited blocks the system section tells the model to treat as data.
 */
export function parsePrompt(name: string, source: string): Prompt {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(source.replace(/\r\n/g, '\n'));
  if (!m) throw new Error(`prompt ${name}: missing front matter`);
  const version = /^version:\s*(\S+)/m.exec(m[1]!)?.[1];
  if (!version) throw new Error(`prompt ${name}: missing version`);
  const sections = m[2]!.split(/^## (system|user)\s*$/m);
  const get = (k: string) => {
    const i = sections.indexOf(k);
    if (i < 0) throw new Error(`prompt ${name}: missing ## ${k}`);
    return sections[i + 1]!.trim();
  };
  return { name, version, system: get('system'), user: get('user') };
}

export function loadPrompts(dir = PROMPTS_DIR): Map<string, Prompt> {
  const out = new Map<string, Prompt>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const name = f.slice(0, -3);
    out.set(name, parsePrompt(name, readFileSync(join(dir, f), 'utf8')));
  }
  return out;
}

/** Fill `{{key}}` placeholders; a missing value is a bug, not an empty string. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) throw new Error(`prompt variable {{${k}}} has no value`);
    return v;
  });
}

/** Keep untrusted text from closing its own delimiter block. */
export const fence = (text: string) => text.replace(/<\/?(user_code|question|opponent_code|context)>/gi, '');
