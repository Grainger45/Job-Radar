// JobRadar - server.js v8.3
// ENV VARS: ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, ALERT_EMAIL, SUPABASE_URL, SUPABASE_KEY

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Supabase ──────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function supabase(method, table, body, query = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${table}${query}`);
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'resolution=merge-duplicates' : ''
      }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch(e) { resolve({}); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function isJobSeen(id) {
  try {
    const res = await supabase('GET', 'seen_jobs', null, `?id=eq.${encodeURIComponent(id)}&select=id`);
    return Array.isArray(res) && res.length > 0;
  } catch(e) { return false; }
}

async function markJobSeen(id) {
  try { await supabase('POST', 'seen_jobs', { id }); } catch(e) {}
}

async function saveFeedback(jobId, result) {
  try { await supabase('POST', 'feedback', { job_id: jobId, result }); } catch(e) {}
}

const memSeen = new Set();

// ── Config ────────────────────────────────────────────────────
const BLOCKED_COMPANIES = [
  'itol', 'firebrand', 'just it', 'intequal', 'qa ltd', 'qa limited',
  'estio', 'baltic apprenticeships', 'multiverse', 'corndel', 'qa',
  'newto training', 'it career switch', 'training course'
];

const RECRUITMENT_AGENCIES = [
  'hays', 'reed specialist', 'eligo', 'robert half', 'manpower', 'adecco',
  'randstad', 'michael page', 'page group', 'kelly services', 'search consultancy',
  'network it', 'oscar technology', 'sanderson', 'huntress', 'pareto'
];

const NON_STOKE_CITIES = [
  'london', 'manchester', 'birmingham', 'leeds', 'sheffield', 'liverpool',
  'bristol', 'crawley', 'brighton', 'sussex', 'southampton', 'portsmouth',
  'reading', 'oxford', 'cambridge', 'edinburgh', 'glasgow', 'cardiff',
  'belfast', 'northern ireland', 'seaford', 'gatwick', 'coventry', 'leicester',
  'nottingham', 'derby', 'wolverhampton', 'telford', 'shrewsbury'
];

const RED_FLAGS = [
  'fast paced', 'fast-paced', 'self starter', 'self-starter',
  'hit the ground running', 'no two days the same', 'wear many hats',
  'sink or swim', 'hungry', 'hustler', 'grind'
];

const BAD_TITLES = [
  'mechanic', 'cad technician', 'welder', 'plumber', 'electrician', 'hgv',
  'forklift', 'chef', 'cleaner', 'security guard', 'care assistant',
  'warehouse operative', 'resident services', 'student accommodation',
  'scaffolder', 'painter', 'decorator', 'driver'
];

const BAD_DESC_PHRASES = [
  'outbound calls', 'cold calling', 'door to door', 'commission only', 'zero hours contract'
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

const PREFS = `Luke is looking for roles with good job satisfaction, clear progression, positive culture, and work-life balance. Tech-adjacent roles ideal but any well-regarded role with development opportunities is worth considering.

TARGET ROLES: Customer Success, Service Desk, IT Support, Helpdesk, Technical Support, IT Coordinator, Support Analyst, Client Onboarding, Product Support, Account Coordinator, Technical Trainer, Customer Experience, Implementation Coordinator, Operations Coordinator.

LOCATION: Stoke-on-Trent within 10 miles OR fully remote UK. Min salary £24,000. Weekdays only.

SENIORITY: Luke is entry to mid-level. HEAVILY penalise Manager/Senior/Lead/Head/Director titles if salary above £40k and no training language. These are Speculative at best.

KEYWORD REWARDS: "training provided", "full training", "no experience necessary", "career development", "progression", "study support", "hybrid", "remote", "entry level", "junior", "development programme", "flexible working", "supportive team"

KEYWORD PENALTIES: "outbound", "cold calling", "KPI", "targets", "commission", "ITIL essential", "CCNA essential", "degree essential", "SQL essential", "SQL required", "programming required", "management experience required", "3+ years experience essential", "5+ years", "fast paced", "self starter"

RECRUITER VS DIRECT: Slightly favour direct employer postings over recruitment agency postings.

SENIORITY LABELS:
- "Realistic": entry/junior, Luke is strong candidate
- "Stretch": mid-level, gaps but worth applying
- "Speculative": senior/overlevelled, long shot

SCORING:
- Entry/junior with training: 75-85
- Good culture/progression: reward
- Audi/Optical Express direct match: reward
- Remote/hybrid: reward
- SQL/programming as essential: penalise heavily → Stretch minimum
- Management with no training language: penalise heavily
- Red flag culture phrases: penalise per flag
- Entry-level title but £40k+ salary: flag as potentially misleading

HARD REJECT if: outbound/cold calling, commission-only, door-to-door, shift/evening/weekend, under £24k, manual labour, over £80k salary, trainee scheme run by recruiter, location confirmed as non-Stoke non-remote city.`;

// ── Fetch ─────────────────────────────────────────────────────
function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, text/html, application/rss+xml', ...options.headers },
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

const SEARCHES = [
  'customer success', 'technical support', 'IT support',
  'helpdesk', 'client onboarding', 'operations coordinator',
  'customer experience', 'support analyst'
];

// ── Job helpers ───────────────────────────────────────────────
function isBlocked(company) {
  const co = company.toLowerCase();
  return BLOCKED_COMPANIES.some(b => co.includes(b));
}

function isRecruiter(company) {
  const co = company.toLowerCase();
  return RECRUITMENT_AGENCIES.some(a => co.includes(a));
}

function isRemoteDesc(desc) {
  const d = desc.toLowerCase();
  return d.includes('remote') || d.includes('work from home') || d.includes('wfh') || d.includes('fully remote') || d.includes('home based');
}

function isNonStokeOffice(desc) {
  const d = desc.toLowerCase();
  // Only reject if it explicitly mentions office/onsite in a non-Stoke city
  return NON_STOKE_CITIES.some(city => {
    return (d.includes(`based in ${city}`) || d.includes(`office in ${city}`) ||
            d.includes(`located in ${city}`) || d.includes(`onsite in ${city}`) ||
            d.includes(`on-site in ${city}`) || d.includes(`${city} office`));
  });
}

function getPostedDaysAgo(dateStr) {
  if (!dateStr) return null;
  try { return Math.floor((Date.now() - new Date(dateStr)) / 86400000); } catch(e) { return null; }
}

function countRedFlags(desc) {
  const d = (desc || '').toLowerCase();
  return RED_FLAGS.filter(f => d.includes(f)).length;
}

function isTitleBad(title) {
  const t = title.toLowerCase();
  return BAD_TITLES.some(b => t.includes(b));
}

function isDescBad(desc) {
  const d = (desc || '').toLowerCase();
  return BAD_DESC_PHRASES.some(p => d.includes(p));
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
        if (isBlocked(job.company?.display_name || '')) continue;
        const desc = job.description || '';
        if (isDescBad(desc)) continue;
        const daysAgo = getPostedDaysAgo(job.created);
        if (daysAgo !== null && daysAgo > 21) continue; // skip stale listings
        // Check if it's actually remote or truly local
        const isRemote = isRemoteDesc(desc);
        const isBadLocation = !isRemote && isNonStokeOffice(desc);
        if (isBadLocation) continue;
        jobs.push({
          id: `adzuna-${job.id}`,
          dedupKey: `${(job.company?.display_name||'').toLowerCase().trim()}|${job.title.toLowerCase().trim()}`,
          title: job.title, company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(salMax).toLocaleString()}` : null,
          location: isRemote ? 'Remote (UK)' : (job.location?.display_name || 'Stoke-on-Trent area'),
          description: desc, url: job.redirect_url, source: 'Adzuna',
          isRecruiter: isRecruiter(job.company?.display_name || ''),
          daysAgo, redFlags: countRedFlags(desc)
        });
      }
      await sleep(300);
    } catch(e) { console.error(`Adzuna Stoke (${q}):`, e.message); }

    // Remote UK
    try {
      const params = new URLSearchParams({ app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, results_per_page: 20, what: `${q} remote`, salary_min: 24000, full_time: 1, permanent: 1 });
      const parsed = JSON.parse(await fetchUrl(`https://api.adzuna.com/v1/api/jobs/gb/search/1?${params}`));
      for (const job of (parsed.results || [])) {
        const salMax = job.salary_max || job.salary_min || 0;
        if (salMax > 80000) continue;
        if (isBlocked(job.company?.display_name || '')) continue;
        const desc = job.description || '';
        if (isDescBad(desc)) continue;
        if (!isRemoteDesc(desc)) continue; // must actually say remote
        if (isNonStokeOffice(desc)) continue; // skip if requires office in another city
        const daysAgo = getPostedDaysAgo(job.created);
        if (daysAgo !== null && daysAgo > 21) continue;
        jobs.push({
          id: `adzuna-r-${job.id}`,
          dedupKey: `${(job.company?.display_name||'').toLowerCase().trim()}|${job.title.toLowerCase().trim()}`,
          title: job.title, company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(salMax).toLocaleString()}` : null,
          location: 'Remote (UK)', description: desc, url: job.redirect_url, source: 'Adzuna',
          isRecruiter: isRecruiter(job.company?.display_name || ''),
          daysAgo, redFlags: countRedFlags(desc)
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
    for (const loc of [{ l: 'Stoke-on-Trent', label: 'Stoke-on-Trent area' }, { l: 'Remote', label: 'Remote (UK)' }]) {
      try {
        const xml = await fetchUrl(`https://uk.indeed.com/rss?q=${q.replace(/ /g,'+')}&l=${loc.l}&radius=10&fromage=14`);
        const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
        for (const item of items) {
          const get = tag => { const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([^\\]]+)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m?(m[1]||m[2]||'').trim():''; };
          const link = get('link'); if (!link) continue;
          const title = get('title'), company = get('source');
          const desc = get('description').replace(/<[^>]+>/g,'');
          if (isBlocked(company)) continue;
          if (isDescBad(desc)) continue;
          if (isTitleBad(title)) continue;
          const pubDate = get('pubDate');
          const daysAgo = pubDate ? Math.floor((Date.now() - new Date(pubDate)) / 86400000) : null;
          if (daysAgo !== null && daysAgo > 21) continue;
          // For remote searches, verify description actually mentions remote
          if (loc.l === 'Remote' && !isRemoteDesc(desc)) continue;
          if (isNonStokeOffice(desc)) continue;
          jobs.push({
            id: `indeed-${loc.l}-${Buffer.from(link).toString('base64').slice(0,16)}`,
            dedupKey: `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`,
            title, company, salary: null,
            location: loc.l === 'Remote' ? 'Remote (UK)' : 'Stoke-on-Trent area',
            description: desc, url: link, source: 'Indeed',
            isRecruiter: isRecruiter(company),
            daysAgo, redFlags: countRedFlags(desc)
          });
        }
        await sleep(500);
      } catch(e) { console.error(`Indeed (${q}/${loc.l}):`, e.message); }
    }
  }
  return jobs;
}

