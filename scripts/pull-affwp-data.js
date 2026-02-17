#!/usr/bin/env node

/**
 * AffiliateWP Weekly CRO Report
 *
 * Pulls visit and referral data from the AffiliateWP REST API and outputs
 * a structured report with OfferNomics constraint diagnosis.
 *
 * Usage:
 *   node scripts/pull-affwp-data.js --days 7
 *   node scripts/pull-affwp-data.js --days 7 --ad-spend 500
 *   node scripts/pull-affwp-data.js --days 14 --ad-spend 1000
 *
 * Credentials: reads from scripts/.env (not committed to git)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ─── Parse .env ────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '.env');
let envVars = {};
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    envVars[key] = val;
  }
} catch (e) {
  console.error('ERROR: Could not read scripts/.env');
  console.error('Create it from .env.example with your AffiliateWP credentials.');
  process.exit(1);
}

const PARENT_URL = (envVars.AFFWP_PARENT_URL || '').replace(/\/$/, '');
const PUBLIC_KEY = envVars.AFFWP_PUBLIC_KEY || '';
const TOKEN = envVars.AFFWP_TOKEN || '';

if (!PARENT_URL || !PUBLIC_KEY || !TOKEN) {
  console.error('ERROR: Missing required env vars. Check scripts/.env');
  console.error('Need: AFFWP_PARENT_URL, AFFWP_PUBLIC_KEY, AFFWP_TOKEN');
  process.exit(1);
}

// ─── Parse CLI args ────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, defaultVal) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}

const days = parseInt(getArg('days', '7'), 10);
const adSpend = parseFloat(getArg('ad-spend', '0'));
const now = new Date();
const startDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

// ─── API helpers ───────────────────────────────────────────
const AUTH_HEADER = 'Basic ' + Buffer.from(`${PUBLIC_KEY}:${TOKEN}`).toString('base64');
const API_BASE = `${PARENT_URL}/wp-json/affwp/v1`;

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const resp = await fetch(url.toString(), {
    headers: { Authorization: AUTH_HEADER },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
  }

  return resp.json();
}

async function fetchAllVisits() {
  // Fetch a large batch and filter by date client-side (more reliable than API date filter)
  const batchSize = 500;
  let allVisits = [];
  let offset = 0;
  let keepGoing = true;

  while (keepGoing) {
    const batch = await apiFetch('/visits', {
      number: batchSize.toString(),
      offset: offset.toString(),
      orderby: 'date',
      order: 'DESC',
    });

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const v of batch) {
      const visitDate = new Date(v.date);
      if (visitDate < startDate) {
        keepGoing = false;
        break;
      }
      allVisits.push(v);
    }

    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  return allVisits;
}

async function fetchAllReferrals() {
  const batchSize = 200;
  let allReferrals = [];
  let offset = 0;
  let keepGoing = true;

  while (keepGoing) {
    const batch = await apiFetch('/referrals', {
      number: batchSize.toString(),
      offset: offset.toString(),
      orderby: 'date',
      order: 'DESC',
    });

    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const r of batch) {
      const refDate = new Date(r.date);
      if (refDate < startDate) {
        keepGoing = false;
        break;
      }
      allReferrals.push(r);
    }

    if (batch.length < batchSize) break;
    offset += batchSize;
  }

  return allReferrals;
}

// ─── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`Fetching AffiliateWP data for last ${days} days...\n`);

  const [visits, referrals] = await Promise.all([
    fetchAllVisits(),
    fetchAllReferrals(),
  ]);

  // Separate visits by domain
  const lpVisits = visits.filter(v => v.url && v.url.includes('go.urbansketchcourse.com'));
  const orderFormVisits = visits.filter(v => v.url && v.url.includes('learn.urbansketch.com'));

  // Sales = referrals with status paid or unpaid (pending = not yet processed)
  const sales = referrals.filter(r => r.status === 'paid' || r.status === 'unpaid');
  const totalRevenue = sales.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

  // Calculations
  const lpCount = lpVisits.length;
  const ofCount = orderFormVisits.length;
  const salesCount = sales.length;

  const lpToOfRate = lpCount > 0 ? (ofCount / lpCount * 100) : 0;
  const ofToSaleRate = ofCount > 0 ? (salesCount / ofCount * 100) : 0;
  const endToEnd = lpCount > 0 ? (salesCount / lpCount * 100) : 0;

  const aov = salesCount > 0 ? totalRevenue / salesCount : 0;
  const cpa = adSpend > 0 && salesCount > 0 ? adSpend / salesCount : 0;
  const revenuePerVisitor = lpCount > 0 ? totalRevenue / lpCount : 0;
  const costPerVisitor = adSpend > 0 && lpCount > 0 ? adSpend / lpCount : 0;
  const cpaAovRatio = aov > 0 && cpa > 0 ? cpa / aov : 0;

  // OfferNomics benchmarks
  const lpToOfBenchmark = 3; // >3% sales page → order form
  const ofCompletionBenchmark = 60; // >60% order form completion
  const lpToOfOk = lpToOfRate >= lpToOfBenchmark;
  const ofCompletionOk = ofToSaleRate >= ofCompletionBenchmark;
  const economicsOk = adSpend > 0 ? cpa <= aov : true; // Can't assess without ad spend

  // Format helpers
  const fmt = (n) => `£${n.toFixed(2)}`;
  const pct = (n) => `${n.toFixed(1)}%`;
  const check = (ok) => ok ? '✅' : '⚠️';
  const pad = (s, len) => s.padEnd(len);

  // Date formatting
  const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  // ─── Output ────────────────────────────────────────────
  console.log(`WEEKLY CRO REPORT: ${fmtDate(startDate)} → ${fmtDate(now)}`);
  console.log('═'.repeat(50));
  console.log('');

  console.log('FUNNEL METRICS');
  console.log(`  Landing page visits (go.):     ${pad(lpCount.toString(), 6)}`);
  console.log(`  Order form visits (learn.):    ${pad(ofCount.toString(), 6)}`);
  console.log(`  LP → Order Form rate:          ${pad(pct(lpToOfRate), 8)} (benchmark: >${lpToOfBenchmark}%)  ${check(lpToOfOk)}`);
  console.log('');
  console.log(`  Sales (paid+unpaid referrals): ${pad(salesCount.toString(), 6)}`);
  console.log(`  Order form → Purchase rate:    ${pad(pct(ofToSaleRate), 8)} (benchmark: >${ofCompletionBenchmark}%)  ${check(ofCompletionOk)}`);
  console.log('');
  console.log(`  End-to-end conversion:         ${pct(endToEnd)}`);
  console.log('');

  console.log('FINANCIAL METRICS');
  console.log(`  Revenue (from AffiliateWP):    ${fmt(totalRevenue)}`);
  if (adSpend > 0) {
    console.log(`  Ad spend (input):              ${fmt(adSpend)}`);
    console.log(`  CPA:                           ${fmt(cpa)}`);
  }
  console.log(`  AOV:                           ${aov > 0 ? fmt(aov) : 'N/A (no sales)'}`);
  console.log(`  Revenue per visitor:           ${lpCount > 0 ? fmt(revenuePerVisitor) : 'N/A'}`);
  if (adSpend > 0) {
    console.log(`  Cost per visitor:              ${fmt(costPerVisitor)}`);
    console.log('');
    console.log(`  CPA:AOV RATIO: ${cpaAovRatio.toFixed(2)}:1  ${check(economicsOk)}`);
  }
  console.log('');

  // OfferNomics diagnosis
  console.log('OFFERNOMICS DIAGNOSIS');
  console.log(`  ├─ Media performance:    [Pull from GoMarble MCP — CPC, CTR]`);

  if (lpToOfOk) {
    console.log(`  ├─ Campaign performance: LP→Order form at ${pct(lpToOfRate)} ${check(lpToOfOk)} above ${lpToOfBenchmark}%`);
  } else {
    console.log(`  ├─ Campaign performance: LP→Order form at ${pct(lpToOfRate)} ${check(lpToOfOk)} below ${lpToOfBenchmark}%`);
  }

  if (ofCompletionOk) {
    console.log(`  ├─                       Order form completion at ${pct(ofToSaleRate)} ${check(ofCompletionOk)} above ${ofCompletionBenchmark}%`);
  } else {
    console.log(`  ├─                       Order form completion at ${pct(ofToSaleRate)} ${check(ofCompletionOk)} below ${ofCompletionBenchmark}%`);
  }

  if (adSpend > 0) {
    if (economicsOk) {
      console.log(`  └─ Economic performance: CPA (${fmt(cpa)}) ≤ AOV (${fmt(aov)}) ${check(economicsOk)}`);
    } else {
      console.log(`  └─ Economic performance: CPA (${fmt(cpa)}) > AOV (${fmt(aov)}) ${check(economicsOk)}`);
    }
  } else {
    console.log(`  └─ Economic performance: [Provide --ad-spend to calculate]`);
  }

  console.log('');

  // Constraint identification
  if (adSpend > 0) {
    console.log('CONSTRAINT IDENTIFICATION');
    if (!lpToOfOk) {
      console.log('  CONSTRAINT: CAMPAIGN — Landing page not converting visitors to order form');
      console.log('  ACTION: Check Clarity heatmaps for scroll drop-off. Test headline, CTA placement, or copy.');
    } else if (!ofCompletionOk) {
      console.log('  CONSTRAINT: CAMPAIGN — Order form completion rate below benchmark');
      console.log('  ACTION: Review order form on learn.urbansketch.com — simplify fields, add trust signals, test two-step checkout.');
    } else if (!economicsOk) {
      console.log('  CONSTRAINT: ECONOMIC — CPA exceeds AOV');
      console.log('  ACTION: Increase AOV (add order bump, upsell, or raise price) or reduce CPA via better ad targeting/creative.');
    } else {
      console.log('  NO CONSTRAINT — All metrics are within benchmark! 🎉');
      console.log('  ACTION: Optimise for growth — test bolder creative, scale ad spend, or expand to new audiences.');
    }
  }

  console.log('');
  console.log('─'.repeat(50));
  console.log(`Total visits in period: ${visits.length}`);
  console.log(`Total referrals in period: ${referrals.length}`);

  // Breakdown by campaign (if any)
  const campaigns = {};
  for (const v of lpVisits) {
    const c = v.campaign || '(no campaign)';
    campaigns[c] = (campaigns[c] || 0) + 1;
  }
  if (Object.keys(campaigns).length > 1 || (Object.keys(campaigns).length === 1 && !campaigns['(no campaign)'])) {
    console.log('\nVISITS BY CAMPAIGN:');
    for (const [campaign, count] of Object.entries(campaigns).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${campaign}: ${count}`);
    }
  }

  // Breakdown by URL (top pages)
  const pages = {};
  for (const v of lpVisits) {
    try {
      const u = new URL(v.url);
      const p = u.pathname;
      pages[p] = (pages[p] || 0) + 1;
    } catch { /* skip malformed */ }
  }
  if (Object.keys(pages).length > 1) {
    console.log('\nVISITS BY LANDING PAGE:');
    for (const [page, count] of Object.entries(pages).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${page}: ${count}`);
    }
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
