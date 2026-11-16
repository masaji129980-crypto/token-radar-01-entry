// radar-2, written out again from the behaviour: a sealed snapshot in, a ranked board out.
//
// A protocol's launch is the token it might one day issue. This file does the entry's
// arithmetic: it scores every protocol that records no token, ranks the board by the score,
// and writes a six-step farm plan for each row. Protocols whose token already trades are
// never ranked; they are set aside with the market's own figures, which no model invents.
//
// One closed form scores every row, from the snapshot's figures alone:
//
//   base     = tvl_usd * 0.30
//   growth   = 1 + 0.55 * clamp(change_7d, -50, 100) / 100
//   maturity = 0.70 + 0.30 * ln(1 + age) / ln(1 + 1460)
//   reach    = 1 + 0.025 * min(chains - 1, 4)
//   implied  = max(1, round(base * growth * maturity * reach))
//
// Age is the days since the protocol was first listed, the record of how long it has run
// with no token; a protocol with no listing date counts as 365 days old. Growth is capped
// so one hot week cannot carry a protocol, and a bad week cannot erase it. Maturity is a
// log curve: most of the staying credit arrives in the first year, then it saturates.
// No name is ever special-cased. The dashboard states the same formula and recomputes
// any row from the same figures, so the page and board.json agree.

/** The tuning the dashboard states and the sandbox lets a reader move. */
export type ModelConstants = {
  base_multiple: number; growth_weight: number; growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number; unknown_age_days: number;
  chain_bonus: number; chain_cap: number;
};

export const TUNING: ModelConstants =
  { base_multiple: 0.3, growth_weight: 0.55, growth_floor: -50, growth_cap: 100,
    maturity_floor: 0.7, maturity_range: 0.3, maturity_days: 1460, unknown_age_days: 365,
    chain_bonus: 0.025, chain_cap: 4 };

/** The model's version label, as the dashboard names it. */
export const MODEL_LABEL = 'radar-2';

/** How many rankable pre-token protocols below the watchlist floor the early radar carries. */
export const EARLY_CAP = 200;

/** How many live-token protocols the dashboard's live view carries. */
export const LIVE_CAP = 24;

/** One protocol exactly as the sealed snapshot lists it: ten fields, no more. */
export type SnapshotProtocol = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
};

/** The snapshot document as a whole. */
export type Snapshot = {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
};

/** One farm step before it is flattened into its single board.json string. */
export type FarmStep = {
  text: string; cost: string; time: string;
};

/** One row of board.json. Field order is the file's order: keep it. */
export type BoardRow = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number; reach_multiplier: number; age_days: number | null }; farm_steps: string[];
};

/** A board row slimmed for data.js; it still carries the full farm plan. */
export type RadarRow = {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; age_days: number | null; implied_value_usd: number;
  growth_multiplier: number; maturity_multiplier: number; reach_multiplier: number; farm_steps: string[];
};

/** A protocol whose token already trades: the market's value, never a model's. */
export type LiveRow = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
};

/** Everything the dashboard needs to render: the board, the live set, and the tuning. */
export type RadarData = {
  as_of: string; source: string; floor_usd: number; model: ModelConstants;
  model_version: string; watchlist_size: number; board_size: number;
  early_size: number; live_size: number; rows: RadarRow[]; live: LiveRow[];
};

/** Why a snapshot file is not one this model can score. */
export class SnapshotProblem extends Error {
  constructor(reason: string) {
    super(reason);
    Object.defineProperty(this, 'name', { value: 'SnapshotProblem' });
  }
}

const MS_PER_DAY = 86_400_000;

/** The number when it is a finite number, else the fallback. */
function finiteOr(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value;
}

/** Whole days from `listed` to `asOf`, never below zero; null when a date is missing or bad. */
export function ageDays(
  asOf: string,
  listed: string | null,
): number | null {
  if (listed === null) return null;
  const end = Date.parse(asOf + 'T00:00:00Z');
  const start = Date.parse(listed + 'T00:00:00Z');
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / MS_PER_DAY));
}

/** Four decimals, for the multipliers the board and the page both show. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Slug order for ties: the earlier slug first, so a tie always breaks the same way. */
function slugOrder(a: { slug: string }, b: { slug: string }): number {
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
}

