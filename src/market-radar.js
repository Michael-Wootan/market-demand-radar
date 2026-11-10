#!/usr/bin/env node
/**
 * market-radar.js: demand-first market opportunity scanner
 *
 * Product planning is usually supply-driven (what competitors sell that we
 * don't). This adds the demand side: what people are actually SEARCHING for,
 * in which country, with what volume, difficulty and growth, so rising trends
 * surface with real numbers.
 *
 * Writes data/market-radar.json. A downstream report (for example a weekly
 * product-gap email) can read it and match trending keywords to products.
 *
 * How it works:
 *   1. Pre-flight: check the Ahrefs workspace quota (free call). If remaining
 *      units < MIN_REMAINING_UNITS, skip entirely. Other workflows eat first.
 *   2. Per country in config/markets.json: keywords-explorer matching-terms
 *      for each seed token. matching-terms returns every phrase CONTAINING the
 *      token, so local-language phrases come back automatically.
 *   3. Filter to product-intent keywords, score = volume / (1 + KD).
 *   4. For the top ~8 per country: volume-history -> YoY growth + momentum.
 *   5. Write data/market-radar.json.
 *
 * Unit safety:
 *   - Hard budget per run (RADAR_UNIT_BUDGET, default 12000). Spend is read
 *     from Ahrefs x-api-units-cost headers after every call; once the budget
 *     is hit, no further calls are made and we report what we have.
 *   - Any fatal problem exits 0 with a "skipped" JSON, so it never breaks a
 *     report that runs after it in the same workflow.
 *
 * Env: AHREFS_API_TOKEN (required), RADAR_UNIT_BUDGET, RADAR_MIN_REMAINING
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env'), override: true, quiet: true });

const AHREFS_TOKEN = process.env.AHREFS_API_TOKEN || '';
const AHREFS_BASE = 'https://api.ahrefs.com/v3';
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(ROOT, 'config');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const OUT_FILE = path.join(DATA_DIR, 'market-radar.json');

const UNIT_BUDGET = parseInt(process.env.RADAR_UNIT_BUDGET || '12000', 10);
const MIN_REMAINING_UNITS = parseInt(process.env.RADAR_MIN_REMAINING || '60000', 10);
const TREND_KEYWORDS_PER_COUNTRY = 8;

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// config/markets.json wins; the committed markets.example.json is the fallback
function loadMarkets() {
  for (const file of ['markets.json', 'markets.example.json']) {
    const p = path.join(CONFIG_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('Missing config/markets.json');
}
const markets = loadMarkets();
const toRegex = list => new RegExp(list.join('|'), 'i');

// ── Markets ─────────────────────────────────────────────────────────────
// Seed tokens per country. Local extras catch words that don't contain the
// main seed (for example the local-language word for the product).
const COUNTRIES = markets.countries;

// ── Unit accounting ────────────────────────────────────────────────────────
let unitsSpent = 0;

function recordCost(res, rowsReturned) {
  const headerNames = ['x-api-units-cost-total-actual', 'x-api-units-cost-total', 'x-api-units-cost-row'];
  for (const h of headerNames) {
    const v = res.headers.get(h);
    if (v != null && !Number.isNaN(parseInt(v, 10))) {
      unitsSpent += parseInt(v, 10);
      return;
    }
  }
  // Header missing: conservative estimate: 1 unit per row, min 1
  unitsSpent += Math.max(1, rowsReturned || 0);
}

function budgetLeft() { return unitsSpent < UNIT_BUDGET; }

// ── Ahrefs client ──────────────────────────────────────────────────────────
async function ahrefsCall(endpoint, params) {
  const url = new URL(`${AHREFS_BASE}/${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}`, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ahrefs ${endpoint} HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  recordCost(res, (data.keywords || data.metrics || []).length);
  return data;
}

async function getRemainingUnits() {
  // Free endpoint: does not consume units
  try {
    const res = await fetch(`${AHREFS_BASE}/subscription-info/limits-and-usage`, {
      headers: { 'Authorization': `Bearer ${AHREFS_TOKEN}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.limits_and_usage || data;
    if (info.units_limit_workspace != null && info.units_usage_workspace != null) {
      return info.units_limit_workspace - info.units_usage_workspace;
    }
  } catch {}
  return null;
}

// ── Keyword filtering ───────────────────────────────────────────────────────
// Product-intent only. dropPatterns removes informational, legal, review and
// retailer-brand queries; productSignals keeps only keywords that name a
// product form or a buying context. Both lists are multilingual and live in
// config/markets.json.
const DROP_PATTERNS = toRegex(markets.dropPatterns);
const PRODUCT_SIGNALS = toRegex(markets.productSignals);

function keepKeyword(kw) {
  const k = (kw.keyword || '').toLowerCase();
  if (k.length < 4 || k.length > 60) return false;
  if (DROP_PATTERNS.test(k)) return false;
  if (!PRODUCT_SIGNALS.test(k)) return false;
  return true;
}

function baseScore(kw) {
  return (kw.volume || 0) / (1 + (kw.difficulty || 0));
}

// Avoid picking 8 near-identical keywords for trend calls
function tokenSet(k) {
  return new Set(k.toLowerCase().split(/\s+/).filter(w => w.length > 1));
}
function tooSimilar(a, b) {
  const ta = tokenSet(a), tb = tokenSet(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.min(ta.size, tb.size) >= 0.8;
}

// ── Volume history → growth ────────────────────────────────────────────────
function monthsAgoISO(n) {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

async function fetchGrowth(country, keyword) {
  try {
    const data = await ahrefsCall('keywords-explorer/volume-history', {
      country,
      keyword,
      date_from: monthsAgoISO(16),
    });
    const rows = (data.metrics || data.volume_history || data.history || [])
      .map(r => ({ date: r.date || r.month, volume: r.volume ?? r.value ?? 0 }))
      .filter(r => r.date)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
    if (rows.length < 6) return { growthYoY: null, momentum: null, spark: rows };

    // Drop current (partial) month if present
    const nowMonth = new Date().toISOString().slice(0, 7);
    const hist = rows.filter(r => !String(r.date).startsWith(nowMonth));
    const avg = arr => arr.reduce((s, r) => s + (r.volume || 0), 0) / Math.max(arr.length, 1);

    const recent3 = avg(hist.slice(-3));
    const prior3 = avg(hist.slice(-6, -3));
    const yoy3 = hist.length >= 15 ? avg(hist.slice(-15, -12)) : null;

    const momentum = prior3 > 0 ? Math.round(((recent3 - prior3) / prior3) * 100) : null;
    const growthYoY = yoy3 && yoy3 > 0 ? Math.round(((recent3 - yoy3) / yoy3) * 100) : null;
    return { growthYoY, momentum, spark: hist.slice(-12) };
  } catch (e) {
    return { growthYoY: null, momentum: null, spark: [], note: e.message.slice(0, 80) };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
function writeSkipped(reason) {
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    skipped: true,
    reason,
    unitsSpent,
    countries: [],
  }, null, 2));
  console.log(`  ⏭️  Market radar skipped: ${reason}`);
}

async function main() {
  console.log(`\n📈 Market Radar: demand scan across ${COUNTRIES.length} markets`);
  console.log(`   Unit budget: ${UNIT_BUDGET.toLocaleString()} | Safety floor: ${MIN_REMAINING_UNITS.toLocaleString()} workspace units\n`);

  if (!AHREFS_TOKEN) return writeSkipped('AHREFS_API_TOKEN not set');

  const remaining = await getRemainingUnits();
  if (remaining != null) {
    console.log(`   Ahrefs workspace units remaining: ${remaining.toLocaleString()}`);
    if (remaining < MIN_REMAINING_UNITS) {
      return writeSkipped(`workspace quota low (${remaining.toLocaleString()} < ${MIN_REMAINING_UNITS.toLocaleString()}), leaving units for other workflows`);
    }
  } else {
    console.log('   ⚠️ Could not read quota: continuing under hard budget cap');
  }

  const countries = [];

  for (const c of COUNTRIES) {
    if (!budgetLeft()) { console.log(`   ⏸️ Budget reached (${unitsSpent}): stopping before ${c.name}`); break; }
    process.stdout.write(`   ${c.flag} ${c.name}... `);

    // Phase 1: gather candidates
    const candidates = new Map();
    for (const seed of c.seeds) {
      if (!budgetLeft()) break;
      try {
        const data = await ahrefsCall('keywords-explorer/matching-terms', {
          select: 'keyword,volume,difficulty,cpc,traffic_potential',
          country: c.code,
          keywords: seed,
          where: { and: [{ field: 'volume', is: ['gte', c.minVol] }] },
          order_by: 'volume:desc',
          limit: 100,
        });
        for (const kw of (data.keywords || [])) {
          const key = kw.keyword.toLowerCase().trim();
          if (!candidates.has(key)) candidates.set(key, kw);
        }
      } catch (e) {
        console.log(`\n      ⚠️ ${seed}: ${e.message.slice(0, 120)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Phase 2: filter + pick diverse top keywords
    const kept = Array.from(candidates.values()).filter(keepKeyword)
      .sort((a, b) => baseScore(b) - baseScore(a));
    const picked = [];
    for (const kw of kept) {
      if (picked.length >= TREND_KEYWORDS_PER_COUNTRY) break;
      if (picked.some(p => tooSimilar(p.keyword, kw.keyword))) continue;
      picked.push(kw);
    }

    // Phase 3: trends for the picked keywords
    for (const kw of picked) {
      if (!budgetLeft()) break;
      const g = await fetchGrowth(c.code, kw.keyword);
      kw.growthYoY = g.growthYoY;
      kw.momentum = g.momentum;
      kw.spark = (g.spark || []).map(r => r.volume);
      await new Promise(r => setTimeout(r, 250));
    }

    // Final per-country ranking: growth-weighted opportunity
    picked.sort((a, b) => {
      const oa = baseScore(a) * (1 + Math.max(a.growthYoY || 0, 0) / 100);
      const ob = baseScore(b) * (1 + Math.max(b.growthYoY || 0, 0) / 100);
      return ob - oa;
    });

    console.log(`${candidates.size} candidates → ${kept.length} product-intent → ${picked.length} tracked (units so far: ${unitsSpent})`);
    countries.push({ code: c.code, name: c.name, flag: c.flag, keywords: picked });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    skipped: false,
    unitsSpent,
    unitBudget: UNIT_BUDGET,
    countries,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  const total = countries.reduce((s, c) => s + c.keywords.length, 0);
  const rising = countries.flatMap(c => c.keywords.filter(k => (k.growthYoY || 0) >= 25).map(k => `${c.flag} ${k.keyword} (+${k.growthYoY}%)`));
  console.log(`\n   ✅ ${total} keywords tracked across ${countries.length} markets | ${unitsSpent.toLocaleString()} units spent`);
  if (rising.length) console.log(`   🔥 Rising: ${rising.slice(0, 6).join(' · ')}`);
  console.log(`   💾 Saved to data/market-radar.json\n`);
}

if (require.main !== module) {
  module.exports = { keepKeyword, baseScore, tooSimilar };
} else main().catch(err => {
  // Never break a report that runs after this in the same workflow
  console.log(`  ⚠️ Market radar aborted: ${err.message}`);
  try { writeSkipped(`aborted: ${err.message.slice(0, 150)}`); } catch {}
  process.exit(0);
});