// ── Reed RSS ──────────────────────────────────────────────────
async function scrapeReed() {
  const jobs = [];
  const reedSearches = ['it-support', 'helpdesk', 'technical-support', 'customer-success', 'service-desk'];
  for (const q of reedSearches) {
    try {
      const xml = await fetchUrl(`https://www.reed.co.uk/jobs/${q}-jobs-in-stoke-on-trent?proximity=10&salarymin=24000&format=rss`);
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items) {
        const get = tag => { const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([^\\]]+)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m?(m[1]||m[2]||'').trim():''; };
        const link = get('link'); if (!link) continue;
        const title = get('title'), company = get('author') || get('source') || 'Unknown';
        const desc = get('description').replace(/<[^>]+>/g,'');
        if (isBlocked(company)) continue;
        if (isDescBad(desc)) continue;
        if (isTitleBad(title)) continue;
        const pubDate = get('pubDate');
        const daysAgo = pubDate ? Math.floor((Date.now() - new Date(pubDate)) / 86400000) : null;
        if (daysAgo !== null && daysAgo > 21) continue;
        if (isNonStokeOffice(desc)) continue;
        const isRemote = isRemoteDesc(desc);
        jobs.push({
          id: `reed-${Buffer.from(link).toString('base64').slice(0,20)}`,
          dedupKey: `${company.toLowerCase().trim()}|${title.toLowerCase().trim()}`,
          title, company, salary: null,
          location: isRemote ? 'Remote (UK)' : 'Stoke-on-Trent area',
          description: desc, url: link, source: 'Reed',
          isRecruiter: isRecruiter(company),
          daysAgo, redFlags: countRedFlags(desc)
        });
      }
      await sleep(400);
    } catch(e) { console.error(`Reed (${q}):`, e.message); }
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
        messages: [{ role: 'user', content: `Score this job for Luke. Return ONLY valid JSON, no markdown:
{"score":0-100,"verdict":"max 20 words referencing Luke's specific experience","hardReject":true/false,"label":"Realistic|Stretch|Speculative"}

CV: ${CV}
PREFS: ${PREFS}
Red flags detected: ${job.redFlags}
Posted by recruiter: ${job.isRecruiter}

JOB: ${job.title} | ${job.company} | ${job.salary || 'Salary not listed'} | ${job.location}
DESC: ${job.description.slice(0,1500)}` }]
      })
    });
    const data = await res.json();
    return JSON.parse((data.content?.[0]?.text||'{}').replace(/```json|```/g,'').trim());
  } catch(e) { return { score: 0, verdict: 'Error', hardReject: false, label: 'Speculative' }; }
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(subject, html) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'JobRadar <onboarding@resend.dev>',
      to: [process.env.ALERT_EMAIL],
      subject, html
    })
  });
  if (!res.ok) console.error('Resend error:', await res.text());
  else console.log('Email sent via Resend');
}

