// JobRadar - server.js v8.1
// ENV VARS: ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY, SENDGRID_API_KEY, ALERT_EMAIL, FROM_EMAIL, SUPABASE_URL, SUPABASE_KEY

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Supabase client (lightweight, no SDK needed) ──────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabase(method, table, body, query = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}${query}`);
    const data = body ? JSON.stringify(body) : null;
    const options = {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : ''
      }
    };
    const req = https.request(url, options, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function initDB() {
  // Create seen_jobs table if not exists via RPC — use raw SQL through REST
  try {
    await supabase('POST', 'rpc/exec', { sql: `CREATE TABLE IF NOT EXISTS seen_jobs (id TEXT PRIMARY KEY, seen_at TIMESTAMPTZ DEFAULT NOW());` });
  } catch(e) {}
  try {
    await supabase('POST', 'rpc/exec', { sql: `CREATE TABLE IF NOT EXISTS feedback (job_id TEXT, result TEXT, created_at TIMESTAMPTZ DEFAULT NOW());` });
  } catch(e) {}
}

async function isJobSeen(id) {
  try {
    const res = await supabase('GET', 'seen_jobs', null, `?id=eq.${encodeURIComponent(id)}&select=id`);
    return Array.isArray(res) && res.length > 0;
  } catch(e) { return false; }
}

async function markJobSeen(id) {
  try {
    await supabase('POST', 'seen_jobs', { id });
  } catch(e) {}
}

async function saveFeedback(jobId, result) {
  try {
    await supabase('POST', 'feedback', { job_id: jobId, result });
  } catch(e) {}
}

// ── Fallback in-memory seen (if Supabase fails) ───────────────
const memSeen = new Set();

// ── Blocked companies ─────────────────────────────────────────
const BLOCKED_COMPANIES = [
  'itol', 'firebrand', 'just it', 'intequal', 'qa ltd', 'qa limited',
  'estio', 'baltic apprenticeships', 'multiverse', 'corndel', 'qa',
  'newto training', 'training course'
];

// ── Red flag phrases ──────────────────────────────────────────
const RED_FLAGS = [
  'fast paced', 'fast-paced', 'self starter', 'self-starter',
  'hit the ground running', 'no two days the same', 'wear many hats',
  'sink or swim', 'hungry', 'hustler', 'grind'
];

// ── Profile ───────────────────────────────────────────────────
const CV = `Luke Grainger, Stoke-on-Trent. Current salary £26,000.
Experience:
- Patient Advisor, Optical Express (2024-present): patient consultations, diagnostic equipment, CRM, finance processing, admin.
- Connectivity Genius, Audi (2023-2024): tech specialist explaining connected car tech, troubleshooting, onboarding customers onto digital platforms.
- Product Genius, Arnold Clark (2019-2023): customer education, test drives, vehicle imaging, finance qualified.
- Sales Advisor, Currys (2016-2019): inbound product sales, broad tech knowledge.
Skills: Technical troubleshooting, CRM/database management, Excel, explaining complex things simply, customer onboarding, relationship building, admin.
No formal IT qualifications but strong practical tech aptitude.`;

const PREFS = `Luke is looking for roles with good job satisfaction, clear progression, positive culture, and reasonable work-life balance. Tech-adjacent roles are ideal but any well-regarded role with development opportunities is worth considering.

TARGET ROLES (not exclusive): Customer Success, Service Desk, IT Support, Helpdesk, Technical Support, IT Coordinator, Support Analyst, Client Onboarding, Product Support, Account Coordinator, Technical Trainer, Customer Experience, Implementation Coordinator, Operations Coordinator, Project Coordinator, Business Support.

LOCATION: Stoke-on-Trent within 10 miles OR fully remote (UK). Min salary £24,000. Weekdays only.

SENIORITY: Luke is entry to mid-level. HEAVILY penalise roles with titles containing Manager/Senior/Lead/Head/Director if salary is above £40k and no training/entry-level language present. These are stretch roles at best.

KEYWORD REWARDS: "training provided", "full training", "no experience necessary", "career development", "progression", "study support", "hybrid", "remote", "entry level", "junior", "development programme", "flexible working", "work life balance", "great culture", "supportive team"

