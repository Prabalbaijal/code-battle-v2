import { describe, expect, it } from 'vitest';
import { fingerprints, MIN_FINGERPRINTS, normalize, similarity } from './winnow.js';

const original = `
#include <bits/stdc++.h>
using namespace std;
// prefix sums over the array, then answer queries
int main() {
  int n, q; cin >> n >> q;
  vector<long long> pre(n + 1, 0);
  for (int i = 0; i < n; i++) { long long x; cin >> x; pre[i + 1] = pre[i] + x; }
  while (q--) {
    int l, r; cin >> l >> r;
    long long best = pre[r] - pre[l - 1];
    if (best < 0) best = 0;
    cout << best << "\\n";
  }
  return 0;
}`;

// the same program with renamed variables, other comments and formatting
const disguised = `
#include <bits/stdc++.h>
using namespace std;
int main(){int cnt,queries;cin>>cnt>>queries; /* my own idea */
vector<long long> acc(cnt+1,0);
for(int j=0;j<cnt;j++){long long v;cin>>v;acc[j+1]=acc[j]+v;}
while(queries--){int a,b;cin>>a>>b;long long res=acc[b]-acc[a-1];if(res<0)res=0;cout<<res<<"\\n";}
return 0;}`;

// a different, honest solution to the same task
const different = `
import sys
data = sys.stdin.read().split()
n, q = int(data[0]), int(data[1])
arr = list(map(int, data[2:2 + n]))
idx = 2 + n
segment = [0] * (4 * n)
def build(node, lo, hi):
    if lo == hi:
        segment[node] = arr[lo]
        return
    mid = (lo + hi) // 2
    build(2 * node, lo, mid)
    build(2 * node + 1, mid + 1, hi)
    segment[node] = segment[2 * node] + segment[2 * node + 1]
build(1, 0, n - 1)
`;

describe('winnowing fingerprints', () => {
  it('normalises names, numbers, strings and comments away', () => {
    expect(normalize('int total = 42; // sum')).toEqual(['int', 'I', '=', 'N', ';']);
    expect(normalize('print("hi")')).toEqual(['print', '(', 'S', ')']);
  });

  it('renamed and reformatted copies are near-identical', () => {
    const s = similarity(fingerprints(original), fingerprints(disguised));
    expect(s).toBeGreaterThan(0.85);
  });

  it('an independent solution is not', () => {
    const s = similarity(fingerprints(original), fingerprints(different));
    expect(s).toBeLessThan(0.2);
  });

  it('identical code is 1; empty code is 0', () => {
    expect(similarity(fingerprints(original), fingerprints(original))).toBe(1);
    expect(similarity(fingerprints(''), fingerprints(original))).toBe(0);
  });

  it('tiny programs fall under the minimum (they are identical for honest players too)', () => {
    expect(fingerprints('a, b = map(int, input().split())\nprint(a + b)').size).toBeLessThan(
      MIN_FINGERPRINTS,
    );
    expect(fingerprints(original).size).toBeGreaterThanOrEqual(MIN_FINGERPRINTS);
  });
});
