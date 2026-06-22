/**
 * Enrichment Data Generator — GitHub Actions (horaire)
 * Sources:
 *   1. Manifold Markets (API publique, pas d'auth) — marchés de prédiction play-money
 *   2. ACLED (OAuth, si credentials dispo) — événements de conflit terrain
 *   3. GPI 2026 baseline intégré dans le frontend (pas ici)
 */
const https = require('https');
const fs = require('fs');

const ACLED_EMAIL = process.env.ACLED_EMAIL || '';
const ACLED_PASSWORD = process.env.ACLED_PASSWORD || '';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'GeoRisk/1.0', ...headers },
      timeout: 15000,
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location, headers).then(resolve).catch(reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'GeoRisk/1.0', 'Content-Length': Buffer.byteLength(body), ...headers },
      timeout: 15000,
    }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ── Severity classification (same as frontend) ─────────
const SEV = {
  catastrophic: 240, major_war: 50, sea_lane: 30, conflict: 27,
  regime: 35, sovereign: 34, peace: 27, election: 12, geo: 8,
};

function classify(q) {
  const l = q.toLowerCase();
  if (/nato|otan|nuclear\s+weapon|world\s+war|great.power.war/.test(l)) return { coeff: 240, inv: false, level: 'catastrophic' };
  if (/\binvade\b|\binvasion\b/.test(l)) return { coeff: 50, inv: false, level: 'major_war' };
  if (/hormuz|suez|bab.el|strait.*normal|unrestricted/.test(l)) return { coeff: 30, inv: true, level: 'sea_lane' };
  if (/blockade/.test(l)) return { coeff: 30, inv: false, level: 'sea_lane' };
  if (/offensive|military.clash|\bstrike\b|\bbomb|\bmissile|escalat/.test(l)) return { coeff: 27, inv: false, level: 'conflict' };
  if (/regime.fall|\bcoup\b|overthrow/.test(l)) return { coeff: 35, inv: false, level: 'regime' };
  if (/default|debt.restructur/.test(l)) return { coeff: 34, inv: false, level: 'sovereign' };
  if (/sanction/.test(l)) return { coeff: 12, inv: false, level: 'sanctions' };
  if (/peace.deal|ceasefire|agreement|withdraw|surrender|denucleariz/.test(l)) return { coeff: 27, inv: true, level: 'peace' };
  if (/\bwar\b/.test(l)) return { coeff: 27, inv: false, level: 'conflict' };
  if (/election|vote|legislat/.test(l)) return { coeff: 12, inv: false, level: 'election' };
  return { coeff: 8, inv: false, level: 'geo' };
}

// ── Country matching ────────────────────────────────────
const COUNTRY_RE = [
  ['Iran', /\biran(?:ian)?\b|\bhormuz\b/i],
  ['Israel', /\bisrael(?:i)?\b|\bnetanyahu\b/i],
  ['Palestine', /\bpalestin|\bgaza\b|\bhamas\b/i],
  ['Ukraine', /\bukrain|\bkyiv\b|\bzelensky\b/i],
  ['Russia', /\brussia(?:n)?\b|\bputin\b|\bkremlin\b/i],
  ['China', /\bchina\b|\bchinese\b|\bbeijing\b/i],
  ['Taiwan', /\btaiwan/i],
  ['North Korea', /\bnorth.korea\b|\bkim.jong\b|\bdprk\b/i],
  ['South Korea', /\bsouth.korea\b|\bseoul\b/i],
  ['India', /\bindia(?:n)?\b|\bmodi\b|\bkashmir\b/i],
  ['Pakistan', /\bpakistan/i],
  ['Syria', /\bsyria/i],
  ['Yemen', /\byemen|\bhouthi\b/i],
  ['Lebanon', /\blebanon|\bhezbollah\b/i],
  ['Venezuela', /\bvenezuela|\bmaduro\b/i],
  ['Cuba', /\bcuba(?:n)?\b/i],
  ['Sudan', /\bsudan(?:ese)?\b/i],
  ['Ethiopia', /\bethiopia/i],
  ['Eritrea', /\beritrea/i],
  ['Myanmar', /\bmyanmar\b|\bburma/i],
  ['Turkey', /\bturk(?:ey|ish)\b|\berdogan\b/i],
  ['United States', /\bunited.states\b|\bu\.?s\.?\b|\bamerica(?:n)?\b|\btrump\b/i],
  ['France', /\bfrance\b|\bmacron\b/i],
  ['United Kingdom', /\bunited.kingdom\b|\bbritain\b/i],
  ['Japan', /\bjapan/i],
  ['Estonia', /\bestonia/i],
  ['Greenland', /\bgreenland/i],
  ['Mexico', /\bmexico\b/i],
  ['Nigeria', /\bnigeria/i],
  ['Somalia', /\bsomalia/i],
  ['Libya', /\blibya/i],
  ['Egypt', /\begypt/i],
  ['Saudi Arabia', /\bsaudi/i],
  ['Iraq', /\biraq/i],
  ['Afghanistan', /\bafghan/i],
];

