import { createHash } from 'node:crypto';

/**
 * Plagiarism fingerprints, MOSS style (Schleimer, Wilkerson, Aiken 2003, "Winnowing"):
 * 1. normalise: drop comments and whitespace, replace identifiers, numbers and strings by
 *    placeholders, so renaming variables or reformatting changes nothing;
 * 2. hash every k-gram of tokens;
 * 3. keep the minimum hash of every window of w consecutive hashes (the fingerprints).
 * Any shared run of at least w + k − 1 tokens is guaranteed to share a fingerprint.
 * Similarity = Jaccard index of the two fingerprint sets.
 */

const KEYWORDS = new Set(
  `auto bool break case catch char class const continue default delete do double else enum extends
  false final finally float for function if import in include int let long namespace new null nullptr
  public private protected return short signed sizeof static std struct switch template this throw true
  try typedef typename unsigned using var vector void while def elif lambda pass yield and or not is
  None True False print range len cin cout endl scanf printf string String System out println main
  Scanner Integer Math map set list dict push_back append const let async await`.split(/\s+/),
);

/** Language-agnostic token stream (C++, Java, Python, JavaScript are all C-like enough). */
export function normalize(code: string): string[] {
  const src = code
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/\/\/[^\n]*/g, ' ') // line comments
    .replace(/(^|\s)#(?!include)[^\n]*/g, ' ') // python comments (keep #include)
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' § '); // strings
  const out: string[] = [];
  for (const m of src.matchAll(/[A-Za-z_]\w*|\d[\w.]*|==|!=|<=|>=|&&|\|\||<<|>>|\+\+|--|[^\s\w]/g)) {
    const t = m[0];
    if (t === '§') out.push('S');
    else if (/^\d/.test(t)) out.push('N');
    else if (/^[A-Za-z_]/.test(t)) out.push(KEYWORDS.has(t) ? t : 'I');
    else out.push(t);
  }
  return out;
}

const h = (s: string) => createHash('sha1').update(s).digest().readUInt32BE(0);

export function fingerprints(code: string, k = 10, w = 4): Set<number> {
  const tokens = normalize(code);
  const grams: number[] = [];
  for (let i = 0; i + k <= tokens.length; i++) grams.push(h(tokens.slice(i, i + k).join(' ')));
  const out = new Set<number>();
  if (grams.length === 0) return out;
  if (grams.length <= w) {
    out.add(Math.min(...grams));
    return out;
  }
  for (let i = 0; i + w <= grams.length; i++) out.add(Math.min(...grams.slice(i, i + w)));
  return out;
}

export function similarity(a: Set<number>, b: Set<number>): number {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const x of a) if (b.has(x)) both++;
  return both / (a.size + b.size - both);
}

/**
 * Too-short programs (e.g. "read two numbers, print the sum") are naturally identical across
 * honest players; comparing them would only produce false alarms.
 */
export const MIN_FINGERPRINTS = 20;