/** What one protocol scores: the implied value and the four factors behind it. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; reachMult: number; age: number | null } {
  const listedAge = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finiteOr(protocol.change_7d, 0)));
  const growthStep = (growthPct / 100) * model.growth_weight;
  const growthMult = 1 + growthStep;
  const scoredAge = listedAge ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (Math.log(1 + Math.max(scoredAge, 0)) / Math.log(1 + model.maturity_days)) * model.maturity_range;
  const reachMult = 1 + model.chain_bonus * Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_cap);
  const base = model.base_multiple * protocol.tvl_usd;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * reachMult));
  return { implied, growthPct, growthMult, maturityMult, reachMult, age: listedAge };
}

// The watchlist rule's name tests, as the snapshot's own description states them: a name
// ending in a version marker is a pool of another protocol, a name carrying a whole word
// wrapped, staked or staking is a wrapped product, and a name opening with an exchange's
// name is the exchange's own product.
const VERSION_TAIL = new RegExp(String.raw`\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$`);
const WRAPPED_WORD = new RegExp(String.raw`\b(wrapped|staked|staking)\b`, 'i');
const EXCHANGE_LEAD = new RegExp(String.raw`^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b`);

/** Categories the watchlist rule leaves out: bridged, staked and exchange products. */
const BARRED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** Whether the record carries no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(
  p: SnapshotProtocol,
): boolean {
  const tokenFields = [p.mcap_usd, p.gecko_id, p.symbol];
  return tokenFields.every((field) => field === null);
}

// Whether the board may rank a protocol: it records no token, and it is not an exchange,
// bridge or staked product, nor a versioned pool of another protocol.
export function isRankable(
  p: SnapshotProtocol,
): boolean {
  if (!isPreToken(p)) return false;
  if (BARRED_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSION_TAIL.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_LEAD.test(p.name)) return false;
  return true;
}

/** The protocols the board ranks: the whole watchlist, then the early radar below the floor. */
export function buildBoard(
  snapshot: Snapshot,
  model: ModelConstants = TUNING,
): BoardRow[] {
  const bySlug = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) bySlug.set(p.slug, p);

  const picked = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer
  // carries. Coverage is the gate's row and is never gambled on a missing record.
  snapshot.watchlist.forEach((slug) => {
    const found = bySlug.get(slug);
    if (found !== undefined) picked.set(slug, found);
  });
  // The early radar: rankable pre-token protocols below the floor, strongest TVL first.
  // A picked protocol stays picked; the early rows only ever add to the board.
  const earlyPicks = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || slugOrder(a, b))
    .slice(0, EARLY_CAP);
  for (const p of earlyPicks) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => {
    const s = impliedValue(p, snapshot.as_of, model);
    return { protocol: p, score: s };
  });
  scored.sort((a, b) => b.score.implied - a.score.implied || slugOrder(a.protocol, b.protocol));
  return scored.map(({ protocol: p, score: s }, position) => {
    const steps = farmSteps(p, s.age).map(stepText);
    const row: BoardRow = {
      rank: position + 1, slug: p.slug, name: p.name, category: p.category,
      chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d, mcap_usd: p.mcap_usd,
      listed_at: p.listed_at, gecko_id: p.gecko_id, symbol: p.symbol, token_status: 'pre-token',
      age_days: s.age, implied_value_usd: s.implied,
      model: {
        base_multiple: model.base_multiple, growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult), maturity_multiplier: round4(s.maturityMult),
        reach_multiplier: round4(s.reachMult), age_days: s.age,
      },
      farm_steps: steps,
    };
    return row;
  });
}

