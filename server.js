// ============================================================
// JOB RADAR - server.js
// ============================================================
// ENV VARS REQUIRED:
//   ANTHROPIC_API_KEY   - Claude API key
//   SENDGRID_API_KEY    - SendGrid API key
//   ALERT_EMAIL         - Where to send job digests
//   FROM_EMAIL          - Verified sender in SendGrid
// ============================================================

const express = require('express');
const https = require('https');
const http = require('http');
const app = express();
app.use(express.json());

// ── Seen jobs store (in-memory + persisted to seen.json) ────
const fs = require('fs');
const SEEN_FILE = './seen.json';
let seenJobs = new Set();

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      seenJobs = new Set(data);
      console.log(`Loaded ${seenJobs.size} seen jobs`);
    }
  } catch (e) { console.error('loadSeen error:', e.message); }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify([...seenJobs]));
  } catch (e) { console.error('saveSeen error:', e.message); }
}

loadSeen();

// ── CV & preferences (used in Claude scoring prompt) ────────
const CV_SUMMARY = `
Name: Luke Grainger
Location: Stoke-on-Trent
Current salary: £26,000

Work history:
- Patient Advisor, Optical Express (2024–present): patient consultations, diagnostic equipment, admin, finance processing, CRM, team coordination
- Connectivity Genius, Audi (2023–2024): technical specialist, customer education on connected car tech, troubleshooting, cross-team collaboration
- Product Genius, Arnold Clark (2019–2023): customer-facing tech explainer, test drives, car imaging/spec management, progressed to level 3 (sales qualified)
- Sales Advisor, Currys (2016–2019): MDA sales, broad product knowledge, care plans, installation services

Key skills: Technical troubleshooting, customer communication, CRM/database management, Microsoft Excel, Audi Connect, presenting complex tech simply, admin and records management

Education: Sports Development & Coaching (Stoke Sixth Form), GCSEs including English, Maths, Science
`;

const JOB_PREFERENCES = `
TARGET ROLES: IT support, 1st/2nd line helpdesk, service desk, technical support, customer success, IT coordinator, field engineer, CRM coordinator, operations coordinator, technical account manager

LOCATION: Stoke-on-Trent and within 10 miles, OR fully remote

MINIMUM SALARY: £26,000

WORKING PATTERN: Weekdays only (no shift work, no evenings/weekends)

HARD REJECTS (score 0 immediately if any apply):
- Outbound sales or cold calling
- Commission-only or heavily commission-based
- Door-to-door or field sales
- Shift patterns covering evenings or weekends
- Salary below £26,000
- Roles requiring degrees or qualifications Luke doesn't have
- Manual/physical labour roles
- Roles more than 10 miles from Stoke-on-Trent (unless remote)
`;

