// JobRadar - server.js v5
// ENV VARS: ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY, SENDGRID_API_KEY, ALERT_EMAIL, FROM_EMAIL

const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

// ── Seen jobs ─────────────────────────────────────────────────
const SEEN_FILE = './seen.json';
let seenJobs = new Set();
try { if (fs.existsSync(SEEN_FILE)) seenJobs = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch(e) {}
const saveSeen = () => { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenJobs])); } catch(e) {} };

// ── Blocked companies (training schemes posing as jobs) ───────
const BLOCKED_COMPANIES = [
  'itol', 'firebrand', 'just it', 'intequal', 'qa ltd', 'qa limited',
  'estio', 'baltic apprenticeships', 'multiverse', 'corndel'
];

// ── Profile ───────────────────────────────────────────────────
const CV = `Luke Grainger, Stoke-on-Trent. Current salary £26,000. Career changer moving into tech/SaaS roles.
Experience:
- Patient Advisor, Optical Express (2024-present): patient consultations, diagnostic equipment, CRM, finance processing, admin, coordinating with clinical teams.
- Connectivity Genius, Audi (2023-2024): technical specialist explaining connected car tech, troubleshooting MyAudi/Audi Connect, onboarding customers onto digital platforms — essentially a customer success role.
- Product Genius, Arnold Clark (2019-2023): customer education, test drives, vehicle imaging, progressed to level 3 (finance qualified).
- Sales Advisor, Currys (2016-2019): inbound product sales, broad tech knowledge, care plans.
Skills: Technical troubleshooting, CRM/database management, Excel, explaining complex tech simply, customer onboarding, relationship building, admin.
No formal IT qualifications but strong practical tech aptitude. Career changer — enthusiasm and transferable skills are the pitch.`;

const PREFS = `Luke is a career changer targeting entry/mid-level tech and tech-adjacent roles where transferable skills matter.

TARGET ROLES: Customer Success, Service Desk, IT Support, Helpdesk, Technical Support, IT Coordinator, Support Analyst, Client Onboarding, Product Support, Account Coordinator, Technical Trainer, Customer Experience, Implementation Coordinator, Operations Coordinator.

LOCATION: Stoke-on-Trent within 10 miles OR fully remote. Min salary £24,000. Weekdays only.

KEYWORD REWARDS — increase score if job description contains:
"training provided", "full training", "no experience necessary", "career development", "progression", "study support", "hybrid", "remote", "entry level", "junior", "grow", "development programme"

KEYWORD PENALTIES — decrease score if job description contains:
"outbound", "cold calling", "KPI", "targets", "commission", "door to door", "field sales", "business development", "ITIL essential", "CCNA essential", "degree essential", "CompTIA essential", "team leader", "manager", "management experience", "3+ years", "5+ years"

SCORING GUIDANCE:
- Entry/junior roles with training: reward heavily
- Roles matching Luke's Audi/Optical Express experience directly: reward
- Roles needing formal IT certs as essential (not desirable): penalise
- Management roles: penalise
- Remote/hybrid: reward
- 65-75 = good transferable fit, worth applying
- 80+ = strong match, prioritise

HARD REJECT (score 0, hardReject true) if ANY of:
- Outbound sales or cold calling
- Commission-only or heavily commission-based
- Door-to-door or field sales
- Shift/evening/weekend patterns required
- Salary under £24,000
- Manual/physical labour
- More than 10 miles from Stoke AND not remote
- Salary above £80,000 (bad data)
- Trainee/graduate scheme run by a recruitment agency (not a real employer)`;

// ── Fetch ─────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
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
  'customer success',
  'customer success manager',
  'service desk',
  'IT support',
  'helpdesk',
  'technical support',
  'IT coordinator',
  'support analyst',
  'client onboarding',
  'product support',
  'account coordinator',
  'technical trainer',
  'customer experience',
  'implementation coordinator',
  'operations coordinator'
];

