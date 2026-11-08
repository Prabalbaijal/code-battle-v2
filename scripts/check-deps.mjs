#!/usr/bin/env node
// Enforces the dependency direction between workspace kinds (plan §7.1). Run: pnpm check-deps
//   app       → domain, libs, contracts, ui, config   (never another app)
//   domain    → libs, contracts, config               (pure logic, no apps)
//   libs      → libs, contracts, config               (no cycles)
//   contracts → config
//   ui        → contracts, config
//   config    → (nothing)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ALLOWED = {
  app: ['domain', 'libs', 'contracts', 'ui', 'config'],
  domain: ['libs', 'contracts', 'config'],
  libs: ['libs', 'contracts', 'config'],
  contracts: ['config'],
  ui: ['contracts', 'config'],
  config: [],
};

function workspaceDirs() {
  const dirs = [];
  const add = (base) => {
    const abs = join(ROOT, base);
    if (!existsSync(abs)) return;
    for (const d of readdirSync(abs, { withFileTypes: true })) {
      if (d.isDirectory() && existsSync(join(abs, d.name, 'package.json'))) dirs.push(join(abs, d.name));
    }
  };
  add('apps');
  add('packages/domain');
  add('packages/libs');
  add('packages/config');
  if (existsSync(join(ROOT, 'packages/contracts/package.json'))) dirs.push(join(ROOT, 'packages/contracts'));
  if (existsSync(join(ROOT, 'packages/ui/package.json'))) dirs.push(join(ROOT, 'packages/ui'));
  return dirs;
}

const pkgs = new Map();
for (const dir of workspaceDirs()) {
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies }).filter(
    (d) => d.startsWith('@cb/'),
  );
  pkgs.set(pj.name, { kind: pj.repo?.kind, deps, dir });
}

const errors = [];
for (const [name, p] of pkgs) {
  if (!ALLOWED[p.kind]) {
    errors.push(`${name}: missing or unknown "repo.kind" (${p.kind})`);
    continue;
  }
  for (const dep of p.deps) {
    const target = pkgs.get(dep);
    if (!target) {
      errors.push(`${name} → ${dep}: not a workspace package`);
      continue;
    }
    // Test helpers may be used by any non-app package as a dev dependency.
    if (!ALLOWED[p.kind].includes(target.kind))
      errors.push(`${name} (${p.kind}) → ${dep} (${target.kind}) is not allowed`);
  }
}

// Cycle detection over the whole @cb graph.
const state = new Map();
const stack = [];
function visit(name) {
  if (state.get(name) === 'done') return;
  if (state.get(name) === 'visiting') {
    errors.push(`dependency cycle: ${[...stack.slice(stack.indexOf(name)), name].join(' → ')}`);
    return;
  }
  state.set(name, 'visiting');
  stack.push(name);
  for (const d of pkgs.get(name)?.deps ?? []) if (pkgs.has(d)) visit(d);
  stack.pop();
  state.set(name, 'done');
}
for (const name of pkgs.keys()) visit(name);

if (errors.length) {
  console.error(`check-deps: ${errors.length} problem(s)\n  ${errors.join('\n  ')}`);
  process.exit(1);
}
console.log(`check-deps: ${pkgs.size} workspaces OK`);