// ── Fetch helper ─────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'identity'
      }
    };
    lib.get(url, options, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Scrapers ─────────────────────────────────────────────────

// Reed.co.uk
async function scrapeReed() {
  const jobs = [];
  const searches = [
    'IT+support+stoke-on-trent',
    'service+desk+stoke-on-trent',
    'technical+support+stoke-on-trent',
    'IT+support+remote',
    'customer+success+stoke-on-trent',
    'IT+coordinator+stoke-on-trent'
  ];

  for (const query of searches) {
    try {
      const url = `https://www.reed.co.uk/jobs/${query}?proximity=10&salarymin=26000`;
      const html = await fetchUrl(url);

      // Reed embeds job data in article tags
      const articleRegex = /<article[^>]*data-job-id="(\d+)"[^>]*>([\s\S]*?)<\/article>/g;
      let match;
      while ((match = articleRegex.exec(html)) !== null) {
        const id = `reed-${match[1]}`;
        const block = match[2];

        const titleMatch = block.match(/class="job-result-heading__title"[^>]*>\s*<a[^>]*>([^<]+)<\/a>/);
        const companyMatch = block.match(/class="job-result-heading__name"[^>]*>([^<]+)<\/a>/);
        const salaryMatch = block.match(/class="job-metadata__item job-metadata__item--salary"[^>]*>([\s\S]*?)<\/li>/);
        const locationMatch = block.match(/class="job-metadata__item job-metadata__item--location"[^>]*>([\s\S]*?)<\/li>/);
        const descMatch = block.match(/class="job-result-description__details"[^>]*>([\s\S]*?)<\/p>/);

        if (titleMatch) {
          jobs.push({
            id,
            title: titleMatch[1].trim(),
            company: companyMatch ? companyMatch[1].trim() : 'Unknown',
            salary: salaryMatch ? salaryMatch[1].replace(/<[^>]+>/g, '').trim() : 'Not specified',
            location: locationMatch ? locationMatch[1].replace(/<[^>]+>/g, '').trim() : 'Not specified',
            description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '',
            url: `https://www.reed.co.uk/jobs/job/${match[1]}`,
            source: 'Reed'
          });
        }
      }
      await sleep(2000);
    } catch (e) {
      console.error(`Reed scrape error for ${query}:`, e.message);
    }
  }
  return jobs;
}

// Totaljobs
async function scrapeTotaljobs() {
  const jobs = [];
  const searches = [
    'it-support/in-stoke-on-trent',
    'service-desk/in-stoke-on-trent',
    'technical-support/in-stoke-on-trent',
    'it-support/in-remote',
    'customer-success/in-stoke-on-trent'
  ];

  for (const query of searches) {
    try {
      const url = `https://www.totaljobs.com/jobs/${query}?radius=10&salary=26000&salarytypeid=1`;
      const html = await fetchUrl(url);

      // Totaljobs uses data-job-id attributes
      const jobRegex = /<article[^>]*class="[^"]*job[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
      let match;
      while ((match = jobRegex.exec(html)) !== null) {
        const block = match[1];
        const idMatch = block.match(/data-job-id="(\d+)"/);
        const titleMatch = block.match(/<h2[^>]*class="[^"]*job-title[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
        const companyMatch = block.match(/class="[^"]*company[^"]*"[^>]*>([^<]+)<\/span>/);
        const salaryMatch = block.match(/class="[^"]*salary[^"]*"[^>]*>([^<]+)<\/li>/);
        const locationMatch = block.match(/class="[^"]*location[^"]*"[^>]*>([^<]+)<\/li>/);
        const linkMatch = block.match(/href="(\/job\/[^"]+)"/);

        if (titleMatch && idMatch) {
          jobs.push({
            id: `totaljobs-${idMatch[1]}`,
            title: titleMatch[1].trim(),
            company: companyMatch ? companyMatch[1].trim() : 'Unknown',
            salary: salaryMatch ? salaryMatch[1].trim() : 'Not specified',
            location: locationMatch ? locationMatch[1].trim() : 'Not specified',
            description: '',
            url: linkMatch ? `https://www.totaljobs.com${linkMatch[1]}` : 'https://www.totaljobs.com',
            source: 'Totaljobs'
          });
        }
      }
      await sleep(2000);
    } catch (e) {
      console.error(`Totaljobs scrape error for ${query}:`, e.message);
    }
  }
  return jobs;
}

// Indeed
async function scrapeIndeed() {
  const jobs = [];
  const searches = [
    { q: 'IT+support', l: 'Stoke-on-Trent' },
    { q: 'service+desk', l: 'Stoke-on-Trent' },
    { q: 'technical+support', l: 'Stoke-on-Trent' },
    { q: 'IT+support', l: 'remote' },
    { q: 'customer+success+tech', l: 'Stoke-on-Trent' }
  ];

  for (const search of searches) {
    try {
      const url = `https://uk.indeed.com/jobs?q=${search.q}&l=${search.l}&radius=10&salaryType=yearly&fromage=7`;
      const html = await fetchUrl(url);

      // Indeed embeds job data as JSON in a script tag
      const jsonMatch = html.match(/window\.mosaic\.providerData\["mosaic-provider-jobcards"\]\s*=\s*(\{[\s\S]*?\});\s*window/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const results = data?.metaData?.mosaicProviderJobCardsModel?.results || [];
          for (const job of results) {
            jobs.push({
              id: `indeed-${job.jobkey}`,
              title: job.normTitle || job.title || 'Unknown',
              company: job.company || 'Unknown',
              salary: job.salarySnippet?.text || 'Not specified',
              location: job.jobLocationCity ? `${job.jobLocationCity}, ${job.jobLocationState || ''}` : 'Not specified',
              description: job.snippet || '',
              url: `https://uk.indeed.com/viewjob?jk=${job.jobkey}`,
              source: 'Indeed'
            });
          }
        } catch (parseErr) {
          console.error('Indeed JSON parse error:', parseErr.message);
        }
      }
      await sleep(3000);
    } catch (e) {
      console.error(`Indeed scrape error:`, e.message);
    }
  }
  return jobs;
}

// ── Claude scoring ───────────────────────────────────────────
async function scoreJob(job) {
  const prompt = `You are a job matching assistant. Score this job listing for Luke Grainger based on his CV and preferences.

CV SUMMARY:
${CV_SUMMARY}

JOB PREFERENCES:
${JOB_PREFERENCES}

JOB LISTING:
Title: ${job.title}
Company: ${job.company}
Salary: ${job.salary}
Location: ${job.location}
Description: ${job.description}
Source: ${job.source}

Return ONLY a JSON object in this exact format (no markdown, no explanation):
{
  "score": <number 0-100>,
  "verdict": "<one sentence explanation>",
  "hardReject": <true or false>
}

Scoring guide:
- If any hard reject condition is met, set hardReject: true and score: 0
- 80-100: Excellent match, Luke should definitely apply
- 60-79: Good match, worth applying
- 40-59: Partial match, some concerns
- 0-39: Poor match
`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  try {
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return { score: 0, verdict: 'Parse error', hardReject: false };
  }
}