function labelStyle(label) {
  if (label === 'Realistic') return 'background:#EAF3DE;color:#3B6D11';
  if (label === 'Stretch') return 'background:#FAEEDA;color:#854F0B';
  return 'background:#FCEBEB;color:#A32D2D';
}

function freshnessBadge(daysAgo) {
  if (daysAgo === null) return '';
  if (daysAgo === 0) return '<span style="background:#E6F1FB;color:#185FA5;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">New today</span>';
  if (daysAgo <= 3) return `<span style="background:#E6F1FB;color:#185FA5;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">${daysAgo}d ago</span>`;
  return `<span style="color:#999;font-size:11px;margin-left:6px;">${daysAgo}d ago</span>`;
}

async function sendDigest(jobs) {
  if (!jobs.length) return;
  const baseUrl = 'https://job-radar-xhhi.onrender.com';

  const realistic = jobs.filter(j => j.label === 'Realistic').length;
  const stretch = jobs.filter(j => j.label === 'Stretch').length;
  const speculative = jobs.filter(j => j.label === 'Speculative').length;

  const summary = `<p style="font-size:13px;color:#6b7280;margin:0 0 20px;">
    <span style="color:#3B6D11;font-weight:600;">${realistic} Realistic</span> &nbsp;·&nbsp;
    <span style="color:#854F0B;font-weight:600;">${stretch} Stretch</span> &nbsp;·&nbsp;
    <span style="color:#A32D2D;font-weight:600;">${speculative} Speculative</span>
  </p>`;

  const cards = jobs.map(j => {
    const salaryDisplay = j.salary
      ? `💰 ${j.salary}`
      : `<span style="color:#d97706;">💰 Salary not listed — check listing</span>`;
    const recruiterBadge = j.isRecruiter
      ? '<span style="background:#f3f4f6;color:#6b7280;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">Via recruiter</span>'
      : '<span style="background:#EAF3DE;color:#3B6D11;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;">Direct</span>';
    const redFlagBadge = j.redFlags > 0
      ? `<span style="color:#A32D2D;font-size:11px;margin-left:6px;">⚠ ${j.redFlags} red flag${j.redFlags>1?'s':''}</span>`
      : '';

    return `<tr><td style="padding:0 0 16px;">
      <div style="border:1px solid #e5e7eb;border-radius:12px;padding:16px;font-family:sans-serif;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
          <div style="flex:1;">
            <div style="margin-bottom:6px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;">
              <span style="font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;${labelStyle(j.label)}">${j.label}</span>
              <span style="background:#f3f4f6;color:#6b7280;font-size:11px;padding:3px 8px;border-radius:20px;">${j.location}</span>
              ${freshnessBadge(j.daysAgo)}
              ${recruiterBadge}
              ${redFlagBadge}
            </div>
            <p style="font-size:16px;font-weight:600;margin:0 0 2px;color:#111;">${j.title}</p>
            <p style="font-size:13px;color:#6b7280;margin:0 0 8px;">${j.company}</p>
            <p style="font-size:13px;color:#374151;margin:0 0 10px;line-height:1.5;font-style:italic;">${j.verdict}</p>
            <p style="font-size:14px;font-weight:600;color:#111;margin:0 0 12px;">${salaryDisplay}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;">
              <a href="${j.url}" style="background:#111;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Apply →</a>
              <a href="${baseUrl}/feedback?id=${encodeURIComponent(j.id)}&result=good" style="background:#EAF3DE;color:#3B6D11;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Good match ✓</a>
              <a href="${baseUrl}/feedback?id=${encodeURIComponent(j.id)}&result=bad" style="background:#f3f4f6;color:#6b7280;padding:8px 16px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;">Not relevant ✗</a>
            </div>
          </div>
          <div style="width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;${labelStyle(j.label)}">${j.score}</div>
        </div>
      </div>
    </td></tr>`;
  }).join('');

  const legend = `<tr><td style="padding:16px 0 0;border-top:1px solid #e5e7eb;text-align:center;">
    <span style="font-size:12px;color:#9ca3af;">
      <span style="color:#3B6D11;font-weight:600;">Realistic</span> = strong candidate &nbsp;·&nbsp;
      <span style="color:#854F0B;font-weight:600;">Stretch</span> = apply anyway &nbsp;·&nbsp;
      <span style="color:#A32D2D;font-weight:600;">Speculative</span> = long shot &nbsp;·&nbsp;
      <span style="color:#3B6D11;font-weight:600;">Direct</span> = employer posting
    </span>
  </td></tr>`;

  await sendEmail(
    `🎯 JobRadar: ${jobs.length} new match${jobs.length>1?'es':''} — ${new Date().toLocaleDateString('en-GB')}`,
    `<div style="max-width:620px;margin:0 auto;padding:20px;font-family:sans-serif;">
      <p style="font-size:12px;color:#9ca3af;margin:0 0 4px;">JobRadar · ${new Date().toLocaleDateString('en-GB')} · Stoke +10mi + Remote · £24k+ · max 21 days old</p>
      <h1 style="font-size:22px;font-weight:700;color:#111;margin:0 0 8px;">${jobs.length} new job match${jobs.length>1?'es':''} today</h1>
      ${summary}
      <table style="width:100%;border-collapse:collapse;">${cards}${legend}</table>
      <p style="font-size:11px;color:#d1d5db;text-align:center;margin-top:16px;">JobRadar v8.3</p>
    </div>`
  );
}