KEYWORD PENALTIES: "outbound", "cold calling", "KPI", "targets", "commission", "door to door", "field sales", "ITIL essential", "CCNA essential", "degree essential", "management experience required", "3+ years experience", "5+ years", "fast paced", "self starter", "hit the ground running"

SENIORITY LABEL RULES:
- "Realistic": entry/junior role, Luke is a strong candidate
- "Stretch": mid-level role, some gaps but worth applying
- "Speculative": senior/overlevelled, long shot but worth a try

SCORING:
- Entry/junior with training: 75-85
- Good culture/progression indicators: reward
- Direct match to Audi/Optical Express experience: reward
- Remote/hybrid: reward
- Formal certs essential: penalise
- Management roles with no training language: penalise heavily
- Red flag culture phrases: penalise

HARD REJECT if: outbound/cold calling, commission-only, door-to-door, shift/evening/weekend, under £24k, manual labour, over £80k salary (bad data), trainee scheme run by recruiter.`;

// ── Fetch ─────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/html', ...options.headers },
      ...options
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Searches ──────────────────────────────────────────────────
const SEARCHES = [
  'customer success', 'technical support', 'IT support',
  'helpdesk', 'client onboarding', 'operations coordinator',
  'customer experience', 'support analyst'
];

// ── Job processing ────────────────────────────────────────────
function isBlocked(company, title, description) {
  const co = company.toLowerCase();
  const desc = (description || '').toLowerCase();
  if (BLOCKED_COMPANIES.some(b => co.includes(b))) return true;
  if (desc.includes('training course') || desc.includes('upfront cost') || desc.includes('pay for your')) return true;
  return false;
}

function getPostedDaysAgo(dateStr) {
  if (!dateStr) return null;
  try {
    const posted = new Date(dateStr);
    const diff = Math.floor((Date.now() - posted) / (1000 * 60 * 60 * 24));
    return diff;
  } catch(e) { return null; }
}

function countRedFlags(description) {
  const desc = (description || '').toLowerCase();
  return RED_FLAGS.filter(f => desc.includes(f)).length;
}

// ── Adzuna ────────────────────────────────────────────────────
async function scrapeAdzuna() {
  const jobs = [];
  for (const q of SEARCHES) {
    // Stoke
    try {
      const params = new URLSearchParams({ app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, results_per_page: 20, what: q, where: 'Stoke-on-Trent', distance: 10, salary_min: 24000, full_time: 1, permanent: 1 });
      const parsed = JSON.parse(await fetchUrl(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`));
      for (const job of (parsed.results || [])) {
        const salMax = job.salary_max || job.salary_min || 0;
        if (salMax > 80000) continue;
        if (isBlocked(job.company?.display_name || '', job.title, job.description)) continue;
        const daysAgo = getPostedDaysAgo(job.created);
        jobs.push({
          id: `adzuna-${job.id}`,
          dedupKey: `${(job.company?.display_name||'').toLowerCase().trim()}|${job.title.toLowerCase().trim()}`,
          title: job.title, company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(salMax).toLocaleString()}` : 'Not specified',
          location: job.location?.display_name || 'Stoke-on-Trent',
          description: job.description || '', url: job.redirect_url,
          source: 'Adzuna', daysAgo, redFlags: countRedFlags(job.description)
        });
      }
      await sleep(300);
    } catch(e) { console.error(`Adzuna Stoke (${q}):`, e.message); }

    // Remote
    try {
      const params = new URLSearchParams({ app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, results_per_page: 20, what: `${q} remote`, salary_min: 24000, full_time: 1, permanent: 1 });
      const parsed = JSON.parse(await fetchUrl(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`));
      for (const job of (parsed.results || [])) {
        const salMax = job.salary_max || job.salary_min || 0;
        if (salMax > 80000) continue;
        if (isBlocked(job.company?.display_name || '', job.title, job.description)) continue;
        const desc = (job.description || '').toLowerCase();
        if (!desc.includes('remote') && !desc.includes('work from home') && !desc.includes('wfh')) continue;
        const daysAgo = getPostedDaysAgo(job.created);
        jobs.push({
          id: `adzuna-remote-${job.id}`,
          dedupKey: `${(job.company?.display_name||'').toLowerCase().trim()}|${job.title.toLowerCase().trim()}`,
          title: job.title, company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(salMax).toLocaleString()}` : 'Not specified',
          location: 'Remote (UK)', description: job.description || '',
          url: job.redirect_url, source: 'Adzuna', daysAgo, redFlags: countRedFlags(job.description)
        });
      }
      await sleep(300);
    } catch(e) { console.error(`Adzuna Remote (${q}):`, e.message); }
  }
  return jobs;
}

// ── Indeed RSS ────────────────────────────────────────────────
async function scrapeIndeed() {
  const jobs = [];
  for (const q of SEARCHES) {
    for (const loc of [{ l: 'Stoke-on-Trent', label: 'Stoke-on-Trent area' }, { l: 'Remote', label: 'Remote' }]) {
      try {
        const xml = await fetchUrl(`https://uk.indeed.com/rss?q=${q.replace(/ /g,'+')}&l=${loc.l}&radius=10&fromage=7`);
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        for (const item of items) {
          const get = tag => { const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([^\\]]+)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m?(m[1]||m[2]||'').trim():''; };
          const link = get('link'); if (!link) continue;
          const title = get('title'), company = get('source');
          const desc = get('description').replace(/<[^>]+>/g,'');
          if (isBlocked(company, title, desc)) continue;
          const pubDate = get('pubDate');
          const daysAgo = pubDate ? Math.floor((Date.now() - new Date(pubDate)) / 86400000) : null;
          jobs.push({
            id: `indeed-${loc.l}-${Buffer.from(link).toString('base64').slice(0,16)}`,
            dedupKey: `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`,
            title, company, salary: 'See listing', location: loc.label,
            description: desc, url: link, source: 'Indeed',
            daysAgo, redFlags: countRedFlags(desc)
          });
        }
        await sleep(500);
      } catch(e) { console.error(`Indeed (${q}/${loc.l}):`, e.message); }
    }
  }
  return jobs;
}

