// JobRadar - server.js v3
// ENV VARS: ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY, SENDGRID_API_KEY, ALERT_EMAIL, FROM_EMAIL

const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

// ── Seen jobs ────────────────────────────────────────────────
const SEEN_FILE = './seen.json';
let seenJobs = new Set();
try { if (fs.existsSync(SEEN_FILE)) seenJobs = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch(e) {}
const saveSeen = () => { try { fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenJobs])); } catch(e) {} };

// ── Profile ──────────────────────────────────────────────────
const CV = `Luke Grainger, Stoke-on-Trent. Current salary £26,000. Career changer moving into tech roles.
Experience:
- Patient Advisor, Optical Express (2024-present): patient consultations, diagnostic equipment, CRM, finance processing, admin, coordinating with clinical teams.
- Connectivity Genius, Audi (2023-2024): technical specialist explaining connected car tech to customers, troubleshooting MyAudi/Audi Connect app issues, onboarding customers onto digital platforms.
- Product Genius, Arnold Clark (2019-2023): customer education, test drives, vehicle imaging/spec management, progressed to level 3 (sales qualified, finance applications).
- Sales Advisor, Currys (2016-2019): inbound sales, broad product knowledge, care plans, installation services.
Skills: Technical troubleshooting, CRM/database management, Excel, explaining complex tech simply, admin, customer onboarding, relationship building.
No formal IT qualifications but strong practical tech aptitude and customer-facing tech experience.`;

const PREFS = `Luke is a career changer looking for tech-adjacent or tech roles where enthusiasm and transferable skills are valued over formal qualifications.

IDEAL ROLES: Customer Success Manager, SaaS Onboarding Specialist, Technical Account Manager, CRM Administrator, Field Service Engineer, Technical Support (1st/2nd line), IT Helpdesk, Connectivity Engineer, Telecoms Engineer, Technical Sales Engineer (pre-sales/demo), Systems Coordinator, Operations Coordinator, IT Coordinator.

LOCATION: Stoke-on-Trent within 10 miles OR fully remote. Min salary £26,000. Weekdays only (no shift/evening/weekend work).

SCORING GUIDANCE:
- Reward roles that mention "training provided", "no experience necessary", "full training", career development, progression
- Reward roles where Luke's customer-facing tech experience (Audi connectivity, Currys, Optical Express) is directly relevant
- Penalise roles requiring formal IT qualifications (ITIL, CompTIA, CCNA, degree) unless they say "desirable" not "essential"
- Penalise management/team lead roles (he has no management experience)
- Penalise roles that are primarily outbound sales, cold calling, commission-based, or door-to-door
- Penalise roles requiring 3+ years specific IT helpdesk experience
- Reward remote or hybrid roles
- A realistic 65-75 score means "good transferable fit but some gaps" — this is fine for Luke to apply to
- An 80+ score means Luke is a strong candidate with minimal gaps

HARD REJECT (score 0) if: outbound/cold calling sales, commission-only, door-to-door, shift/evening/weekend patterns, under £26k, manual/physical labour, 10+ miles from Stoke AND not remote.`;

// ── Fetch ────────────────────────────────────────────────────
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

// ── Adzuna ───────────────────────────────────────────────────
async function scrapeAdzuna() {
  const jobs = [];
  const searches = [
    'customer success', 'technical support', 'service desk',
    'IT support', 'CRM administrator', 'field service engineer',
    'technical account manager', 'SaaS onboarding', 'connectivity engineer',
    'IT coordinator', 'helpdesk', 'telecoms engineer',
    'technical sales engineer', 'systems coordinator'
  ];

  for (const q of searches) {
    try {
      const params = new URLSearchParams({
        app_id: process.env.ADZUNA_APP_ID,
        app_key: process.env.ADZUNA_APP_KEY,
        results_per_page: 20,
        what: q,
        where: 'Stoke-on-Trent',
        distance: 10,
        salary_min: 26000,
        full_time: 1,
        permanent: 1
      });
      const data = await fetchUrl(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`);
      const parsed = JSON.parse(data);
      for (const job of (parsed.results || [])) {
        jobs.push({
          id: `adzuna-${job.id}`,
          dedupKey: `${(job.company?.display_name || '').toLowerCase().trim()}|${job.title.toLowerCase().trim()}`,
          title: job.title,
          company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(job.salary_max || job.salary_min).toLocaleString()}` : 'Not specified',
          location: job.location?.display_name || 'Unknown',
          description: (job.description || ''),
          url: job.redirect_url,
          source: 'Adzuna'
        });
      }
      await sleep(800);
    } catch(e) { console.error(`Adzuna error (${q}):`, e.message); }
  }
  return jobs;
}