// ── Adzuna — searches both Stoke and Remote ───────────────────
async function scrapeAdzuna() {
  const jobs = [];
  const locations = [
    { where: 'Stoke-on-Trent', distance: 10 },
    { where: 'Remote', distance: 30 }
  ];

  for (const loc of locations) {
    for (const q of SEARCHES) {
      try {
        const params = new URLSearchParams({
          app_id: process.env.ADZUNA_APP_ID,
          app_key: process.env.ADZUNA_APP_KEY,
          results_per_page: 20,
          what: q,
          where: loc.where,
          distance: loc.distance,
          salary_min: 24000,
          full_time: 1,
          permanent: 1
        });
        const data = await fetchUrl(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`);
        const parsed = JSON.parse(data);
        for (const job of (parsed.results || [])) {
          const salMax = job.salary_max || job.salary_min || 0;
          if (salMax > 80000) continue;
          const company = (job.company?.display_name || '').toLowerCase();
          if (BLOCKED_COMPANIES.some(b => company.includes(b))) continue;
          jobs.push({
            id: `adzuna-${job.id}`,
            dedupKey: `${company.trim()}|${job.title.toLowerCase().trim()}`,
            title: job.title,
            company: job.company?.display_name || 'Unknown',
            salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(salMax).toLocaleString()}` : 'Not specified',
            location: job.location?.display_name || 'Unknown',
            description: (job.description || ''),
            url: job.redirect_url,
            source: 'Adzuna'
          });
        }
        await sleep(800);
      } catch(e) { console.error(`Adzuna error (${q} / ${loc.where}):`, e.message); }
    }
  }
  return jobs;
}