// ── Dedup ─────────────────────────────────────────────────────
function deduplicate(jobs) {
  const ids = new Set(), keys = new Set(), result = [];
  for (const j of jobs) {
    if (ids.has(j.id) || keys.has(j.dedupKey)) continue;
    ids.add(j.id); keys.add(j.dedupKey); result.push(j);
  }
  return result;
}

// ── Claude scoring ────────────────────────────────────────────
async function scoreJob(job) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 250,
        messages: [{ role: 'user', content: `Score this job for Luke. Return ONLY valid JSON with no markdown:
{"score":0-100,"verdict":"max 20 words referencing Luke's specific experience","hardReject":true/false,"label":"Realistic|Stretch|Speculative"}

CV: ${CV}
PREFS: ${PREFS}
Red flags detected: ${job.redFlags}

JOB: ${job.title} | ${job.company} | ${job.salary} | ${job.location}
DESC: ${job.description.slice(0,1500)}` }]
      })
    });
    const data = await res.json();
    return JSON.parse((data.content?.[0]?.text||'{}').replace(/```json|```/g,'').trim());
  } catch(e) { return { score: 0, verdict: 'Error', hardReject: false, label: 'Speculative' }; }
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.ALERT_EMAIL }] }],
      from: { email: process.env.FROM_EMAIL || process.env.ALERT_EMAIL, name: 'JobRadar' },
      subject, content: [{ type: 'text/html', value: html }]
    })
  });
  if (!res.ok) console.error('SendGrid error:', await res.text());
}

function labelStyle(label) {
  if (label === 'Realistic') return 'background:#EAF3DE;color:#3B6D11';
  if (label === 'Stretch') return 'background:#FAEEDA;color:#854F0B';
  return 'background:#FCEBEB;color:#A32D2D';
}

function scoreCircleStyle(label) {
  if (label === 'Realistic') return 'background:#EAF3DE;color:#3B6D11';
  if (label === 'Stretch') return 'background:#FAEEDA;color:#854F0B';
  return 'background:#FCEBEB;color:#A32D2D';
}