/** One step flattened into its board string: action, cost and time, inside 20..600 characters. */
export function stepText(
  step: FarmStep,
): string {
  const joined = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (joined.length > 600) return joined.slice(0, 596) + '...';
  if (joined.length < 20) return joined + " Hold the position and check the protocol's own page.";
  return joined;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function firstChain(p: SnapshotProtocol): string {
  const head = p.chains[0];
  return head === undefined ? 'its main chain' : head;
}

/** Capital tiers, richest first: the bigger the protocol, the bigger the farm position. */
const CAPITAL_TIERS: Array<[number, number]> = [
  [5_000_000_000, 250],
  [1_000_000_000, 150],
  [100_000_000, 100],
];

/** What one farm position costs: bigger protocols get a bigger position. */
function capitalFor(
  p: SnapshotProtocol,
): number {
  const tier = CAPITAL_TIERS.find(([floor]) => p.tvl_usd >= floor);
  return tier === undefined ? 50 : tier[1];
}

/** Hold tiers, youngest first: younger protocols get a longer qualifying window. */
const HOLD_TIERS: Array<[number, number]> = [
  [180, 60],
  [365, 45],
];

/** How long to hold, from the protocol's age; an unlisted age holds 30 days. */
function holdDaysFor(
  age: number | null,
): number {
  const fallbackHold = 30;
  if (age === null) return fallbackHold;
  const tier = HOLD_TIERS.find(([limit]) => age < limit);
  return tier === undefined ? fallbackHold : tier[1];
}

/** One category rule: how to tell it apart, and what its main action says. */
interface CategoryRule {
  test: (category: string) => boolean;
  write: (name: string, funds: number, chain: string) => string;
}

/** A rule that fires when the category carries any of the words. */
function containing(...words: string[]): (category: string) => boolean {
  return (category: string) => words.some((w) => category.includes(w));
}

/** The first rule whose test fires wins; the order below is the order that decides. */
function pickRule(rules: CategoryRule[], category: string): CategoryRule | undefined {
  for (const rule of rules) {
    if (rule.test(category)) return rule;
  }
  return undefined;
}

// The main action per category, in the words a farmer can follow. The fallback at the
// end covers every category no rule names.
const MAIN_ACTIONS: CategoryRule[] = [
  {
    test: containing('lend', 'cdp', 'collateral'),
    write: (name, funds, chain) => `Supply $${funds} of USDC to ${name} on ${chain} and keep the position open.`,
  },
  {
    test: containing('dex', 'yield', 'leveraged farm'),
    write: (name, funds, chain) => `Provide $${funds} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
  },
  {
    test: containing('bridge'),
    write: (name, funds, chain) => `Bridge $${funds} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    test: containing('staking', 'restak'),
    write: (name, funds, chain) => `Stake $${funds} of the chain's staking asset through ${name} and keep the receipt token.`,
  },
  {
    test: containing('perpetual', 'derivative'),
    write: (name, funds, chain) => `Deposit $${funds} of USDC as margin on ${name} and open one small hedged trade.`,
  },
  {
    test: containing('prediction'),
    write: (name, funds) => `Fund $${funds} and place one market position on ${name}.`,
  },
  {
    test: containing('curator', 'allocator', 'risk'),
    write: (name, funds, chain) => `Deposit $${funds} into a ${name} vault on ${chain} and keep the vault shares.`,
  },
  {
    test: containing('stable'),
    write: (name, funds, chain) => `Mint or deposit $${funds} of the stable asset through ${name} on ${chain}.`,
  },
  {
    test: containing('rwa'),
    write: (name, funds, chain) => `Mint $${funds} of the protocol's yield-bearing asset on ${chain} and hold it.`,
  },
  {
    test: containing('insurance'),
    write: (name, funds, chain) => `Buy $${funds} of cover from ${name} on ${chain} and keep the policy active.`,
  },
  {
    test: containing('basis'),
    write: (name, funds, chain) => `Deposit $${funds} of USDC into ${name}'s basis vault on ${chain} and keep the position open.`,
  },
];

/** The fallback main action, for a category no rule names. */
function defaultAction(name: string, funds: number, chain: string): string {
  return `Deposit $${funds} of USDC into ${name} on ${chain} and keep the position open.`;
}

// The weekly qualifying action per category, so the plan is not one deposit and silence.
// Note the order differs from the main actions: a bridge is a weekly habit only after
// the longer-lived positions, and a bare chain gets its own rule.
const WEEKLY_ACTIONS: CategoryRule[] = [
  {
    test: containing('lend', 'cdp', 'collateral'),
    write: (name) => `Each week, borrow a small amount against the deposit and repay it, so the position shows both sides of ${name}.`,
  },
  {
    test: containing('dex', 'yield', 'leveraged farm'),
    write: (name, _funds, chain) => `Each week, swap a small amount through ${name} on ${chain} and, when the pool pays rewards, claim or compound them.`,
  },
  {
    test: containing('staking', 'restak'),
    write: (name) => `Each week, check the staking rewards ${name} accrues and restake them instead of letting them sit idle.`,
  },
  {
    test: containing('perpetual', 'derivative'),
    write: (name) => `Each week, place one small trade on ${name} and close it the same day, keeping the margin position untouched.`,
  },
  {
    test: containing('prediction'),
    write: (name) => `Each week, settle one market on ${name} and place one new position, so the account stays active.`,
  },
  {
    test: containing('curator', 'allocator', 'risk'),
    write: (name) => `Each week, check the vault's allocation report ${name} publishes and top the position up by a few dollars.`,
  },
  {
    test: containing('rwa'),
    write: (name) => `Each week, check the yield the asset accrued and keep the holding in the same wallet ${name} recorded.`,
  },
  {
    test: containing('bridge'),
    write: (name, _funds, chain) => `Each week, bridge a small amount through ${name} and use it on ${chain}, so the bridge sees repeat use.`,
  },
  {
    test: (category) => category === 'chain',
    write: (name) => `Each week, use one app built on ${name} itself, so the activity is tied to the chain ${name} runs.`,
  },
];

/** The fallback weekly action, for a category no rule names. */
function defaultWeekly(name: string): string {
  return `Each week, make one small qualifying action on ${name}, such as a deposit, a swap or a vote.`;
}

// A protocol's farm plan: six steps, each an action with a cost and a time. The plan is
// derived from the protocol's own record (category, chains, TVL, age), never from a
// hand-written list of names.
export function farmSteps(
  p: SnapshotProtocol,
  age: number | null,
): FarmStep[] {
  const chain = firstChain(p);
  const funds = capitalFor(p);
  const holdDays = holdDaysFor(age);
  const category = (p.category ?? '').toLowerCase();
  const main = pickRule(MAIN_ACTIONS, category);
  const weekly = pickRule(WEEKLY_ACTIONS, category);
  const step = (text: string, cost: string, time: string): FarmStep => ({ text, cost, time });
  const steps: FarmStep[] = [
    step(
      'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    step(
      main === undefined ? defaultAction(p.name, funds, chain) : main.write(p.name, funds, chain),
      '$' + funds + ' of capital and about $' + (funds >= 150 ? 8 : 4) + ' of gas',
      '15 minutes to set up',
    ),
    step(
      weekly === undefined ? defaultWeekly(p.name) : weekly.write(p.name, funds, chain),
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    step(
      "Before adding more, check the protocol's own site for an audit note and confirm the contract address matches the one its docs publish.",
      'no fee to check',
      '10 minutes',
    ),
    step(
      'Hold the position for at least ' + holdDays + ' days so the activity is counted in more than one snapshot.',
      'the $' + funds + ' stays in the position',
      holdDays + ' days',
    ),
    step(
      "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes, then write the wallet, the dates and every transaction in a farm log.",
      'no fee to check, and never pay to claim',
      '15 minutes',
    ),
  ];
  return steps;
}

/** The live-token protocols, by market cap, for the dashboard's live view. */
export function liveRows(
  snapshot: Snapshot,
): LiveRow[] {
  const trading = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  trading.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return trading.slice(0, LIVE_CAP).map((p) => ({
    slug: p.slug, name: p.name, category: p.category, chains: p.chains,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, carrying the farm plan board.json carries. */
export function radarRow(
  row: BoardRow,
): RadarRow {
  const slim: RadarRow = {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category,
    chains: row.chains, tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd,
    listed_at: row.listed_at, age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    reach_multiplier: row.model.reach_multiplier, farm_steps: row.farm_steps,
  };
  return slim;
}

// Everything the dashboard renders, built from the snapshot.
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = TUNING,
): { board: BoardRow[]; radar: RadarData } {
  const ranked = buildBoard(snapshot, model);
  const trading = liveRows(snapshot);
  let earlyCount = 0;
  for (const row of ranked) {
    if (!snapshot.watchlist.includes(row.slug)) earlyCount += 1;
  }
  const radar: RadarData =
    {
      as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, model,
      model_version: MODEL_LABEL, watchlist_size: snapshot.watchlist.length, board_size: ranked.length,
      early_size: earlyCount, live_size: trading.length, rows: ranked.map(radarRow), live: trading,
    };
  return { board: ranked, radar };
}

/** Parse JSON, or refuse the file with the snapshot's own error. */
function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { failSnapshot('snapshot.json is not JSON'); }
}

/** Refuse a snapshot, never returning. */
function failSnapshot(message: string): never {
  throw new SnapshotProblem(message);
}

/** A string field, or null when the value is anything else. */
function textField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** A finite number field, or null when the value is anything else. */
function numberField(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Refuse a snapshot file that is not the shape this model scores.
export function parseSnapshot(
  text: string,
): Snapshot {
  const raw = safeJson(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failSnapshot('snapshot.json is not a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  if (typeof doc.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(doc.as_of)) {
    failSnapshot('snapshot.json has no as_of date');
  }
  if (typeof doc.source !== 'string') failSnapshot('snapshot.json has no source');
  if (typeof doc.floor_usd !== 'number' || !Number.isSafeInteger(doc.floor_usd) || doc.floor_usd <= 0) {
    failSnapshot('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(doc.protocols)) failSnapshot('snapshot.json has no protocols array');
  if (!Array.isArray(doc.watchlist) || doc.watchlist.some((s) => typeof s !== 'string')) {
    failSnapshot('snapshot.json has no watchlist of slugs');
  }
  const protocols: SnapshotProtocol[] = [];
  for (let i = 0; i < doc.protocols.length; i++) {
    const entry = doc.protocols[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      failSnapshot("snapshot.json's protocol " + i + ' is not an object');
    }
    const fields = entry as Record<string, unknown>;
    if (typeof fields.slug !== 'string' || typeof fields.name !== 'string' || !numberField(fields.tvl_usd)) {
      failSnapshot("snapshot.json's protocol " + i + ' lacks a slug, a name or a TVL');
    }
    const chains: string[] = [];
    if (Array.isArray(fields.chains)) {
      for (const c of fields.chains) if (typeof c === 'string') chains.push(c);
    }
    protocols.push({
      slug: fields.slug,
      name: fields.name,
      category: textField(fields.category),
      chains,
      tvl_usd: fields.tvl_usd as number,
      change_7d: numberField(fields.change_7d),
      mcap_usd: numberField(fields.mcap_usd),
      listed_at: textField(fields.listed_at),
      gecko_id: textField(fields.gecko_id),
      symbol: textField(fields.symbol),
    });
  }
  return { as_of: doc.as_of, source: doc.source, floor_usd: doc.floor_usd, protocols, watchlist: doc.watchlist as string[] };
}

// Why a board is not one the gate will take, or null when it passes: coverage, ranks,
// order, one shared implied value, and farm steps.
export function boardIssue(
  board: BoardRow[],
  snapshot: Snapshot,
): string | null {
  const onBoard = new Set<string>();
  for (const row of board) onBoard.add(row.slug);
  const missing: string[] = [];
  snapshot.watchlist.forEach((slug) => {
    if (!onBoard.has(slug)) missing.push(slug);
  });
  if (missing.length > 0) {
    return 'the board misses ' + missing.length + ' watchlist slug' + (missing.length === 1 ? '' : 's') + ': ' + missing.slice(0, 5).join(', ');
  }
  const ranks = board.map((row) => row.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return 'rank ' + (i + 1) + ' is ' + ranks[i];
  }
  for (let i = 1; i < board.length; i++) {
    const prev = board[i - 1];
    const cur = board[i];
    if (prev !== undefined && cur !== undefined && cur.implied_value_usd > prev.implied_value_usd) {
      return 'row ' + (i + 1) + ' outranks row ' + i + ' on implied value';
    }
  }
  const first = board[0];
  const last = board[board.length - 1];
  if (board.length >= 2 && first !== undefined && last !== undefined && first.implied_value_usd === last.implied_value_usd) {
    return (
      'all ' + board.length + ' rows share the same implied value $' + first.implied_value_usd + ': a board that ranks nothing by value is not a ranking'
    );
  }
  for (const row of board) {
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return row.slug + ' has ' + row.farm_steps.length + ' farm steps';
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) return row.slug + ' has a farm step of ' + step.length + ' characters';
    }
    if (!Number.isSafeInteger(row.implied_value_usd) || row.implied_value_usd <= 0) {
      return row.slug + ' has implied value ' + row.implied_value_usd;
    }
  }
  return null; // no problem found: the gate takes this board
}

// A compact data.js: the dashboard's whole dataset as one script, no fetch, no network.
export function dataScript(
  radar: RadarData,
): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
