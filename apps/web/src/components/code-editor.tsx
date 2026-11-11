'use client';

import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import type { LanguageKey } from '@cb/contracts/constants';
import { EditorView } from '@codemirror/view';
import { vscodeDarkInit } from '@uiw/codemirror-theme-vscode';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

// v1's snippet completions, kept (and extended to JavaScript)
type Snippet = { label: string; type: string; apply?: string };
const SNIPPETS: Record<LanguageKey, Snippet[]> = {
  cpp: [
    {
      label: '#include<bits/stdc++.h>',
      type: 'keyword',
      apply: '#include <bits/stdc++.h>\nusing namespace std;\n',
    },
    { label: 'for', type: 'keyword', apply: 'for (int i = 0; i < n; i++) {\n    \n}' },
    { label: 'while', type: 'keyword', apply: 'while () {\n    \n}' },
    { label: 'vector<int>', type: 'type', apply: 'vector<int> a(n);' },
    { label: 'cout', type: 'function', apply: "cout << x << '\\n';" },
    { label: 'cin', type: 'function', apply: 'cin >> x;' },
    { label: 'sort', type: 'function', apply: 'sort(a.begin(), a.end());' },
  ],
  java: [
    { label: 'for', type: 'keyword', apply: 'for (int i = 0; i < n; i++) {\n    \n}' },
    { label: 'System.out.println', type: 'function', apply: 'System.out.println();' },
    { label: 'Integer.parseInt', type: 'function', apply: 'Integer.parseInt(st.nextToken())' },
    { label: 'new StringTokenizer', type: 'function', apply: 'st = new StringTokenizer(br.readLine());' },
  ],
  python: [
    { label: 'for', type: 'keyword', apply: 'for i in range(n):\n    ' },
    { label: 'def', type: 'keyword', apply: 'def name():\n    pass' },
    { label: 'map(int, input().split())', type: 'function', apply: 'map(int, input().split())' },
    { label: 'print', type: 'function', apply: 'print()' },
  ],
  javascript: [
    { label: 'for', type: 'keyword', apply: 'for (let i = 0; i < n; i++) {\n  \n}' },
    { label: 'Number(next())', type: 'function', apply: 'Number(next())' },
    { label: 'console.log', type: 'function', apply: 'console.log();' },
  ],
};

function snippets(lang: LanguageKey) {
  return (context: CompletionContext) => {
    const word = context.matchBefore(/[\w#.<]*/);
    if (!word || (word.from === word.to && !context.explicit)) return null;
    return { from: word.from, options: SNIPPETS[lang].map((s) => ({ ...s, apply: s.apply ?? s.label })) };
  };
}

/** VS Code dark, with line numbers lifted to AA contrast (#838383 was 4.4:1 on #1e1e1e; axe). */
const theme = vscodeDarkInit({ settings: { gutterForeground: '#9d9d9d' } });

const LANG = { cpp, java, python, javascript: () => javascript() } as const;

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
}: {
  value: string;
  onChange: (code: string) => void;
  language: LanguageKey;
  readOnly?: boolean;
}) {
  const extensions = useMemo(
    () => [
      LANG[language](),
      autocompletion({ override: [snippets(language)] }),
      // the editable area is what screen readers and the keyboard land on: name it, and make it an
      // explicit tab stop (contenteditable alone doesn't count as focusable for every checker)
      EditorView.contentAttributes.of({ 'aria-label': `Code editor (${language})`, tabindex: '0' }),
    ],
    [language],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      readOnly={readOnly}
      height="100%"
      className="h-full text-base"
      basicSetup={{ foldGutter: false, highlightActiveLine: true, tabSize: 4 }}
      aria-label={`${language} code editor`}
    />
  );
}
