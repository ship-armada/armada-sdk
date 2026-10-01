// ABOUTME: Vendoring guard (SPEC §3.4) — every vendored engine file that differs from upstream (or is new)
// ABOUTME: must carry a one-line "DIVERGES FROM UPSTREAM" marker, so a re-vendor can't silently drop our changes.
//
// Usage:
//   node scripts/check-vendor-divergence.mjs
//     Shallow-clones the upstream repo at the tag recorded in NOTICE.md, checks the tag still points at the
//     recorded tag commit SHA, then compares vendor/railgun-engine/src against the clone's src/.
//   node scripts/check-vendor-divergence.mjs --upstream <dir> [--vendor <dir>]
//     Compares against an existing upstream checkout instead (offline). Both dirs are repo roots with src/.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKER = 'DIVERGES FROM UPSTREAM';
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function fail(message) {
  console.error(`check-vendor-divergence: ${message}`);
  process.exit(1);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

// Every .ts file under `dir`, as paths relative to it.
function tsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const path = join(d, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith('.ts')) out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.sort();
}

// The upstream repo, tag and commit SHA recorded in NOTICE.md's provenance table.
function noticeProvenance() {
  const notice = readFileSync(join(REPO_ROOT, 'NOTICE.md'), 'utf8');
  // A row reads `| <label> | <value> |`, the value optionally in backticks and followed by a note.
  const field = (label) => notice.match(new RegExp(`^\\| ${label} \\| \`?([^|\`\\s]+)`, 'm'))?.[1];
  const repo = field('Upstream repo');
  const tag = field('Vendored tag');
  const sha = field('Tag commit SHA');
  if (!repo || !tag || !sha) fail('could not read Upstream repo / Vendored tag / Tag commit SHA from NOTICE.md');
  return { repo, tag, sha };
}

// Clone upstream at the recorded tag and confirm the tag still points at the recorded commit.
function cloneUpstream() {
  const { repo, tag, sha } = noticeProvenance();
  const dir = mkdtempSync(join(tmpdir(), 'railgun-engine-'));
  // Quiet: cloning an annotated tag prints a detached-HEAD notice. A failed clone still throws with git's stderr.
  execFileSync('git', ['-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1', '--branch', tag, repo, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== sha) {
    rmSync(dir, { recursive: true, force: true });
    fail(`upstream tag ${tag} points at ${head}, but NOTICE.md records ${sha}`);
  }
  return dir;
}

const vendorRoot = argValue('--vendor') ?? join(REPO_ROOT, 'vendor/railgun-engine');
const localUpstream = argValue('--upstream');
const upstreamRoot = localUpstream ?? cloneUpstream();

try {
  const unmarked = [];
  let diverging = 0;
  for (const file of tsFiles(join(vendorRoot, 'src'))) {
    const ours = readFileSync(join(vendorRoot, 'src', file), 'utf8');
    const theirsPath = join(upstreamRoot, 'src', file);
    const kind = !existsSync(theirsPath) ? 'added' : readFileSync(theirsPath, 'utf8') === ours ? undefined : 'modified';
    if (kind === undefined) continue;
    diverging += 1;
    // The marker must sit on one line, so a grep for it finds every diverging file.
    if (!ours.split('\n').some((line) => line.includes(MARKER))) unmarked.push(`${kind}: ${file}`);
  }
  if (unmarked.length > 0) {
    fail(
      `${unmarked.length} vendored file(s) differ from upstream without a "${MARKER}" line (SPEC §3.4):\n` +
        unmarked.map((u) => `  ${u}`).join('\n'),
    );
  }
  console.log(`check-vendor-divergence: ${diverging} diverging file(s), all marked.`);
} finally {
  if (localUpstream === undefined) rmSync(upstreamRoot, { recursive: true, force: true });
}