function matchCountries(text) {
  const s = new Set();
  for (const [c, re] of COUNTRY_RE) if (re.test(text)) s.add(c);
  return [...s];
}

// ══════════════════════════════════════════════════════════
// MANIFOLD MARKETS (free, no auth)
// ══════════════════════════════════════════════════════════
const MANIFOLD_SEARCHES = [
  'war invasion conflict military',
  'ceasefire peace deal agreement',
  'coup regime overthrow',
  'nuclear weapon detonated',
  'China invade Taiwan',
  'India Pakistan Kashmir',
  'Iran Israel strike',
  'Ukraine Russia ceasefire',
  'North Korea missile',
  'sanctions embargo',
  'Sudan Ethiopia Eritrea Congo',
  'Venezuela Cuba regime',
  'drone attack military escalation',
];

async function fetchManifold() {
  console.log('[Manifold] Récupération marchés géopolitiques...');
  const seen = new Set();
  const results = [];

  for (const term of MANIFOLD_SEARCHES) {
    try {
      const url = `https://api.manifold.markets/v0/search-markets?term=${encodeURIComponent(term)}&sort=liquidity&limit=20&filter=open`;
      const body = await httpsGet(url);
      const markets = JSON.parse(body);

      for (const m of markets) {
        if (m.isResolved || seen.has(m.id)) continue;
        seen.add(m.id);
        const prob = m.probability;
        if (prob == null || prob < 0.02 || prob > 0.97) continue; // skip resolved/extreme/near-certain
        const q = m.question;
        if (/^(?:if|conditional|given|assuming)\b/i.test(q)) continue; // skip conditional markets
        const countries = matchCountries(q);
        if (!countries.length) continue;
        const sev = classify(q);
        const contrib = sev.inv ? (1 - prob) * sev.coeff : prob * sev.coeff;
        results.push({
          source: 'manifold', id: m.id, question: q,
          prob, contrib: Math.round(contrib * 10) / 10,
          severity: sev.level, countries, slug: m.slug,
        });
      }
    } catch (e) {
      console.log(`  ✗ Search "${term}": ${e.message}`);
    }
    await sleep(300); // rate limiting
  }

  console.log(`[Manifold] ✓ ${results.length} marchés géopolitiques extraits (${seen.size} uniques scannés)`);

  // Log top markets
  const top = results.sort((a, b) => b.contrib - a.contrib).slice(0, 10);
  for (const m of top) {
    console.log(`  +${m.contrib.toFixed(0)}pts [${m.severity}] ${(m.prob*100).toFixed(0)}% ${m.countries.join(',')} — ${m.question.slice(0, 55)}`);
  }

  return results;
}

// ══════════════════════════════════════════════════════════
// ACLED (OAuth, si credentials dispo)
// ══════════════════════════════════════════════════════════
const ACLED_REMAP = {
  'Democratic Republic of Congo': 'Dem. Rep. Congo',
  'Central African Republic': 'Central African Rep.',
  'United States': 'United States of America',
};

