import type { LanguageKey } from '@cb/contracts/constants';

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
