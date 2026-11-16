// Token Radar (radar-2): the program/v1 entry for make.fun's token-radar-01, Node 22,
// standard library only.
//
// It reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores
// every rankable pre-token protocol with the radar-2 model in lib/model.ts, writes the
// ranked board to /output/board.json and the dashboard's data to /output/data.js, copies
// this repository's dashboard/ and screenshots/ into /output, and writes /output/dossier.json
// last, with the vendored make.fun library (vendor/makefun-board.ts) — the summary the
// judge reads.
//
// The dashboard is a static page with no framework and no network: dashboard/index.html,
// dashboard/app.css and dashboard/app.js read /output/data.js, which this program writes
// from the same board, so the page and board.json always agree. The board covers the whole
// watchlist, adds the early pre-token protocols below the floor, states the model, and
// gives every protocol a six-step farm plan.
//
// Locally, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// The program is deterministic: the same snapshot always writes the same bytes, so the
// grader's two runs agree. Check a local run against the reference board hash:
//   mkdir -p /tmp/radar-rewrite-out && MAKEFUN_OUTPUT_DIR=/tmp/radar-rewrite-out node main.ts \
//     --input ../input/snapshot.json && sha256sum /tmp/radar-rewrite-out/board.json

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join as pathJoin } from 'node:path';
import { fileURLToPath as urlToPath } from 'node:url';
import {
  boardIssue,
  buildRadar,
  dataScript,
  parseSnapshot,
} from './lib/model.ts';
import { buildDossier as makeDossier } from './vendor/makefun-board.ts';

const repoRoot = urlToPath(new URL('.', import.meta.url));

// The scorer's own limits (reference/gate.json): the text cap trims the bytes, the rest refuse.
const DOSSIER_TEXT_CAP = 65_536;
const SCREENSHOT_LIMIT = { max: 4, max_bytes: 524_288 };
const DASHBOARD_LIMIT = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** A fatal problem: report it on stderr and stop with the given exit code. */
function fail(message: string, code: number): never {
  process.stderr.write('token radar: ' + message + '\n');
  process.exit(code);
}

/** The flags, read once: `--name value` or `--name=value`, else the fallback. */
function readFlags(): { input: string; output: string } {
  const flags = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
    } else if (i + 1 < argv.length) {
      flags.set(token.slice(2), argv[i + 1]!);
      i += 1;
    }
  }
  return {
    input: flags.get('input') ?? '/input',
    output: flags.get('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output',
  };
}

/** The run's three-line summary on stdout: the counts, the top of the board, the files written. */
function printSummary(
  snapshot: { protocols: unknown[]; watchlist: unknown[] },
  board: Array<{ rank: number; name: string; implied_value_usd: number }>,
  radar: { early_size: number; live_size: number },
  outDir: string,
  dashboardFiles: string[],
  shots: string[],
  dossierPath: string,
): void {
  const topThree = board
    .slice(0, 3)
    .map((r) => '#' + r.rank + ' ' + r.name + ' $' + r.implied_value_usd.toLocaleString('en-US'));
  const dossierBytes = statSync(dossierPath).size;
  const lines = [
    'token radar: ' + snapshot.protocols.length + ' protocols, ' + snapshot.watchlist.length + ' on the watchlist, ' + board.length + ' rows scored (' + radar.early_size + ' early, ' + radar.live_size + ' live set aside)',
    'token radar: top of the board: ' + topThree.join(' | '),
    'token radar: wrote ' + pathJoin(outDir, 'board.json') + ', ' + pathJoin(outDir, 'data.js') + ', ' + pathJoin(outDir, 'dashboard') + ' (' + dashboardFiles.length + ' files), ' + pathJoin(outDir, 'screenshots') + ' (' + shots.length + ' images) and ' + dossierPath + ' (' + dossierBytes + ' bytes)',
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

const { input: inputArg, output: outDir } = readFlags();
const inputFile = inputArg.endsWith('.json') ? inputArg : pathJoin(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) fail('no snapshot at ' + inputFile + ': pass --input <snapshot.json|directory> or mount the sealed /input', 2);

const snapshotText = readFileSync(inputFile, 'utf8');
const snapshot = parseSnapshot(snapshotText);
const scored = buildRadar(snapshot);
const board = scored.board;
const radar = scored.radar;
const refusal = boardIssue(board, snapshot);
if (refusal !== null) fail('the model wrote a board the gate refuses: ' + refusal, 1);

mkdirSync(outDir, { recursive: true });
writeFileSync(pathJoin(outDir, 'board.json'), JSON.stringify({ rows: board }) + '\n');
writeFileSync(pathJoin(outDir, 'data.js'), dataScript(radar));

// One directory's regular files into `to`, skipping names that start with a dot.
// Hidden files never reach /output, so the gate never sees them.
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const visible = readdirSync(from).filter((name) => !name.startsWith('.'));
  const files = visible.filter((name) => statSync(pathJoin(from, name)).isFile());
  for (const name of files) copyFileSync(pathJoin(from, name), pathJoin(to, name));
  return files;
}

const dashboardFiles = copyDirectory(pathJoin(repoRoot, 'dashboard'), pathJoin(outDir, 'dashboard'));
const hasPage = dashboardFiles.includes('index.html');
const hasStyle = dashboardFiles.some((n) => n.endsWith('.css'));
const hasScript = dashboardFiles.some((n) => n.endsWith('.js'));
if (!hasPage || !hasStyle || !hasScript) {
  fail('dashboard/ must hold index.html, a .css and a .js file; found ' + dashboardFiles.join(', '), 1);
}

const shots = copyDirectory(pathJoin(repoRoot, 'screenshots'), pathJoin(outDir, 'screenshots'));
if (shots.length < 3) fail('screenshots/ holds ' + shots.length + ' image' + (shots.length === 1 ? '' : 's') + ': hand in 3, the board, a detail view and a filtered view', 1);
shots.forEach((name) => {
  if (!SHOT_NAME.test(name)) fail('screenshots/' + name + ': a name is letters, digits and . _ -, 1 to 128 characters', 1);
});

// The dossier goes last: the scorer rebuilds it from this /output and compares bytes.
const dossierPath = pathJoin(outDir, 'dossier.json');
writeFileSync(
  dossierPath,
  makeDossier(outDir, { text_max_bytes: DOSSIER_TEXT_CAP, screenshots: SCREENSHOT_LIMIT, dashboard: DASHBOARD_LIMIT }),
);

printSummary(snapshot, board, radar, outDir, dashboardFiles, shots, dossierPath);
