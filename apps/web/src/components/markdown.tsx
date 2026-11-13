'use client';

import { cn } from '@cb/ui';
import 'katex/dist/katex.min.css';
import { Children, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/** Same rule as ai-service's chunk anchors, so tutor citations land on the right section. */
const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const textOf = (node: ReactNode): string =>
  Children.toArray(node)
    .map((c) =>
      typeof c === 'string' || typeof c === 'number'
        ? String(c)
        : isValidElement<{ children?: ReactNode }>(c)
          ? textOf(c.props.children)
          : '',
    )
    .join('');

/**
 * Problem statements and notes: GitHub-flavoured markdown plus `$…$` / `$$…$$` math (KaTeX).
 * Raw HTML is never rendered (react-markdown escapes it and drops `javascript:` links), and KaTeX
 * runs with `trust: false`, so a statement can't inject markup or scripts. Model-written text (hints,
 * tutor answers) goes through the same component. `anchors` gives headings ids (for /learn links).
 */
export function Markdown({
  children,
  className,
  anchors = false,
}: {
  children: string;
  className?: string;
  anchors?: boolean;
}) {
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, trust: false, strict: 'ignore' }]]}
        components={{
          a: ({ node: _node, href, ...props }) =>
            href?.startsWith('/') || href?.startsWith('#') ? (
              <a href={href} {...props} />
            ) : (
              <a href={href} {...props} target="_blank" rel="noopener noreferrer" />
            ),
          ...(anchors
            ? {
                h2: ({ node: _node, children: c, ...props }) => (
                  <h2 id={slugify(textOf(c))} className="scroll-mt-20" {...props}>
                    {c}
                  </h2>
                ),
                h3: ({ node: _node, children: c, ...props }) => (
                  <h3 id={slugify(textOf(c))} className="scroll-mt-20" {...props}>
                    {c}
                  </h3>
                ),
              }
            : {}),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