// ── Indeed RSS ───────────────────────────────────────────────
async function scrapeIndeed() {
  const jobs = [];
  const searches = [
    'customer+success', 'technical+support', 'service+desk',
    'IT+support', 'CRM+administrator', 'field+service+engineer',
    'technical+account+manager', 'helpdesk', 'IT+coordinator'
  ];

  for (const q of searches) {
    try {
      const xml = await fetchUrl(`https://uk.indeed.com/rss?q=${q}&l=Stoke-on-Trent&radius=10&fromage=7`);
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
        jobs.push({
          id: `indeed-${Buffer.from(link).toString('base64').slice(0, 20)}`,
          dedupKey: `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`,
          title, company,
          salary: 'See listing',
          location: 'Stoke-on-Trent area',
          description: get('description').replace(/<[^>]+>/g, ''),
          url: link,
          source: 'Indeed'
        });
      }
      await sleep(1200);
    } catch(e) { console.error(`Indeed RSS error (${q}):`, e.message); }
  }
  return jobs;
}

// ── Dedup by ID and company+title ────────────────────────────
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

// ── Claude scoring ───────────────────────────────────────────
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
          content: `Score this job for Luke. Return ONLY valid JSON: {"score":0-100,"verdict":"one sentence max 20 words","hardReject":true/false}

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

// ── Email ────────────────────────────────────────────────────
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
      <span style="color:#555;font-size:13px;">${j.verdict}</span><br><br>
      <span style="background:${j.score >= 80 ? '#22c55e' : '#f59e0b'};color:white;padding:3px 10px;border-radius:10px;font-size:12px;font-weight:bold;">${j.score}/100</span>
      &nbsp;&nbsp;<a href="${j.url}" style="color:#2a7ae2;font-weight:bold;">Apply →</a>
      &nbsp;<span style="color:#999;font-size:11px;">[${j.source}]</span>
    </td></tr>`).join('');

  await sendEmail(
    `🎯 JobRadar: ${jobs.length} new match${jobs.length > 1 ? 'es' : ''} — ${new Date().toLocaleDateString('en-GB')}`,
    `<div style="font-family:sans-serif;max-width:620px;margin:0 auto;">
      <h2 style="color:#111;">🎯 JobRadar — ${jobs.length} new match${jobs.length > 1 ? 'es' : ''} today</h2>
      <p style="color:#555;">Scored and filtered for your profile. Threshold: 60+</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#aaa;font-size:11px;margin-top:20px;">JobRadar | Stoke-on-Trent +10mi + Remote | £26k+ | Weekdays</p>
    </div>`
  );
  console.log(`Email sent: ${jobs.length} jobs`);
}

async function sendErrorAlert(message) {
  try {
    await sendEmail(
      '⚠️ JobRadar scan failed',
      `<div style="font-family:sans-serif;"><h3>JobRadar scan error</h3><p>${message}</p><p>${new Date().toISOString()}</p></div>`
    );
  } catch(e) { console.error('Error alert failed:', e.message); }
}

// ── Main scan ─────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  let all = [];
  let errors = [];

  try { all = all.concat(await scrapeAdzuna()); } catch(e) { errors.push(`Adzuna: ${e.message}`); }
  try { all = all.concat(await scrapeIndeed()); } catch(e) { errors.push(`Indeed: ${e.message}`); }

  if (all.length === 0 && errors.length > 0) {
    console.error('All sources failed:', errors);
    await sendErrorAlert(`All sources failed:<br>${errors.join('<br>')}`);
    return;
  }

  // Deduplicate
  const unique = deduplicate(all);
  const fresh = unique.filter(j => !seenJobs.has(j.id));
  console.log(`${all.length} found → ${unique.length} unique → ${fresh.length} new`);

  if (!fresh.length) { console.log('No new jobs'); return; }

  // Score
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

// ── Routes ────────────────────────────────────────────────────
app.get('/', (_, res) => res.send(`
  <h2>JobRadar v3</h2>
  <p>Seen jobs: ${seenJobs.size}</p>
  <p><a href="/scan">▶ Manual scan</a></p>
  <p><a href="/reset">↺ Reset seen jobs</a></p>
  <p><a href="/ping">● Ping</a></p>
`));
app.get('/scan', (_, res) => { res.send('Scan started — check inbox in ~5 mins.'); runScan(); });
app.get('/reset', (_, res) => { seenJobs.clear(); saveSeen(); res.send('Reset done. Next scan processes all listings.'); });
app.get('/ping', (_, res) => res.send('pong'));

app.listen(process.env.PORT || 3000, () => { console.log('JobRadar v3 running'); schedule(); });