function freshnessBadge(daysAgo) {
  if (daysAgo === null) return '';
  if (daysAgo === 0) return '<span style="background:#E6F1FB;color:#185FA5;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">New today</span>';
  if (daysAgo <= 2) return `<span style="background:#E6F1FB;color:#185FA5;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">${daysAgo}d ago</span>`;
  return `<span style="color:#999;font-size:11px;margin-left:6px;">${daysAgo}d ago</span>`;
}

function redFlagWarning(count) {
  if (count === 0) return '';
  return `<span style="color:#A32D2D;font-size:11px;margin-left:6px;">⚠ ${count} culture red flag${count>1?'s':''}</span>`;
}

async function sendDigest(jobs) {
  if (!jobs.length) return;

  const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://job-radar-xhhi.onrender.com';

  const cards = jobs.map(j => `
    <tr><td style="padding:0 0 16px;">
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;font-family:sans-serif;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;">
              <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;${labelStyle(j.label)}">${j.label}</span>
              <span style="background:#f3f4f6;color:#6b7280;font-size:11px;padding:3px 8px;border-radius:20px;margin-left:6px;">${j.location}</span>
              ${freshnessBadge(j.daysAgo)}
              ${redFlagWarning(j.redFlags)}
            </div>
            <p style="font-size:16px;font-weight:600;margin:0 0 2px;color:#111;">${j.title}</p>
            <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${j.company}</p>
            <p style="font-size:13px;color:#374151;margin:0 0 10px;line-height:1.5;font-style:italic;">${j.verdict}</p>
            <p style="font-size:15px;font-weight:600;color:#111;margin:0 0 12px;">💰 ${j.salary}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <a href="${j.url}" style="background:#111;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Apply →</a>
              <a href="${baseUrl}/feedback?id=${encodeURIComponent(j.id)}&result=good" style="background:#EAF3DE;color:#3B6D11;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Good match ✓</a>
              <a href="${baseUrl}/feedback?id=${encodeURIComponent(j.id)}&result=bad" style="background:#f3f4f6;color:#6b7280;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Not relevant ✗</a>
            </div>
          </div>
          <div style="width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;${scoreCircleStyle(j.label)}">${j.score}</div>
        </div>
      </div>
    </td></tr>`).join('');

  const legend = `<tr><td style="padding:16px 0 0;border-top:1px solid #e5e7eb;text-align:center;">
    <span style="font-size:12px;color:#9ca3af;">
      <span style="color:#3B6D11;font-weight:600;">Realistic</span> = strong candidate &nbsp;·&nbsp;
      <span style="color:#854F0B;font-weight:600;">Stretch</span> = apply anyway &nbsp;·&nbsp;
      <span style="color:#A32D2D;font-weight:600;">Speculative</span> = long shot
    </span>
  </td></tr>`;

  await sendEmail(
    `🎯 JobRadar: ${jobs.length} new match${jobs.length>1?'es':''} — ${new Date().toLocaleDateString('en-GB')}`,
    `<div style="max-width:620px;margin:0 auto;padding:20px;font-family:sans-serif;">
      <p style="font-size:12px;color:#9ca3af;margin:0 0 4px;">JobRadar · ${new Date().toLocaleDateString('en-GB')} · Stoke +10mi + Remote · £24k+</p>
      <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 20px;">${jobs.length} new job match${jobs.length>1?'es':''} today</h1>
      <table style="width:100%;border-collapse:collapse;">${cards}${legend}</table>
      <p style="font-size:11px;color:#d1d5db;text-align:center;margin-top:16px;">JobRadar v8.1</p>
    </div>`
  );
  console.log(`Email sent: ${jobs.length} jobs`);
}