async function fetchACLED() {
  if (!ACLED_EMAIL || !ACLED_PASSWORD) {
    console.log('[ACLED] ○ Pas de credentials — skipped');
    return {};
  }
  try {
    console.log('[ACLED] Authentification OAuth...');
    const authBody = `username=${encodeURIComponent(ACLED_EMAIL)}&password=${encodeURIComponent(ACLED_PASSWORD)}&grant_type=password&client_id=acled&scope=authenticated`;
    const authResp = await httpsPost('https://acleddata.com/oauth/token', authBody);
    const authData = JSON.parse(authResp);
    if (authData.error) { console.log(`[ACLED] ✗ Auth: ${authData.error_description || authData.error}`); return {}; }
    const token = authData.access_token;
    if (!token) { console.log('[ACLED] ✗ Pas de token'); return {}; }
    console.log('[ACLED] ✓ Token obtenu');

    const since = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const resp = await httpsGet(
      `https://acleddata.com/api/acled/read?event_date=${since}|&event_date_where=>&fields=country|event_type|fatalities&limit=10000`,
      { 'Authorization': `Bearer ${token}` }
    );
    const data = JSON.parse(resp);
    if (data.message === 'Access denied') {
      console.log('[ACLED] ✗ Access denied — contact access@acleddata.com');
      return {};
    }
    const events = data.data || data.results || [];
    if (!events.length) { console.log('[ACLED] ✗ 0 événements'); return {}; }

    const counts = {};
    for (const ev of events) {
      let c = ACLED_REMAP[ev.country] || ev.country || '';
      const w = ev.event_type?.includes('Battles') ? 3 : ev.event_type?.includes('Explosion') ? 2.5 : ev.event_type?.includes('Violence against') ? 2 : ev.event_type?.includes('Riot') ? 0.5 : 1;
      counts[c] = (counts[c] || 0) + w + Math.min((parseInt(ev.fatalities) || 0) * 0.1, 5);
    }
    const max = Math.max(...Object.values(counts), 1);
    const scores = {};
    for (const [c, raw] of Object.entries(counts)) scores[c] = Math.round(Math.min(100, (raw / max) * 95));
    console.log(`[ACLED] ✓ ${Object.keys(scores).length} pays, ${events.length} événements`);
    return scores;
  } catch (e) { console.log(`[ACLED] ✗ ${e.message}`); return {}; }
}

// ══════════════════════════════════════════════════════════
// BLEND
// ══════════════════════════════════════════════════════════
function blend(acledScores, manifoldMarkets) {
  const countries = {};

  // ACLED: structural conflict score
  for (const [c, score] of Object.entries(acledScores)) {
    countries[c] = countries[c] || { acled: 0, manifold_contrib: 0, markets: [] };
    countries[c].acled = score;
  }

  // Manifold: forward-looking — top 5 with diminishing returns per country
  const DECAY = [1.0, 0.7, 0.5, 0.3, 0.15];
  const countryManifold = {};
  for (const m of manifoldMarkets) {
    for (const c of m.countries) {
      countryManifold[c] = countryManifold[c] || [];
      countryManifold[c].push(m);
    }
  }
  for (const [c, mkts] of Object.entries(countryManifold)) {
    countries[c] = countries[c] || { acled: 0, manifold_contrib: 0, markets: [] };
    const sorted = mkts.sort((a, b) => b.contrib - a.contrib);
    const top5 = sorted.slice(0, 5);
    countries[c].manifold_contrib = top5.reduce((s, m, i) => s + m.contrib * (DECAY[i] || 0.1), 0);
    countries[c].markets = top5.map(m => ({
      title: m.question, prob: m.prob, contrib: m.contrib,
      severity: m.severity, source: 'manifold',
    }));
  }

  // Compute final scores
  const result = {};
  for (const [c, d] of Object.entries(countries)) {
    const a = d.acled;
    const m = Math.min(100, d.manifold_contrib);
    let score;
    if (a > 0 && m > 0) score = 0.5 * a + 0.5 * m;
    else if (a > 0) score = a;
    else score = m;

    result[c] = {
      score: Math.round(Math.min(100, Math.max(0, score))),
      acled_score: a,
      manifold_score: Math.round(m),
      manifold_markets: d.markets.sort((a, b) => b.contrib - a.contrib).slice(0, 5),
      sources: [...(a > 0 ? ['ACLED'] : []), ...(d.markets.length > 0 ? ['Manifold'] : [])],
    };
  }
  return result;
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════
async function main() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║  GeoRisk Enrichment Generator              ║');
  console.log('║  Manifold Markets + ACLED                  ║');
  console.log('╚════════════════════════════════════════════╝');
  console.log(`  ACLED:    ${ACLED_EMAIL ? '✓' : '○ non configuré'}`);
  console.log(`  Manifold: ✓ API publique (pas d'auth)`);
  console.log('');

  const [acled, manifold] = await Promise.all([fetchACLED(), fetchManifold()]);
  const countries = blend(acled, manifold);

  const output = {
    timestamp: new Date().toISOString(),
    sources: {
      acled: { configured: !!ACLED_EMAIL, countries: Object.keys(acled).length },
      manifold: { configured: true, markets: manifold.length },
    },
    countries,
  };

  fs.writeFileSync('enrichment.json', JSON.stringify(output, null, 2));
  console.log(`\n✓ enrichment.json: ${Object.keys(countries).length} pays enrichis`);
  console.log(`  Sources: Manifold (${manifold.length} marchés)${Object.keys(acled).length ? ` + ACLED (${Object.keys(acled).length} pays)` : ''}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