// ── Main scan ──────────────────────────────────────────────────
let lastScanTime = null;
let lastScanCount = 0;

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  let all = [], errors = [];
  try { all = all.concat(await scrapeAdzuna()); } catch(e) { errors.push(`Adzuna: ${e.message}`); }
  try { all = all.concat(await scrapeIndeed()); } catch(e) { errors.push(`Indeed: ${e.message}`); }
  try { all = all.concat(await scrapeReed()); } catch(e) { errors.push(`Reed: ${e.message}`); }

  if (!all.length && errors.length) {
    await sendEmail('⚠️ JobRadar scan failed', `<p>${errors.join('<br>')}</p>`);
    return;
  }

  const unique = deduplicate(all);
  const fresh = [];
  for (const job of unique) {
    if (isTitleBad(job.title)) { await markJobSeen(job.id); continue; }
    const seen = await isJobSeen(job.id) || memSeen.has(job.id);
    if (!seen) fresh.push(job);
  }
  console.log(`${all.length} found → ${unique.length} unique → ${fresh.length} new`);
  if (!fresh.length) { lastScanTime = new Date(); lastScanCount = 0; return; }

  fresh.sort((a, b) => (a.daysAgo ?? 99) - (b.daysAgo ?? 99));

  const scored = [];
  for (const job of fresh) {
    const result = await scoreJob(job);
    await markJobSeen(job.id);
    memSeen.add(job.id);
    console.log(`  ${job.title} @ ${job.company} | ${result.score} | ${result.label} | ${result.hardReject?'REJECT':'OK'}`);
    if (!result.hardReject && result.score >= 60) scored.push({ ...job, ...result });
    await sleep(300);
  }

  lastScanTime = new Date();
  lastScanCount = scored.length;
  scored.sort((a, b) => b.score - a.score);
  console.log(`${scored.length} jobs scored 60+`);
  if (scored.length) await sendDigest(scored.slice(0, 15));
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
app.get('/', (_, res) => res.send(`<div style="font-family:sans-serif;max-width:400px;margin:40px auto;padding:20px;"><h2>JobRadar v8.3</h2><p>Last scan: ${lastScanTime?lastScanTime.toLocaleString('en-GB'):'Never'}</p><p>Last matches: ${lastScanCount}</p><p><a href="/scan">▶ Scan</a> &nbsp;|&nbsp; <a href="/reset">↺ Reset</a> &nbsp;|&nbsp; <a href="/status">Status</a></p></div>`));
app.get('/scan', (_, res) => { res.send('Scan started — check inbox in ~3 mins.'); runScan(); });
app.get('/reset', async (_, res) => { memSeen.clear(); try { await supabase('DELETE', 'seen_jobs', null, '?id=neq.null'); } catch(e) {} res.send('Reset done.'); });
app.get('/status', (_, res) => res.json({ version: 'v8.3', lastScan: lastScanTime, lastScanMatches: lastScanCount, memSeenCount: memSeen.size }));
app.get('/feedback', async (req, res) => { const { id, result } = req.query; if (!id || !result) return res.send('Invalid.'); await saveFeedback(id, result); res.send(`Marked as "${result}". You can close this tab.`); });
app.get('/ping', (_, res) => res.send('pong'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`JobRadar v8.3 running on port ${PORT}`); schedule(); });