// ── Main scan ──────────────────────────────────────────────────
let lastScanTime = null;
let lastScanCount = 0;

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  let all = [], errors = [];
  try { all = all.concat(await scrapeAdzuna()); } catch(e) { errors.push(`Adzuna: ${e.message}`); }
  try { all = all.concat(await scrapeIndeed()); } catch(e) { errors.push(`Indeed: ${e.message}`); }

  if (!all.length && errors.length) {
    await sendEmail('⚠️ JobRadar scan failed', `<p>${errors.join('<br>')}</p>`);
    return;
  }

  const unique = deduplicate(all);
  console.log(`${all.length} found → ${unique.length} unique`);

  const fresh = [];
  for (const job of unique) {
    const seen = await isJobSeen(job.id) || memSeen.has(job.id);
    if (!seen) fresh.push(job);
  }
  console.log(`${fresh.length} new`);
  if (!fresh.length) { lastScanTime = new Date(); lastScanCount = 0; return; }

  // Sort fresh jobs — newer first
  fresh.sort((a, b) => (a.daysAgo ?? 99) - (b.daysAgo ?? 99));

  // Pre-filter obvious rejects without calling Claude
  const BAD_TITLES = ["mechanic", "cad technician", "welder", "plumber", "electrician", "hgv", "forklift", "chef", "cleaner", "security guard", "care assistant", "warehouse operative"];
  const BAD_DESC = ["outbound calls", "cold calling", "door to door", "commission only", "zero hours contract"];
  const toScore = fresh.filter(job => {
    const title = job.title.toLowerCase();
    const desc = (job.description || "").toLowerCase();
    if (BAD_TITLES.some(t => title.includes(t))) { markJobSeen(job.id); memSeen.add(job.id); return false; }
    if (BAD_DESC.some(t => desc.includes(t))) { markJobSeen(job.id); memSeen.add(job.id); return false; }
    return true;
  });
  console.log(toScore.length + " to score after pre-filter");

  const scored = [];
  for (const job of toScore) {
    const result = await scoreJob(job);
    await markJobSeen(job.id);
    memSeen.add(job.id);
    console.log(`  ${job.title} @ ${job.company} | ${result.score} | ${result.label} | ${result.hardReject?'REJECT':'OK'}`);
    if (!result.hardReject && result.score >= 60) scored.push({ ...job, ...result });
    await sleep(300);
  }

  lastScanTime = new Date();
  lastScanCount = scored.length;

  if (!scored.length) { console.log('No matches this scan'); return; }

  // Sort by score then send
  scored.sort((a, b) => b.score - a.score);
  console.log(`${scored.length} jobs scored 60+ — sending email`);

  // Send in one batch but cap at 15 to keep email manageable
  await sendDigest(scored.slice(0, 15));
}

// ── Cron 8am ──────────────────────────────────────────────────
function schedule() {
  const now = new Date(), next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(() => { runScan(); setInterval(runScan, 86400000); }, ms);
  console.log(`Next auto-scan in ${Math.round(ms/60000)} mins`);
}

// ── Routes ─────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(`
  <div style="font-family:sans-serif;max-width:400px;margin:40px auto;padding:20px;">
    <h2>JobRadar v8.1</h2>
    <p>Last scan: ${lastScanTime ? lastScanTime.toLocaleString('en-GB') : 'Never'}</p>
    <p>Last scan matches: ${lastScanCount}</p>
    <p>
      <a href="/scan">▶ Manual scan</a> &nbsp;|&nbsp;
      <a href="/reset">↺ Reset seen jobs</a> &nbsp;|&nbsp;
      <a href="/status">Status</a>
    </p>
  </div>
`));

app.get('/scan', (_, res) => { res.send('Scan started — check inbox in ~3 mins.'); runScan(); });

app.get('/reset', async (_, res) => {
  memSeen.clear();
  try { await supabase('DELETE', 'seen_jobs', null, '?id=neq.null'); } catch(e) {}
  res.send('Reset done — next scan processes all listings.');
});

app.get('/status', (_, res) => {
  res.json({
    version: 'v8',
    lastScan: lastScanTime,
    lastScanMatches: lastScanCount,
    memSeenCount: memSeen.size
  });
});

app.get('/feedback', async (req, res) => {
  const { id, result } = req.query;
  if (!id || !result) return res.send('Invalid feedback.');
  await saveFeedback(id, result);
  res.send(`Thanks for the feedback — marked as "${result}". You can close this tab.`);
});

app.get('/ping', (_, res) => res.send('pong'));

// ── Start ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`JobRadar v8.1 running on port ${PORT}`);
  await initDB().catch(e => console.log('DB init note:', e.message));
  schedule();
});
