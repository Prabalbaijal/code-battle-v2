'use client';

import { autocompletion, type CompletionContext } from '@codemirror/autocomplete';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import type { LanguageKey } from '@cb/contracts/constants';
import { vscodeDark } from '@uiw/codemirror-theme-vscode';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo } from 'react';

/**
 * Starter code: a full program that reads `t` and loops over the cases (packed tests, plan §14.2),
 * so players only write the per-case logic. Judge0 compiles Java as Main.java.
 */
export const TEMPLATES: Record<LanguageKey, string> = {
  cpp: `#include <bits/stdc++.h>
using namespace std;
using ll = long long;

void solve() {
    // read one test case and print its answer
}

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);
    int t;
    cin >> t;
    while (t--) solve();
    return 0;
}
`,
  java: `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader br = new BufferedReader(new InputStreamReader(System.in));
        StringTokenizer st = new StringTokenizer(br.readLine());
        int t = Integer.parseInt(st.nextToken());
        StringBuilder out = new StringBuilder();
        while (t-- > 0) {
            // read one test case and append its answer to out
        }
        System.out.print(out);
    }
}
`,
  python: `import sys
input = sys.stdin.readline


def solve():
    # read one test case and print its answer
    pass


t = int(input())
for _ in range(t):
    solve()
`,
  javascript: `const data = require('fs').readFileSync(0, 'utf8').split(/\\s+/).filter(Boolean);
let pos = 0;
const next = () => data[pos++];

const t = Number(next());
const out = [];
for (let i = 0; i < t; i++) {
  // read one test case with next() and push its answer to out
}
console.log(out.join('\\n'));
`,
};

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
    () => [LANG[language](), autocompletion({ override: [snippets(language)] })],
    [language],
  );
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={vscodeDark}
      readOnly={readOnly}
      height="100%"
      className="h-full text-base"
      basicSetup={{ foldGutter: false, highlightActiveLine: true, tabSize: 4 }}
      aria-label={`${language} code editor`}
    />
  );
}