// ── SendGrid email ───────────────────────────────────────────
async function sendDigest(scoredJobs) {
  if (scoredJobs.length === 0) return;

  const rows = scoredJobs.map(j => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #eee;">
        <strong style="font-size:15px;">${j.title}</strong><br>
        <span style="color:#555;">${j.company} — ${j.location}</span><br>
        <span style="color:#2a7ae2;">💰 ${j.salary}</span><br>
        <span style="color:#666;font-size:13px;">${j.verdict}</span><br>
        <span style="background:${j.score >= 80 ? '#22c55e' : '#f59e0b'};color:white;padding:2px 8px;border-radius:12px;font-size:12px;">Score: ${j.score}/100</span>
        &nbsp;<a href="${j.url}" style="color:#2a7ae2;font-size:13px;">View & Apply →</a>
        &nbsp;<span style="color:#999;font-size:12px;">[${j.source}]</span>
      </td>
    </tr>
  `).join('');

  const html = `
    <div style="font-family:sans-serif;max-width:640px;margin:0 auto;">
      <h2 style="color:#1a1a1a;">🎯 JobRadar — ${scoredJobs.length} new match${scoredJobs.length > 1 ? 'es' : ''} today</h2>
      <p style="color:#555;">Jobs scoring 65+ from Indeed, Reed & Totaljobs — filtered for your preferences.</p>
      <table style="width:100%;border-collapse:collapse;">${rows}</table>
      <p style="color:#999;font-size:12px;margin-top:20px;">JobRadar | Stoke-on-Trent | £26k+ | Weekdays only</p>
    </div>
  `;

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: process.env.ALERT_EMAIL }] }],
      from: { email: process.env.FROM_EMAIL || process.env.ALERT_EMAIL, name: 'JobRadar' },
      subject: `🎯 JobRadar: ${scoredJobs.length} new job match${scoredJobs.length > 1 ? 'es' : ''} — ${new Date().toLocaleDateString('en-GB')}`,
      content: [{ type: 'text/html', value: html }]
    })
  });

  if (response.ok) {
    console.log(`Email sent: ${scoredJobs.length} jobs`);
  } else {
    const err = await response.text();
    console.error('SendGrid error:', err);
  }
}

// ── Main scan ────────────────────────────────────────────────
async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting job scan...`);

  let allJobs = [];
  try { allJobs = allJobs.concat(await scrapeReed()); } catch (e) { console.error('Reed failed:', e.message); }
  try { allJobs = allJobs.concat(await scrapeTotaljobs()); } catch (e) { console.error('Totaljobs failed:', e.message); }
  try { allJobs = allJobs.concat(await scrapeIndeed()); } catch (e) { console.error('Indeed failed:', e.message); }

  // Deduplicate by ID
  const newJobs = allJobs.filter(j => !seenJobs.has(j.id));
  console.log(`Found ${allJobs.length} total, ${newJobs.length} new`);

  if (newJobs.length === 0) {
    console.log('No new jobs, skipping email');
    return;
  }

  // Score with Claude (batch, with delay to avoid rate limits)
  const scored = [];
  for (const job of newJobs) {
    const result = await scoreJob(job);
    console.log(`  ${job.id} | ${job.title} | Score: ${result.score} | ${result.hardReject ? 'REJECTED' : 'OK'}`);
    seenJobs.add(job.id);

    if (!result.hardReject && result.score >= 65) {
      scored.push({ ...job, ...result });
    }
    await sleep(500);
  }

  saveSeen();

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  console.log(`${scored.length} jobs scored 65+, sending digest...`);
  await sendDigest(scored);
}

// ── Cron: 8am daily ─────────────────────────────────────────
function scheduleDailyScan() {
  function msUntil8am() {
    const now = new Date();
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  }

  setTimeout(function tick() {
    runScan().catch(e => console.error('Scan error:', e));
    setTimeout(tick, 24 * 60 * 60 * 1000);
  }, msUntil8am());

  console.log(`Next scan in ${Math.round(msUntil8am() / 1000 / 60)} minutes`);
}

// ── Express routes ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`
    <h2>JobRadar</h2>
    <p>Status: Running</p>
    <p>Seen jobs: ${seenJobs.size}</p>
    <p><a href="/scan">Trigger manual scan</a></p>
    <p><a href="/reset">Reset seen jobs (re-scan all)</a></p>
  `);
});

app.get('/scan', async (req, res) => {
  res.send('Scan started — check logs and your inbox shortly.');
  runScan().catch(e => console.error('Manual scan error:', e));
});

app.get('/reset', (req, res) => {
  seenJobs.clear();
  saveSeen();
  res.send('Seen jobs cleared. Next scan will process all listings.');
});

app.get('/ping', (req, res) => res.send('pong'));

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`JobRadar running on port ${PORT}`);
  scheduleDailyScan();
});
