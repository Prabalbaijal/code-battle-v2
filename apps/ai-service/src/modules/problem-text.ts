import type { PublicProblem } from '@cb/contracts';

/** The statement as plain text for prompts and the tutor's corpus. Public parts only, never tests. */
export function problemText(p: PublicProblem): string {
  const examples = p.examples
    .map(
      (e, i) =>
        `Example ${i + 1}\nInput:\n${e.input}\nOutput:\n${e.output}${e.explanation ? `\nExplanation: ${e.explanation}` : ''}`,
    )
    .join('\n\n');
  return [
    `# ${p.title} (${p.difficulty})`,
    p.statementMd,
    `## Input\n${p.inputFormatMd}`,
    `## Output\n${p.outputFormatMd}`,
    p.constraints.length ? `## Constraints\n${p.constraints.map((c) => `- ${c}`).join('\n')}` : '',
    examples ? `## Examples\n${examples}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Long code is cut in the middle: the start (reading input) and the end (output) matter most. */
export function clip(code: string, max = 6000): string {
  if (code.length <= max) return code;
  const half = Math.floor(max / 2);
  return `${code.slice(0, half)}\n/* … ${code.length - max} characters omitted … */\n${code.slice(-half)}`;
}
