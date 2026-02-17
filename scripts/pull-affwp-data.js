#!/usr/bin/env node

/**
 * AffiliateWP Weekly CRO Report
 *
 * Pulls visit and referral data from the AffiliateWP REST API and outputs
 * a structured report with OfferNomics constraint diagnosis.
 *
 * URL domain mapping (based on real API data):
 *   Landing pages:  go.urbansketchcourse.com (Cloudflare static pages)
 *                   www.urbansketchcourse.com (WordPress — /courses/*, /smm/*)
 *   Order form:     learn.urbansketch.com (WordPress — /reg/*)
 *
 * Noise filtering:
 *   /meta.json requests on www.urbansketchcourse.com are excluded (automated requests)
 *
 * Funnel types:
 *   FREE funnel  — referral amount = 0 (free course registration, measures lead gen)
 *   PAID funnel  — referral amount > 0 (course purchase, measures revenue)
 *   The script reports both if both are present in the period.
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

// ─── URL classification ───────────────────────────────────
// Based on real API data analysis (Feb 2026):
//
// Landing pages:
//   go.urbansketchcourse.com/*         — Cloudflare static pages
//   www.urbansketchcourse.com/courses/* — WordPress course pages
//   www.urbansketchcourse.com/smm/*    — Social media marketing landing pages
//   www.urbansketchcourse.com/world-sketcher-collection/* — Collection page
//
// Order/registration forms (on learn.urbansketch.com):
//   /reg/*                — Free course registration forms
//   /smm/buy-*            — SMM purchase pages
//   /buy/*                — Direct purchase pages
//   /join-today/*         — Join pages
//   /products/*/order-form/* — Product order forms
//
// Noise:
//   www.urbansketchcourse.com/meta.json — Automated meta requests (~74% of all visits)
//
// Other learn.urbansketch.com pages (student content, T&C, etc.) are classified
// as 'learn_other' — tracked separately but not counted as order form visits.

function classifyVisit(visit) {
  if (!visit.url) return 'other';
  try {
    const u = new URL(visit.url);
    const host = u.hostname;
    const path = u.pathname.replace(/\/$/, ''); // normalise trailing slash

    // Static landing pages on Cloudflare
    if (host === 'go.urbansketchcourse.com') return 'landing';

    // WordPress landing pages
    if (host === 'www.urbansketchcourse.com') {
      if (path === '/meta.json') return 'noise';
      return 'landing';
    }

    // learn.urbansketch.com — separate order forms from other pages
    if (host === 'learn.urbansketch.com') {
      if (path.startsWith('/reg')) return 'order_form';
      if (path.startsWith('/smm/buy')) return 'order_form';
      if (path.startsWith('/buy')) return 'order_form';
      if (path.startsWith('/join-today')) return 'order_form';
      if (path.includes('/order-form')) return 'order_form';
      if (path.startsWith('/plus') && path.includes('coaching')) return 'order_form';
      return 'learn_other'; // student content, T&C, privacy, courses, etc.
    }

    return 'other';
  } catch {
    return 'other';
  }
}

// ─── API helpers ───────────────────────────────────────────
const AUTH_HEADER = 'Basic ' + Buffer.from(`${PUBLIC_KEY}:${TOKEN}`).toString('base64');
const API_BASE = `${PARENT_URL}/wp-json/affwp/v1`;

async function apiFetch(endpoint, params = {}) {
  const url = new URL(`${API_BASE}${endpoint}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: AUTH_HEADER },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`API ${resp.status}: ${text.slice(0, 200)}`);
    }

    return resp.json();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error(`API timeout after 30s: ${endpoint}`);
    }
    throw err;
  }
}

async function fetchAllVisits() {
  // AffiliateWP has high visit volumes (~7K/day) including automated /meta.json hits.
  // We fetch in large batches. At ~7K visits/day, a 7-day window = ~50K visits = ~100 batches.
  // This takes about 60-90 seconds. Max batches prevents runaway queries.
  const batchSize = 500;
  const maxBatches = 150; // Safety limit: 75K visits max
  let allVisits = [];
  let offset = 0;
  let keepGoing = true;
  let batchNum = 0;

  while (keepGoing && batchNum < maxBatches) {
    batchNum++;
    process.stderr.write(`  Fetching visits batch ${batchNum} (offset ${offset})...\r`);
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

  if (batchNum >= maxBatches && keepGoing) {
    process.stderr.write(`\n  WARNING: Hit max batch limit (${maxBatches}). Data may be incomplete.\n`);
    process.stderr.write(`  Consider using a shorter --days period.\n`);
  }

  process.stderr.write(`  Visits fetched: ${allVisits.length} records in ${batchNum} batches.                              \n`);
  return allVisits;
}

async function fetchAllReferrals() {
  const batchSize = 200;
  let allReferrals = [];
  let offset = 0;
  let keepGoing = true;
  let batchNum = 0;

  while (keepGoing) {
    batchNum++;
    process.stderr.write(`  Fetching referrals batch ${batchNum} (offset ${offset})...\r`);
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

  process.stderr.write('  Referrals fetched.                           \n');
  return allReferrals;
}

// ─── Main ──────────────────────────────────────────────────
async function main() {
  console.log(`Fetching AffiliateWP data for last ${days} days...\n`);

  const [visits, referrals] = await Promise.all([
    fetchAllVisits(),
    fetchAllReferrals(),
  ]);

  // Classify all visits
  const classified = visits.map(v => ({ ...v, _type: classifyVisit(v) }));
  const lpVisits = classified.filter(v => v._type === 'landing');
  const orderFormVisits = classified.filter(v => v._type === 'order_form');
  const noiseVisits = classified.filter(v => v._type === 'noise');
  const learnOtherVisits = classified.filter(v => v._type === 'learn_other');
  const otherVisits = classified.filter(v => v._type === 'other');

  // Separate referrals into free (lead gen) and paid (revenue)
  const freeReferrals = referrals.filter(r =>
    (r.status === 'paid' || r.status === 'unpaid' || r.status === 'pending') &&
    parseFloat(r.amount || 0) === 0
  );
  const paidReferrals = referrals.filter(r =>
    (r.status === 'paid' || r.status === 'unpaid') &&
    parseFloat(r.amount || 0) > 0
  );

  // For the main funnel report, "conversions" = all non-rejected referrals
  // In a free funnel, a conversion = a registration
  // In a paid funnel, a conversion = a purchase
  const allConversions = referrals.filter(r => r.status !== 'rejected');
  const totalRevenue = paidReferrals.reduce((sum, r) => sum + parseFloat(r.amount || 0), 0);

  // Calculations
  const lpCount = lpVisits.length;
  const ofCount = orderFormVisits.length;
  const conversionCount = allConversions.length;
  const paidCount = paidReferrals.length;
  const freeCount = freeReferrals.length;

  const lpToOfRate = lpCount > 0 ? (ofCount / lpCount * 100) : 0;
  const ofToConversionRate = ofCount > 0 ? (conversionCount / ofCount * 100) : 0;
  const endToEnd = lpCount > 0 ? (conversionCount / lpCount * 100) : 0;

  const aov = paidCount > 0 ? totalRevenue / paidCount : 0;
  const cpa = adSpend > 0 && conversionCount > 0 ? adSpend / conversionCount : 0;
  const costPerLead = adSpend > 0 && freeCount > 0 ? adSpend / freeCount : 0;
  const revenuePerVisitor = lpCount > 0 ? totalRevenue / lpCount : 0;
  const costPerVisitor = adSpend > 0 && lpCount > 0 ? adSpend / lpCount : 0;
  const cpaAovRatio = aov > 0 && cpa > 0 ? cpa / aov : 0;

  // Determine funnel type
  const isFreeOnly = paidCount === 0 && freeCount > 0;
  const isPaidOnly = paidCount > 0 && freeCount === 0;
  const isMixed = paidCount > 0 && freeCount > 0;
  const funnelLabel = isFreeOnly ? 'FREE (lead gen)' : isPaidOnly ? 'PAID (revenue)' : isMixed ? 'MIXED (free + paid)' : 'NO CONVERSIONS';

  // OfferNomics benchmarks
  const lpToOfBenchmark = 3;
  const ofCompletionBenchmark = 60;
  const lpToOfOk = lpToOfRate >= lpToOfBenchmark;
  const ofCompletionOk = ofToConversionRate >= ofCompletionBenchmark;
  const economicsOk = adSpend > 0 && paidCount > 0 ? cpa <= aov : null; // null = can't assess

  // Format helpers
  const fmt = (n) => `\u00a3${n.toFixed(2)}`;
  const pct = (n) => `${n.toFixed(1)}%`;
  const check = (ok) => ok === null ? '\u2014' : ok ? '\u2705' : '\u26a0\ufe0f';
  const pad = (s, len) => s.padEnd(len);

  // Date formatting
  const fmtDate = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  // ─── Output ────────────────────────────────────────────
  console.log(`WEEKLY CRO REPORT: ${fmtDate(startDate)} \u2192 ${fmtDate(now)}`);
  console.log(`Funnel type: ${funnelLabel}`);
  console.log('\u2550'.repeat(55));
  console.log('');

  // Raw data summary
  console.log('RAW DATA');
  console.log(`  Total visits in period:        ${visits.length}`);
  console.log(`  Total referrals in period:     ${referrals.length}`);
  console.log(`  Noise filtered (/meta.json):   ${noiseVisits.length}`);
  console.log(`  learn. other pages (not OF):   ${learnOtherVisits.length}`);
  console.log(`  Unclassified (other domains):  ${otherVisits.length}`);
  console.log('');

  console.log('FUNNEL METRICS');
  console.log(`  Landing page visits:           ${pad(lpCount.toString(), 6)} (go. + www. excl. noise)`);
  console.log(`  Order form visits:             ${pad(ofCount.toString(), 6)} (learn.urbansketch.com)`);
  console.log(`  LP \u2192 Order Form rate:          ${pad(pct(lpToOfRate), 8)} (benchmark: >${lpToOfBenchmark}%)  ${check(lpToOfOk)}`);
  console.log('');

  if (isFreeOnly) {
    console.log(`  Free registrations:            ${pad(freeCount.toString(), 6)} (amount = \u00a30.00)`);
    console.log(`  Order form \u2192 Registration:     ${pad(pct(ofToConversionRate), 8)} (benchmark: >${ofCompletionBenchmark}%)  ${check(ofCompletionOk)}`);
  } else if (isPaidOnly) {
    console.log(`  Paid sales:                    ${pad(paidCount.toString(), 6)}`);
    console.log(`  Order form \u2192 Purchase rate:    ${pad(pct(ofToConversionRate), 8)} (benchmark: >${ofCompletionBenchmark}%)  ${check(ofCompletionOk)}`);
  } else if (isMixed) {
    console.log(`  Free registrations:            ${pad(freeCount.toString(), 6)}`);
    console.log(`  Paid sales:                    ${pad(paidCount.toString(), 6)}`);
    console.log(`  Order form \u2192 Conversion rate:  ${pad(pct(ofToConversionRate), 8)} (benchmark: >${ofCompletionBenchmark}%)  ${check(ofCompletionOk)}`);
  } else {
    console.log(`  Conversions:                   0`);
  }
  console.log('');
  console.log(`  End-to-end conversion:         ${pct(endToEnd)}`);
  console.log('');

  console.log('FINANCIAL METRICS');
  if (paidCount > 0) {
    console.log(`  Revenue (from AffiliateWP):    ${fmt(totalRevenue)}`);
    console.log(`  AOV:                           ${fmt(aov)}`);
    console.log(`  Revenue per LP visitor:        ${lpCount > 0 ? fmt(revenuePerVisitor) : 'N/A'}`);
  } else {
    console.log(`  Revenue:                       \u00a30.00 (free funnel \u2014 no revenue tracked)`);
  }
  if (adSpend > 0) {
    console.log(`  Ad spend (input):              ${fmt(adSpend)}`);
    if (freeCount > 0) {
      console.log(`  Cost per lead (free reg):      ${fmt(costPerLead)}`);
    }
    if (paidCount > 0) {
      console.log(`  CPA (paid sales):              ${fmt(cpa)}`);
    }
    console.log(`  Cost per LP visitor:           ${fmt(costPerVisitor)}`);
    if (paidCount > 0) {
      console.log('');
      console.log(`  CPA:AOV RATIO: ${cpaAovRatio.toFixed(2)}:1  ${check(economicsOk)}`);
    }
  }
  console.log('');

  // OfferNomics diagnosis
  console.log('OFFERNOMICS DIAGNOSIS');
  console.log(`  \u251c\u2500 Media performance:    [Pull from GoMarble MCP \u2014 CPC, CTR]`);

  if (lpCount === 0) {
    console.log(`  \u251c\u2500 Campaign performance: No LP visits recorded \u26a0\ufe0f`);
    console.log(`  \u2502                        Check affiliate tracking is firing on ad landing pages`);
  } else if (lpToOfOk) {
    console.log(`  \u251c\u2500 Campaign performance: LP\u2192Order form at ${pct(lpToOfRate)} ${check(lpToOfOk)} above ${lpToOfBenchmark}%`);
  } else {
    console.log(`  \u251c\u2500 Campaign performance: LP\u2192Order form at ${pct(lpToOfRate)} ${check(lpToOfOk)} below ${lpToOfBenchmark}%`);
  }

  if (ofCount === 0) {
    console.log(`  \u251c\u2500                       No order form visits recorded`);
  } else if (ofCompletionOk) {
    console.log(`  \u251c\u2500                       Order form completion at ${pct(ofToConversionRate)} ${check(ofCompletionOk)} above ${ofCompletionBenchmark}%`);
  } else {
    console.log(`  \u251c\u2500                       Order form completion at ${pct(ofToConversionRate)} ${check(ofCompletionOk)} below ${ofCompletionBenchmark}%`);
  }

  if (adSpend > 0 && paidCount > 0) {
    if (economicsOk) {
      console.log(`  \u2514\u2500 Economic performance: CPA (${fmt(cpa)}) \u2264 AOV (${fmt(aov)}) ${check(economicsOk)}`);
    } else {
      console.log(`  \u2514\u2500 Economic performance: CPA (${fmt(cpa)}) > AOV (${fmt(aov)}) ${check(economicsOk)}`);
    }
  } else if (adSpend > 0 && isFreeOnly) {
    console.log(`  \u2514\u2500 Economic performance: Free funnel \u2014 cost per lead: ${fmt(costPerLead)} [provide --ad-spend for CPA]`);
  } else {
    console.log(`  \u2514\u2500 Economic performance: [Provide --ad-spend to calculate]`);
  }

  console.log('');

  // Constraint identification
  console.log('CONSTRAINT IDENTIFICATION');
  if (lpCount === 0) {
    console.log('  CONSTRAINT: DATA \u2014 No landing page visits in period');
    console.log('  ACTION: Verify affiliate tracking is firing. Check that ads point to tracked URLs.');
    console.log('          If using go.urbansketchcourse.com, ensure ?a= parameter is in ad URLs.');
  } else if (!lpToOfOk) {
    console.log('  CONSTRAINT: CAMPAIGN \u2014 Landing page not converting visitors to order form');
    console.log('  ACTION: Check Clarity heatmaps for scroll drop-off. Test headline, CTA placement, or copy.');
  } else if (!ofCompletionOk) {
    console.log('  CONSTRAINT: CAMPAIGN \u2014 Order form completion rate below benchmark');
    console.log('  ACTION: Review order form on learn.urbansketch.com \u2014 simplify fields, add trust signals.');
  } else if (adSpend > 0 && paidCount > 0 && !economicsOk) {
    console.log('  CONSTRAINT: ECONOMIC \u2014 CPA exceeds AOV');
    console.log('  ACTION: Increase AOV (add order bump, upsell, or raise price) or reduce CPA via better targeting/creative.');
  } else if (adSpend > 0 && isFreeOnly) {
    console.log(`  FREE FUNNEL \u2014 Lead gen cost: ${fmt(costPerLead)} per registration`);
    console.log('  ACTION: Evaluate against lifetime value. Consider: is cost per lead sustainable?');
  } else {
    console.log('  NO CONSTRAINT \u2014 All metrics are within benchmark! \ud83c\udf89');
    console.log('  ACTION: Optimise for growth \u2014 test bolder creative, scale ad spend, or expand to new audiences.');
  }

  console.log('');
  console.log('\u2500'.repeat(55));

  // Breakdown by landing page URL (top pages)
  const pages = {};
  for (const v of lpVisits) {
    try {
      const u = new URL(v.url);
      const label = u.hostname + u.pathname;
      pages[label] = (pages[label] || 0) + 1;
    } catch { /* skip malformed */ }
  }
  if (Object.keys(pages).length > 0) {
    console.log('\nVISITS BY LANDING PAGE:');
    for (const [page, count] of Object.entries(pages).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`  ${page}: ${count}`);
    }
  }

  // Breakdown by campaign (if any)
  const campaigns = {};
  for (const v of lpVisits) {
    const c = v.campaign || '(no campaign)';
    campaigns[c] = (campaigns[c] || 0) + 1;
  }
  const namedCampaigns = Object.entries(campaigns).filter(([k]) => k !== '(no campaign)');
  if (namedCampaigns.length > 0) {
    console.log('\nVISITS BY CAMPAIGN:');
    for (const [campaign, count] of Object.entries(campaigns).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${campaign}: ${count}`);
    }
  }

  // Breakdown by referrer domain
  const referrers = {};
  for (const v of lpVisits) {
    if (!v.referrer) { referrers['(direct)'] = (referrers['(direct)'] || 0) + 1; continue; }
    try {
      const u = new URL(v.referrer);
      referrers[u.hostname] = (referrers[u.hostname] || 0) + 1;
    } catch { referrers['(other)'] = (referrers['(other)'] || 0) + 1; }
  }
  if (Object.keys(referrers).length > 1 || (Object.keys(referrers).length === 1 && !referrers['(direct)'])) {
    console.log('\nLP VISITS BY REFERRER:');
    for (const [ref, count] of Object.entries(referrers).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${ref}: ${count}`);
    }
  }

  // Order form page breakdown
  const ofPages = {};
  for (const v of orderFormVisits) {
    try {
      const u = new URL(v.url);
      ofPages[u.pathname] = (ofPages[u.pathname] || 0) + 1;
    } catch {}
  }
  if (Object.keys(ofPages).length > 0) {
    console.log('\nORDER FORM / REGISTRATION PAGES:');
    for (const [page, count] of Object.entries(ofPages).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${page}: ${count}`);
    }
  }

  // learn.urbansketch.com other pages (not order forms — for diagnostic purposes)
  if (learnOtherVisits.length > 0) {
    const learnPages = {};
    for (const v of learnOtherVisits) {
      try {
        const u = new URL(v.url);
        learnPages[u.pathname] = (learnPages[u.pathname] || 0) + 1;
      } catch {}
    }
    console.log(`\nlearn.urbansketch.com OTHER (${learnOtherVisits.length} visits, not counted as order form):`);
    for (const [page, count] of Object.entries(learnPages).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`  ${page}: ${count}`);
    }
  }
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