// ── Indeed RSS — Stoke + Remote ───────────────────────────────
async function scrapeIndeed() {
  const jobs = [];
  const locations = ['Stoke-on-Trent', 'Remote'];

  for (const loc of locations) {
    for (const q of SEARCHES) {
      try {
        const encoded = q.replace(/ /g, '+');
        const xml = await fetchUrl(`https://uk.indeed.com/rss?q=${encoded}&l=${loc}&radius=10&fromage=7`);
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        for (const item of items) {
          const get = tag => {
            const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([^\\]]+)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]+)<\/${tag}>`));
            return m ? (m[1] || m[2] || '').trim() : '';
          };
          const link = get('link') || '';
          if (!link) continue;
          const title = get('title');
          const company = get('source');
          if (BLOCKED_COMPANIES.some(b => company.toLowerCase().includes(b))) continue;
          jobs.push({
            id: `indeed-${Buffer.from(link).toString('base64').slice(0, 20)}`,
            dedupKey: `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`,
            title, company,
            salary: 'See listing',
            location: loc === 'Remote' ? 'Remote' : 'Stoke-on-Trent area',
            description: get('description').replace(/<[^>]+>/g, ''),
            url: link,
            source: 'Indeed'
          });
        }
        await sleep(1200);
      } catch(e) { console.error(`Indeed RSS error (${q} / ${loc}):`, e.message); }
    }
  }
  return jobs;
}

// ── Dedup ─────────────────────────────────────────────────────
function deduplicate(jobs) {
  const seenIds = new Set();
  const seenKeys = new Set();
  const result = [];
  for (const job of jobs) {
    if (seenIds.has(job.id) || seenKeys.has(job.dedupKey)) continue;
    seenIds.add(job.id);
    seenKeys.add(job.dedupKey);
    result.push(job);
  }
  return result;
}

// ── Claude scoring ────────────────────────────────────────────
async function scoreJob(job) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{
          role: 'user',
          content: `Score this job for Luke. Return ONLY valid JSON: {"score":0-100,"verdict":"max 20 words referencing Luke's specific experience","hardReject":true/false}

CV: ${CV}
PREFS: ${PREFS}

JOB TITLE: ${job.title}
COMPANY: ${job.company}
SALARY: ${job.salary}
LOCATION: ${job.location}
DESCRIPTION: ${job.description.slice(0, 1500)}`
        }]
      })
    });
    const data = await res.json();
    const text = (data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch(e) {
    return { score: 0, verdict: 'Error scoring', hardReject: false };
  }
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.ALERT_EMAIL }] }],
      from: { email: process.env.FROM_EMAIL || process.env.ALERT_EMAIL, name: 'JobRadar' },
      subject,
      content: [{ type: 'text/html', value: html }]
    })
  });
  if (!res.ok) console.error('SendGrid error:', await res.text());
}

async function sendDigest(jobs) {
  if (!jobs.length) return;
  const rows = jobs.map(j => `
    <tr><td style="padding:14px;border-bottom:1px solid #eee;">
      <strong style="font-size:15px;">${j.title}</strong> — ${j.company}<br>
      <span style="color:#2a7ae2;">💰 ${j.salary}</span> &nbsp;|&nbsp; 📍 ${j.location}<br>
      <span style="color:#555;font-size:13px;font-style:italic;">${j.verdict}</span><br><br>
      <span style="background:${j.score >= 80 ? '#22c55e' : '#f59e0b'};color:white;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:bold;">${j.score}/100</span>
      &nbsp;&nbsp;<a href="${j.url}" style="color:#2a7ae2;font-weight:bold;">Apply →</a>
      &nbsp;<span style="color:#999;font-size:11px;">[${j.source}]</span>
    </td></tr>`).join('');

  await sendEmail(
    `🎯 JobRadar: ${jobs.length} new match${jobs.length > 1 ? 'es' : ''} — ${new Date().toLocaleDateString('en-GB')}`,
    `<div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
      <h2 style="color:#111;">🎯 JobRadar — ${jobs.length} new match${jobs.length > 1 ? 'es' : ''} today</h2>
      <p style="color:#555;font-size:13px;">Scored 60+ · Stoke-on-Trent +10mi + Remote · £24k+</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#aaa;font-size:11px;margin-top:20px;">JobRadar v5</p>
    </div>`
  );
  console.log(`Email sent: ${jobs.length} jobs`);
}

async function sendErrorAlert(msg) {
  try {
    await sendEmail('⚠️ JobRadar scan failed', `<div style="font-family:sans-serif;"><h3>Scan error</h3><p>${msg}</p><p>${new Date().toISOString()}</p></div>`);
  } catch(e) { console.error('Error alert failed:', e.message); }
}

// ── Main scan ──────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  let all = [], errors = [];

  try { all = all.concat(await scrapeAdzuna()); } catch(e) { errors.push(`Adzuna: ${e.message}`); }
  try { all = all.concat(await scrapeIndeed()); } catch(e) { errors.push(`Indeed: ${e.message}`); }

  if (all.length === 0 && errors.length > 0) {
    await sendErrorAlert(errors.join('<br>'));
    return;
  }

  const unique = deduplicate(all);
  const fresh = unique.filter(j => !seenJobs.has(j.id));
  console.log(`${all.length} found → ${unique.length} unique → ${fresh.length} new`);
  if (!fresh.length) { console.log('No new jobs'); return; }

  const scored = [];
  for (const job of fresh) {
    const result = await scoreJob(job);
    seenJobs.add(job.id);
    console.log(`  ${job.title} @ ${job.company} | ${result.score} | ${result.hardReject ? 'REJECT' : 'OK'}`);
    if (!result.hardReject && result.score >= 60) scored.push({ ...job, ...result });
    await sleep(300);
  }

  saveSeen();
  scored.sort((a, b) => b.score - a.score);
  console.log(`${scored.length} jobs scored 60+`);
  await sendDigest(scored);
}

// ── Cron 8am ──────────────────────────────────────────────────
function schedule() {
  const now = new Date(), next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(() => { runScan(); setInterval(runScan, 86400000); }, ms);
  console.log(`Next auto-scan in ${Math.round(ms / 60000)} mins`);
}

// ── Routes ─────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(`<h2>JobRadar v5</h2><p>Seen: ${seenJobs.size} jobs</p><a href="/scan">▶ Manual scan</a> | <a href="/reset">↺ Reset</a> | <a href="/ping">● Ping</a>`));
app.get('/scan', (_, res) => { res.send('Scan started — check inbox in ~5 mins.'); runScan(); });
app.get('/reset', (_, res) => { seenJobs.clear(); saveSeen(); res.send('Reset done.'); });
app.get('/ping', (_, res) => res.send('pong'));

app.listen(process.env.PORT || 3000, () => { console.log('JobRadar v5 running'); schedule(); });
