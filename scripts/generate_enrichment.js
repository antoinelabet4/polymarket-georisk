/**
 * Génère enrichment.json — exécuté par GitHub Actions toutes les heures
 * Sources : ACLED (si credentials dispo) + Metaculus (scraping pages publiques)
 */
const https = require('https');
const fs = require('fs');

const ACLED_EMAIL = process.env.ACLED_EMAIL || '';
const ACLED_ACCESS_KEY = process.env.ACLED_ACCESS_KEY || '';

// ── HTTP helpers ────────────────────────────────────────
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'GeoRisk-GHAction/1.0', ...headers },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return get(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function getJSON(url, headers) {
  const body = await get(url, headers);
  return JSON.parse(body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── ACLED ───────────────────────────────────────────────
const ACLED_REMAP = {
  'Democratic Republic of Congo': 'Dem. Rep. Congo',
  'Central African Republic': 'Central African Rep.',
  'Bosnia-Herzegovina': 'Bosnia and Herz.',
  'United States': 'United States of America',
  'Ivory Coast': "Côte d'Ivoire",
};

async function fetchACLED() {
  if (!ACLED_EMAIL || !ACLED_ACCESS_KEY) {
    console.log('[ACLED] No credentials — skipping');
    return {};
  }
  try {
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const url = `https://api.acleddata.com/acled/read?key=${ACLED_ACCESS_KEY}&email=${encodeURIComponent(ACLED_EMAIL)}&event_date=${since}|&event_date_where=>&fields=country|event_type|fatalities&limit=10000&terms=accept`;
    console.log('[ACLED] Fetching events since', since);

    const data = await getJSON(url);
    const events = data.data || [];
    if (!events.length) {
      console.log('[ACLED] No events returned');
      return {};
    }

    const counts = {};
    for (const ev of events) {
      let c = ev.country || '';
      c = ACLED_REMAP[c] || c;
      const etype = ev.event_type || '';
      const fat = parseInt(ev.fatalities) || 0;
      let w = 1;
      if (etype.includes('Battles')) w = 3;
      else if (etype.includes('Explosions') || etype.includes('Remote violence')) w = 2.5;
      else if (etype.includes('Violence against civilians')) w = 2;
      else if (etype.includes('Riots') || etype.includes('Protests')) w = 0.5;
      w += Math.min(fat * 0.1, 5);
      counts[c] = (counts[c] || 0) + w;
    }

    const max = Math.max(...Object.values(counts), 1);
    const scores = {};
    for (const [c, raw] of Object.entries(counts)) {
      scores[c] = Math.round(Math.min(100, (raw / max) * 95));
    }
    console.log(`[ACLED] ${Object.keys(scores).length} countries scored from ${events.length} events`);
    return scores;
  } catch (e) {
    console.error('[ACLED] Error:', e.message);
    return {};
  }
}

// ── Metaculus ───────────────────────────────────────────
const METACULUS_QS = [
  { id: 41138, country: 'Ukraine', sev: 'peace' },
  { id: 8636, country: 'Russia', sev: 'catastrophic' },
  { id: 4441, country: 'China', sev: 'catastrophic' },
  { id: 30363, country: 'Taiwan', sev: 'major_war' },
  { id: 11514, country: 'Iran', sev: 'regime' },
  { id: 20569, country: 'Palestine', sev: 'peace' },
  { id: 6284, country: 'Sudan', sev: 'conflict' },
  { id: 7449, country: 'North Korea', sev: 'regime' },
];

const SEV_COEFF = {
  catastrophic: 240, major_war: 50, sea_lane: 30, conflict: 27,
  regime: 35, sovereign: 34, peace: 27, election: 12, geo: 8,
};

async function fetchMetaculus() {
  console.log('[Metaculus] Scraping public pages...');
  const results = [];
  for (const q of METACULUS_QS) {
    try {
      const html = await get(`https://www.metaculus.com/questions/${q.id}/`);
      const m = html.match(/(\d+(?:\.\d+)?)\s*%\s*chance/);
      if (m) {
        const prob = parseFloat(m[1]) / 100;
        const tm = html.match(/<title>([^<]+)<\/title>/);
        const title = tm ? tm[1].replace(/\s*\|.*/, '').trim() : `Metaculus #${q.id}`;
        results.push({ source: 'metaculus', id: q.id, country: q.country, prob, severity: q.sev, title });
        console.log(`  #${q.id}: ${(prob * 100).toFixed(0)}% → ${q.country} (${q.sev})`);
      } else {
        console.log(`  #${q.id}: no probability found`);
      }
    } catch (e) {
      console.log(`  #${q.id}: failed (${e.message})`);
    }
    await sleep(800);
  }
  return results;
}

// ── Blend ───────────────────────────────────────────────
function blend(acled, metaculus) {
  const countries = {};

  for (const [c, score] of Object.entries(acled)) {
    countries[c] = countries[c] || { acled: 0, mc: 0, markets: [] };
    countries[c].acled = score;
  }

  for (const m of metaculus) {
    const c = m.country;
    countries[c] = countries[c] || { acled: 0, mc: 0, markets: [] };
    const coeff = SEV_COEFF[m.severity] || 8;
    const contrib = m.severity === 'peace' ? (1 - m.prob) * coeff : m.prob * coeff;
    countries[c].mc += contrib;
    countries[c].markets.push({
      title: m.title, prob: m.prob, contrib: Math.round(contrib * 10) / 10,
      severity: m.severity, source: 'metaculus',
    });
  }

  const result = {};
  for (const [c, d] of Object.entries(countries)) {
    const a = d.acled, m = Math.min(100, d.mc);
    let score = a > 0 && m > 0 ? 0.6 * a + 0.4 * m : a > 0 ? a : m;
    result[c] = {
      score: Math.round(Math.min(100, Math.max(0, score))),
      acled_score: a,
      metaculus_score: Math.round(m),
      metaculus_markets: d.markets.sort((a, b) => b.contrib - a.contrib).slice(0, 5),
      sources: [...(a > 0 ? ['ACLED'] : []), ...(m > 0 ? ['Metaculus'] : [])],
    };
  }
  return result;
}

// ── Main ────────────────────────────────────────────────
async function main() {
  console.log('=== Generating enrichment.json ===');
  const [acled, metaculus] = await Promise.all([fetchACLED(), fetchMetaculus()]);
  const countries = blend(acled, metaculus);

  const output = {
    timestamp: new Date().toISOString(),
    sources: {
      acled: { configured: !!ACLED_EMAIL, countries: Object.keys(acled).length },
      metaculus: { configured: false, questions: metaculus.length },
    },
    countries,
  };

  fs.writeFileSync('enrichment.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ enrichment.json written: ${Object.keys(countries).length} countries`);
}

main().catch(e => { console.error(e); process.exit(1); });
