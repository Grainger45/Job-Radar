// JobRadar - server.js
// ENV VARS: ADZUNA_APP_ID, ADZUNA_APP_KEY, ANTHROPIC_API_KEY, SENDGRID_API_KEY, ALERT_EMAIL, FROM_EMAIL

const express = require('express');
const https = require('https');
const fs = require('fs');
const app = express();

const SEEN_FILE = './seen.json';
let seenJobs = new Set();
try { if (fs.existsSync(SEEN_FILE)) seenJobs = new Set(JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'))); } catch(e) {}
const saveSeen = () => fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenJobs]));

const CV = `Luke Grainger, Stoke-on-Trent. Current salary £26k.
Experience: Patient Advisor (Optical Express, 2024-present) - diagnostics, CRM, finance processing, admin.
Connectivity Genius (Audi, 2023-2024) - tech specialist, troubleshooting, customer education.
Product Genius (Arnold Clark, 2019-2023) - test drives, car imaging, progressed to sales level 3.
Sales Advisor (Currys, 2016-2019) - MDA sales, broad product knowledge.
Skills: Technical troubleshooting, CRM/databases, Excel, presenting tech simply, admin.`;

const PREFS = `Target: IT support, 1st/2nd line helpdesk, service desk, technical support, customer success, IT coordinator, field engineer, CRM coordinator.
Location: Stoke-on-Trent within 10 miles OR fully remote. Min salary: £26,000. Weekdays only.
HARD REJECT if: outbound/cold calling sales, commission-only, door-to-door, shift/evening/weekend work, under £26k, manual labour, 10+ miles from Stoke (unless remote).`;

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json', ...options.headers },
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

// Adzuna API
async function scrapeAdzuna() {
  const jobs = [];
  const searches = ['IT support', 'service desk', 'technical support', 'customer success', 'IT coordinator', 'helpdesk analyst'];
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
          title: job.title,
          company: job.company?.display_name || 'Unknown',
          salary: job.salary_min ? `£${Math.round(job.salary_min).toLocaleString()} - £${Math.round(job.salary_max || job.salary_min).toLocaleString()}` : 'Not specified',
          location: job.location?.display_name || 'Unknown',
          description: (job.description || '').slice(0, 400),
          url: job.redirect_url,
          source: 'Adzuna'
        });
      }
      await sleep(1000);
    } catch(e) { console.error(`Adzuna error (${q}):`, e.message); }
  }
  return jobs;
}

// Indeed RSS
async function scrapeIndeed() {
  const jobs = [];
  const searches = ['IT+support', 'service+desk', 'technical+support', 'helpdesk'];
  for (const q of searches) {
    try {
      const xml = await fetchUrl(`https://uk.indeed.com/rss?q=${q}&l=Stoke-on-Trent&radius=10&fromage=7`);
      const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];
      for (const item of items) {
        const get = tag => { const m = item.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([^\\]]+)\\]\\]><\/${tag}>|<${tag}[^>]*>([^<]+)<\/${tag}>`)); return m ? (m[1]||m[2]||'').trim() : ''; };
        const link = get('link') || '';
        if (!link) continue;
        jobs.push({
          id: `indeed-${Buffer.from(link).toString('base64').slice(0, 20)}`,
          title: get('title'), company: get('source'),
          salary: 'See listing', location: 'Stoke-on-Trent area',
          description: get('description').replace(/<[^>]+>/g, '').slice(0, 300),
          url: link, source: 'Indeed'
        });
      }
      await sleep(1500);
    } catch(e) { console.error(`Indeed RSS error (${q}):`, e.message); }
  }
  return jobs;
}

// Claude scoring
async function scoreJob(job) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 150,
        messages: [{ role: 'user', content: `Score this job for Luke. Return ONLY valid JSON: {"score":0-100,"verdict":"one sentence","hardReject":true/false}\n\nCV: ${CV}\nPREFS: ${PREFS}\n\nJOB: ${job.title} | ${job.company} | ${job.salary} | ${job.location}\nDESC: ${job.description}` }]
      })
    });
    const data = await res.json();
    return JSON.parse((data.content?.[0]?.text || '{}').replace(/```json|```/g, '').trim());
  } catch(e) { return { score: 0, verdict: 'Error scoring', hardReject: false }; }
}

// Email digest
async function sendDigest(jobs) {
  if (!jobs.length) return;
  const rows = jobs.map(j => `<tr><td style="padding:12px;border-bottom:1px solid #eee;"><strong>${j.title}</strong> — ${j.company}<br><span style="color:#2a7ae2;">💰 ${j.salary}</span> | 📍 ${j.location}<br><small style="color:#666;">${j.verdict}</small><br><span style="background:${j.score >= 80 ? '#22c55e' : '#f59e0b'};color:white;padding:2px 8px;border-radius:10px;font-size:12px;">${j.score}/100</span> <a href="${j.url}">Apply →</a> <small>[${j.source}]</small></td></tr>`).join('');
  await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}` },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.ALERT_EMAIL }] }],
      from: { email: process.env.FROM_EMAIL || process.env.ALERT_EMAIL, name: 'JobRadar' },
      subject: `🎯 JobRadar: ${jobs.length} new match${jobs.length > 1 ? 'es' : ''} — ${new Date().toLocaleDateString('en-GB')}`,
      content: [{ type: 'text/html', value: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;"><h2>🎯 ${jobs.length} new job match${jobs.length > 1 ? 'es' : ''}</h2><table style="width:100%;border-collapse:collapse;">${rows}</table></div>` }]
    })
  });
  console.log(`Email sent: ${jobs.length} jobs`);
}

// Main scan
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning...`);
  let all = [];
  try { all = all.concat(await scrapeAdzuna()); } catch(e) { console.error('Adzuna failed:', e.message); }
  try { all = all.concat(await scrapeIndeed()); } catch(e) { console.error('Indeed failed:', e.message); }
  const fresh = all.filter(j => !seenJobs.has(j.id));
  console.log(`${all.length} found, ${fresh.length} new`);
  if (!fresh.length) return;
  const scored = [];
  for (const job of fresh) {
    const result = await scoreJob(job);
    seenJobs.add(job.id);
    console.log(`  ${job.title} | ${result.score} | ${result.hardReject ? 'REJECT' : 'OK'}`);
    if (!result.hardReject && result.score >= 65) scored.push({ ...job, ...result });
    await sleep(300);
  }
  saveSeen();
  scored.sort((a, b) => b.score - a.score);
  await sendDigest(scored);
}

// Schedule 8am daily
function schedule() {
  const now = new Date(), next = new Date();
  next.setHours(8, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  setTimeout(() => { runScan(); setInterval(runScan, 86400000); }, ms);
  console.log(`Next scan in ${Math.round(ms / 60000)} mins`);
}

app.get('/', (_, res) => res.send(`<h2>JobRadar</h2><p>Seen: ${seenJobs.size} jobs</p><a href="/scan">Manual scan</a> | <a href="/reset">Reset</a>`));
app.get('/scan', (_, res) => { res.send('Scan started — check inbox in ~3 mins.'); runScan(); });
app.get('/reset', (_, res) => { seenJobs.clear(); saveSeen(); res.send('Reset done.'); });
app.get('/ping', (_, res) => res.send('pong'));

app.listen(process.env.PORT || 3000, () => { console.log('JobRadar running'); schedule(); });
