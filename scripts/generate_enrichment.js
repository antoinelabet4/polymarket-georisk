/**
 * Génère enrichment.json — GitHub Actions (toutes les heures)
 * Sources : ACLED (OAuth) + Metaculus (API token optionnel)
 */
const https = require('https');
const fs = require('fs');

const ACLED_EMAIL = process.env.ACLED_EMAIL || '';
const ACLED_PASSWORD = process.env.ACLED_PASSWORD || '';
const METACULUS_TOKEN = process.env.METACULUS_TOKEN || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helpers ────────────────────────────────────────
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const opts = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: { 'User-Agent': 'GeoRisk/1.0', ...options.headers },
      timeout: 20000,
    };
    const req = https.request(opts, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsRequest(res.headers.location, options).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ── ACLED (OAuth) ───────────────────────────────────────
const ACLED_REMAP = {
  'Democratic Republic of Congo': 'Dem. Rep. Congo',
  'Central African Republic': 'Central African Rep.',
  'Bosnia-Herzegovina': 'Bosnia and Herz.',
  'United States': 'United States of America',
  'Ivory Coast': "Côte d'Ivoire",
};

async function fetchACLED() {
  if (!ACLED_EMAIL || !ACLED_PASSWORD) {
    console.log('[ACLED] ✗ Credentials manquantes (ACLED_EMAIL + ACLED_PASSWORD)');
    return {};
  }

  try {
    // Step 1: OAuth token
    console.log('[ACLED] Authentification OAuth...');
    const authBody = `username=${encodeURIComponent(ACLED_EMAIL)}&password=${encodeURIComponent(ACLED_PASSWORD)}&grant_type=password&client_id=acled`;
    const authResp = await httpsRequest('https://acleddata.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: authBody,
    });

    const authData = JSON.parse(authResp.body);
    if (authData.error) {
      console.log(`[ACLED] ✗ Auth échouée: ${authData.error} — ${authData.error_description || ''}`);
      return {};
    }
    const token = authData.access_token;
    if (!token) {
      console.log('[ACLED] ✗ Pas de token dans la réponse:', authResp.body.slice(0, 200));
      return {};
    }
    console.log('[ACLED] ✓ Token obtenu');

    // Step 2: fetch events (last 90 days)
    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const url = `https://acleddata.com/api/acled/read?event_date=${since}|&event_date_where=>&fields=country|event_type|fatalities&limit=10000`;
    console.log(`[ACLED] Récupération événements depuis ${since}...`);

    const dataResp = await httpsRequest(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    let data;
    try { data = JSON.parse(dataResp.body); }
    catch { console.log('[ACLED] ✗ Réponse non-JSON:', dataResp.body.slice(0, 200)); return {}; }

    const events = data.data || data.results || [];
    if (!events.length) {
      console.log('[ACLED] ✗ 0 événements. Réponse:', dataResp.body.slice(0, 300));
      return {};
    }

    // Step 3: score by country
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
    console.log(`[ACLED] ✓ ${Object.keys(scores).length} pays scorés à partir de ${events.length} événements`);
    return scores;

  } catch (e) {
    console.log(`[ACLED] ✗ Erreur: ${e.message}`);
    return {};
  }
}

// ── Metaculus (API token requis) ─────────────────────────
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
  if (!METACULUS_TOKEN) {
    console.log('[Metaculus] ○ Pas de token API (METACULUS_TOKEN). Scraping impossible (Cloudflare). Skipped.');
    return [];
  }

  console.log('[Metaculus] Appel API avec token...');
  const results = [];
  for (const q of METACULUS_QS) {
    try {
      const resp = await httpsRequest(`https://www.metaculus.com/api/questions/${q.id}/`, {
        headers: { 'Authorization': `Token ${METACULUS_TOKEN}` },
      });
      const data = JSON.parse(resp.body);
      const prob = data.community_prediction?.full?.q2 ?? data.community_prediction?.q2;
      if (prob != null) {
        results.push({
          source: 'metaculus', id: q.id, country: q.country,
          prob, severity: q.sev, title: data.title || `Metaculus #${q.id}`,
        });
        console.log(`  ✓ #${q.id}: ${(prob * 100).toFixed(0)}% → ${q.country}`);
      } else {
        console.log(`  ✗ #${q.id}: pas de prédiction`);
      }
    } catch (e) {
      console.log(`  ✗ #${q.id}: ${e.message}`);
    }
    await sleep(500);
  }
  console.log(`[Metaculus] ${results.length} questions récupérées`);
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
      acled_score: a, metaculus_score: Math.round(m),
      metaculus_markets: d.markets.sort((a, b) => b.contrib - a.contrib).slice(0, 5),
      sources: [...(a > 0 ? ['ACLED'] : []), ...(m > 0 ? ['Metaculus'] : [])],
    };
  }
  return result;
}

// ── Main ────────────────────────────────────────────────
async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  Enrichment Data Generator            ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`  ACLED:    ${ACLED_EMAIL ? '✓ credentials' : '✗ pas de credentials'}`);
  console.log(`  Metaculus: ${METACULUS_TOKEN ? '✓ API token' : '○ pas de token'}`);
  console.log('');

  const [acled, metaculus] = await Promise.all([fetchACLED(), fetchMetaculus()]);
  const countries = blend(acled, metaculus);

  const output = {
    timestamp: new Date().toISOString(),
    sources: {
      acled: { configured: !!ACLED_EMAIL, countries: Object.keys(acled).length },
      metaculus: { configured: !!METACULUS_TOKEN, questions: metaculus.length },
    },
    countries,
  };

  fs.writeFileSync('enrichment.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ enrichment.json: ${Object.keys(countries).length} pays`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
