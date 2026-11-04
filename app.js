'use strict';
/* Tourenplaner – statische PWA. OCR: tesseract.js, Geocoding: Nominatim, Routing: OSRM */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage voll?', e); } }
};

const DEFAULT_SETTINGS = {
  drivers: [],          // [{name, address, lat, lon}] – nur lokal gespeichert, nie im Code
  defaultDriver: null,
  coordLinks: false
};
const KNOWN_CATS = ['WF (DE)', 'AGCO Bl_DE', 'Creditplus', 'DLL Blue', 'Cosmo', 'PF Service', 'Open AG'];

let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('tp_settings', {}));
if (!Array.isArray(settings.drivers)) settings.drivers = [];
const saveSettingsLS = () => LS.set('tp_settings', settings);

// Einmaliger Einrichtungslink: #setup=<base64url(JSON)>  → in localStorage speichern, dann aus der Adresszeile entfernen
let setupApplied = false;
(function applySetupFromHash() {
  const m = location.hash.match(/[#&]setup=([A-Za-z0-9_\-]+=*)/);
  if (!m) return;
  try {
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    const json = new TextDecoder().decode(Uint8Array.from(atob(b), c => c.charCodeAt(0)));
    const cfg = JSON.parse(json);
    const drivers = (cfg.drivers || []).filter(d => d && d.name).map(d => ({
      name: String(d.name), address: String(d.address || ''),
      lat: d.lat != null && d.lat !== '' ? +d.lat : null, lon: d.lon != null && d.lon !== '' ? +d.lon : null }));
    if (drivers.length) {
      settings.drivers = drivers;
      settings.defaultDriver = drivers.some(d => d.name === cfg.default) ? cfg.default : drivers[0].name;
      saveSettingsLS();
      const st = LS.get('tp_state', {}); st.driver = settings.defaultDriver; st.result = null; LS.set('tp_state', st);
      setupApplied = true;
    }
  } catch (e) { console.warn('Setup-Link ungültig', e); }
  history.replaceState(null, '', location.pathname + location.search);
})();

let state = Object.assign({ driver: null, stops: [], firstId: null, result: null, editing: null }, LS.get('tp_state', {}));
state.editing = null;
const getDriver = () => { const ds = settings.drivers.filter(d => d.name && d.address); return ds.find(d => d.name === state.driver) || ds.find(d => d.name === settings.defaultDriver) || ds[0] || null; };
if (getDriver()) state.driver = getDriver().name;
let tours = LS.get('tp_tours', []);
let geoCache = LS.get('tp_geocache', {});
const saveState = () => LS.set('tp_state', { driver: state.driver, stops: state.stops, firstId: state.firstId, result: state.result });

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => t.hidden = true, ms);
}
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------------- OCR ---------------- */
let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('deu', 1, {
      logger: m => {
        if (m.status === 'recognizing text') setOcr(null, m.progress);
        else if (m.status) setOcr(ocrLabel(m.status), m.progress);
      }
    }).then(async w => {
      await w.setParameters({ tessedit_pageseg_mode: '4', preserve_interword_spaces: '1' });
      return w;
    });
    workerPromise.catch(() => workerPromise = null);
  }
  return workerPromise;
}
function ocrLabel(s) {
  if (/load|download/i.test(s)) return 'Lade Texterkennung (einmalig ca. 2 MB) …';
  if (/initiali/i.test(s)) return 'Starte Texterkennung …';
  return s;
}
let ocrPrefix = '';
function setOcr(text, p) {
  $('#ocrStatus').hidden = false;
  if (text != null) $('#ocrText').textContent = ocrPrefix + text;
  if (p != null) $('#ocrBar').style.width = Math.round(p * 100) + '%';
}

// Bild laden, auf gut lesbare Größe skalieren, Graustufen + Kontrast
async function preprocess(file) {
  const img = await loadImage(file);
  const pp = Object.assign({ target: 1800, lo: 60, hi: 235 }, window.TP_PP || {});
  const target = pp.target;
  const scale = Math.max(1, Math.min(3, target / img.width));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h), px = d.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    const g = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    px[i] = g; sum += g;
  }
  const dark = sum / (px.length / 4) < 110; // Screenshot im Dunkelmodus -> invertieren
  for (let i = 0; i < px.length; i += 4) {
    let g = px[i]; if (dark) g = 255 - g;
    g = (g - pp.lo) * 255 / (pp.hi - pp.lo);          // Grau (#777) wird fast schwarz
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    px[i] = px[i + 1] = px[i + 2] = g; px[i + 3] = 255;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file); const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res(im); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Bild konnte nicht geladen werden')); };
    im.src = url;
  });
}

async function handleFiles(files) {
  files = [...files]; if (!files.length) return;
  let added = 0, found = 0;
  try {
    const worker = await getWorker();
    for (let i = 0; i < files.length; i++) {
      ocrPrefix = files.length > 1 ? `Bild ${i + 1}/${files.length}: ` : '';
      setOcr('Bereite Bild vor …', 0);
      const canvas = await preprocess(files[i]);
      setOcr('Lese Text …', 0);
      const { data } = await worker.recognize(canvas);
      const orders = parseOrders(data.text);
      window.__lastOcr = (window.__lastOcr || []).concat([{ file: files[i].name, text: data.text, orders }]);
      found += orders.length;
      added += addStops(orders);
    }
    setOcr(`Fertig: ${found} Aufträge erkannt, ${added} neu.`, 1);
    toast(found ? `${found} Aufträge erkannt (${added} neu)` : 'Keine Aufträge erkannt – bitte Adressen manuell eingeben.');
  } catch (e) {
    console.error(e); setOcr('Fehler bei der Texterkennung: ' + e.message, 0);
    toast('Texterkennung fehlgeschlagen: ' + e.message);
  }
  setTimeout(() => { $('#ocrStatus').hidden = true; }, 2500);
}

/* ---------------- Parser ---------------- */
function lev(a, b) {
  const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function cleanCat(s) {
  s = s.replace(/^[\s|lI1!\[\]\/\\:;,.]+/, '').replace(/[\s|!\[\]\/\\:;,.]+$/, '').replace(/\s+[|lI]$/, '').trim();
  const norm = x => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  let best = null, bd = 1e9;
  for (const k of KNOWN_CATS) { const dd = lev(norm(s), norm(k)); if (dd < bd) { bd = dd; best = k; } }
  if (best && bd <= Math.max(1, Math.round(norm(best).length * 0.3))) return best;
  return s;
}
const HEADER_RE = /^\W{0,4}(\d{6})\b\s*(.*?)\s*(\d{1,2})\s*[.,:]\s*(\d{1,2})\s*[.,:]\s*(20\d{2})\b/;
const ADDR_RE = /^\W{0,4}(?:D\s?E|0\s?E|O\s?E|DF|D)\s*[-–—~=.:]?\s*(\d{5})\s*[,.]?\s*(.+)$/i;
const ADDR_RE2 = /^\W{0,4}(\d{5})\s+([A-Za-zÄÖÜäöüß].+)$/;

function splitOrtStrasse(rest) {
  rest = rest.trim().replace(/\s+/g, ' ');
  let i = rest.indexOf(',');
  if (i < 0) i = rest.indexOf(';');
  if (i >= 0) return { ort: rest.slice(0, i).trim(), strasse: rest.slice(i + 1).trim().replace(/^[,.\s]+/, '') };
  // Ohne Komma: Ort = alles bis zum Wort vor dem Straßen-Teil (heuristisch erstes Wort)
  const m = rest.match(/^(\S+(?:\s+(?:an der|am|im|bei|ob der)\s+\S+)?)\s+(.+)$/i);
  return m ? { ort: m[1], strasse: m[2] } : { ort: rest, strasse: '' };
}
function tidy(s) {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').replace(/[|]+$/g, '').trim();
}

// Zerlegt OCR-Text in Auftragsblöcke
function parseOrders(text) {
  const lines = text.split(/\r?\n/).map(l => l.replace(/[‘’`´]/g, "'").replace(/[¦┃│]/g, '|').trim()).filter(Boolean);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    const h = line.match(HEADER_RE);
    if (h) {
      cur = { h, body: [] }; blocks.push(cur);
    } else if (cur) cur.body.push(line);
  }
  const out = [];
  for (const b of blocks) {
    const [, auftrag, catRaw, dd, mm, yyyy] = b.h;
    const o = {
      auftrag, kategorie: cleanCat(catRaw),
      datum: `${dd.padStart(2, '0')}.${mm.padStart(2, '0')}.${yyyy}`,
      kunde: '', plz: '', ort: '', strasse: '', typ: 'Routine', betrag: ''
    };
    let ai = b.body.findIndex(l => ADDR_RE.test(l));
    let m = ai >= 0 ? b.body[ai].match(ADDR_RE) : null;
    if (ai < 0 || ai > 3) {
      const ai2 = b.body.findIndex((l, i) => i > 0 && i < 4 && ADDR_RE2.test(l));
      if (ai2 >= 0 && (ai < 0 || ai2 < ai)) { ai = ai2; m = b.body[ai2].match(ADDR_RE2); }
    }
    if (ai >= 0 && m) {
      o.plz = m[1];
      const so = splitOrtStrasse(m[2]);
      o.ort = tidy(so.ort); o.strasse = tidy(so.strasse);
      o.kunde = tidy(b.body.slice(0, ai).join(' '));
    } else {
      o.kunde = tidy(b.body[0] || '');
    }
    const rest = b.body.slice(Math.max(ai, 0)).join(' ');
    const t = rest.match(/Termin\s*(\d+)?/i);
    if (t) o.typ = 'Termin' + (t[1] ? ' ' + t[1] : '');
    const e = rest.match(/(\d{1,4}[.,]\d{2})\s*EUR/i);
    if (e) o.betrag = e[1].replace('.', ',') + ' EUR';
    out.push(o);
  }
  // innerhalb eines Bildes doppelte Nummern zusammenfassen
  const seen = new Set();
  return out.filter(o => !seen.has(o.auftrag) && seen.add(o.auftrag));
}

// Manuell eingegebene Adresse: "Darrweg 39, 99734 Nordhausen" oder "DE-99734 Nordhausen, Darrweg 39"
function parseManualLine(line) {
  line = line.trim(); if (!line) return null;
  let m = line.match(ADDR_RE);
  if (m) { const so = splitOrtStrasse(m[2]); return { plz: m[1], ort: tidy(so.ort), strasse: tidy(so.strasse) }; }
  m = line.match(/^(.*?)[,\s]+(\d{5})\s+(.+)$/);
  if (m) return { strasse: tidy(m[1].replace(/,$/, '')), plz: m[2], ort: tidy(m[3]) };
  m = line.match(/^(\d{5})\s+([^,]+),\s*(.+)$/);
  if (m) return { plz: m[1], ort: tidy(m[2]), strasse: tidy(m[3]) };
  const parts = line.split(',');
  if (parts.length >= 2) return { strasse: tidy(parts[0]), plz: '', ort: tidy(parts.slice(1).join(',')) };
  return { strasse: '', plz: '', ort: tidy(line) };
}

function addStops(list) {
  let added = 0;
  for (const o of list) {
    if (o.auftrag) {
      const ex = state.stops.find(s => s.auftrag === o.auftrag);
      if (ex) { for (const k of Object.keys(o)) if (!ex[k] && o[k]) ex[k] = o[k]; continue; }
    }
    state.stops.push(Object.assign({ id: uid(), auftrag: '', kategorie: '', datum: '', kunde: '', plz: '', ort: '', strasse: '', typ: '', betrag: '' }, o, { geo: null, geoErr: null }));
    added++;
  }
  state.result = null; saveState(); render();
  return added;
}

/* ---------------- Geocoding (Nominatim, max 1 Anfrage/s, Cache) ---------------- */
let lastNominatim = 0;
async function nominatim(params) {
  const wait = lastNominatim + 1100 - Date.now(); if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const qs = new URLSearchParams(Object.assign({ format: 'jsonv2', limit: '1', countrycodes: 'de', addressdetails: '1', 'accept-language': 'de' }, params));
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + qs);
  if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
  const j = await r.json();
  return j[0] || null;
}
const expandStreet = s => s.replace(/\bStr\.?(?=\s|$)/g, 'Straße').replace(/([a-zäöü])str\.?(?=\s|$)/gi, '$1straße');
const addrText = a => [a.strasse, [a.plz, a.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');

// Treffer nur akzeptieren, wenn PLZ oder Ort zur Eingabe passen
function matchesArea(hit, a) {
  const ad = hit.address || {}, norm = x => (x || '').toLowerCase().replace(/[^a-zäöüß]/g, '');
  if (a.plz && ad.postcode === a.plz) return true;
  if (a.ort) {
    const o = norm(a.ort), names = [ad.city, ad.town, ad.village, ad.municipality, ad.suburb, ad.hamlet].map(norm).filter(Boolean);
    if (names.some(n => n.includes(o) || o.includes(n)) || norm(hit.display_name).includes(o)) return true;
  }
  return !a.plz && !a.ort;
}
async function geocode(a) {
  const key = addrText(a).toLowerCase().replace(/\s+/g, ' ');
  if (geoCache[key]) return geoCache[key];
  const street = expandStreet(a.strasse || '');
  const tries = [];
  if (street) {
    tries.push({ street, postalcode: a.plz, city: a.ort });
    tries.push({ q: addrText({ strasse: street, plz: a.plz, ort: a.ort }) });
    if (a.plz) tries.push({ street, postalcode: a.plz });
    if (a.ort) tries.push({ street, city: a.ort });
  }
  let hit = null, approx = false;
  for (const p of tries) {
    for (const k of Object.keys(p)) if (!p[k]) delete p[k];
    hit = await nominatim(p);
    if (hit && !matchesArea(hit, a)) hit = null;   // z. B. gleiche Straße in anderer Stadt
    if (hit) break;
  }
  if (!hit && (a.plz || a.ort)) {
    const p = {}; if (a.plz) p.postalcode = a.plz; if (a.ort) p.city = a.ort;
    hit = await nominatim(p);
    if (hit && !matchesArea(hit, a)) hit = null;
    approx = !!hit;
  }
  if (!hit) return null;
  const res = { lat: +hit.lat, lon: +hit.lon, approx, label: hit.display_name };
  geoCache[key] = res; LS.set('tp_geocache', geoCache);
  return res;
}
function parseHome(addr) {
  const p = parseManualLine(addr) || { strasse: '', plz: '', ort: addr };
  return p;
}

/* ---------------- OSRM ---------------- */
const OSRM = 'https://router.project-osrm.org';
async function osrmTable(pts) {
  const coords = pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const r = await fetch(`${OSRM}/table/v1/driving/${coords}?annotations=duration,distance`);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error('OSRM: ' + (j.message || j.code));
  return { dur: j.durations, dist: j.distances };
}
async function osrmRoute(pts) {
  const coords = pts.map(p => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  const r = await fetch(`${OSRM}/route/v1/driving/${coords}?overview=simplified&geometries=geojson&steps=false`);
  const j = await r.json();
  if (j.code !== 'Ok') throw new Error('OSRM: ' + (j.message || j.code));
  const rt = j.routes[0];
  return { legs: rt.legs.map(l => ({ dur: l.duration, dist: l.distance })), geometry: rt.geometry.coordinates.map(([x, y]) => [+y.toFixed(5), +x.toFixed(5)]) };
}

/* ---------------- Optimierung ----------------
   Knoten 0 = Start/Ziel. first = fester erster Stopp (oder -1). Gibt Reihenfolge der Stopp-Indizes zurück. */
function solveTour(D, first) {
  const n = D.length; const all = [...Array(n).keys()].slice(1);
  const start = first > 0 ? first : 0;
  const free = all.filter(i => i !== first);
  const cost = order => { let c = 0, p = 0; for (const i of order) { c += D[p][i]; p = i; } return c + D[p][0]; };
  const prefix = first > 0 ? [first] : [];
  if (free.length === 0) return prefix;
  if (free.length <= 12) {
    // Held-Karp: beginnt bei start, besucht alle freien, endet bei 0
    const k = free.length, F = 1 << k;
    const dp = new Float64Array(F * k).fill(Infinity), par = new Int8Array(F * k).fill(-1);
    for (let j = 0; j < k; j++) dp[(1 << j) * k + j] = D[start][free[j]];
    for (let mask = 1; mask < F; mask++) for (let j = 0; j < k; j++) {
      const v = dp[mask * k + j]; if (!(mask & (1 << j)) || v === Infinity) continue;
      for (let t = 0; t < k; t++) {
        if (mask & (1 << t)) continue;
        const nm = mask | (1 << t), nv = v + D[free[j]][free[t]];
        if (nv < dp[nm * k + t]) { dp[nm * k + t] = nv; par[nm * k + t] = j; }
      }
    }
    let best = Infinity, bj = -1; const full = F - 1;
    for (let j = 0; j < k; j++) { const v = dp[full * k + j] + D[free[j]][0]; if (v < best) { best = v; bj = j; } }
    const seq = []; let mask = full, j = bj;
    while (j >= 0) { seq.push(free[j]); const pj = par[mask * k + j]; mask &= ~(1 << j); j = pj; }
    return prefix.concat(seq.reverse());
  }
  // Nächster Nachbar + 2-opt + Or-opt für große Touren
  let rest = free.slice(), cur = start, seq = [];
  while (rest.length) { rest.sort((a, b) => D[cur][a] - D[cur][b]); cur = rest.shift(); seq.push(cur); }
  let order = prefix.concat(seq), best = cost(order), improved = true, off = prefix.length;
  while (improved) {
    improved = false;
    for (let i = off; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
      const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
      const c = cost(cand); if (c < best - 1e-6) { order = cand; best = c; improved = true; }
    }
    for (let i = off; i < order.length; i++) for (let j = off; j < order.length; j++) {
      if (i === j) continue;
      const cand = order.slice(); const [x] = cand.splice(i, 1); cand.splice(j, 0, x);
      const c = cost(cand); if (c < best - 1e-6) { order = cand; best = c; improved = true; }
    }
  }
  return order;
}

/* ---------------- Planen ---------------- */
let planning = false;
async function plan() {
  if (planning) return;
  const stops = state.stops;
  if (!stops.length) return toast('Bitte zuerst Aufträge hinzufügen.');
  planning = true; const btn = $('#planBtn'); btn.disabled = true;
  try {
    const drv = getDriver();
    if (!drv) { openSettings(); throw new Error('Bitte zuerst Fahrer und Startadresse in den Einstellungen eintragen.'); }
    btn.textContent = 'Suche Startadresse …';
    const home = Number.isFinite(drv.lat) && Number.isFinite(drv.lon) && (drv.lat || drv.lon)
      ? { lat: drv.lat, lon: drv.lon, approx: false } : await geocode(parseHome(drv.address));
    if (!home) { openSettings(); throw new Error(`Startadresse „${drv.address}“ nicht gefunden – bitte in den Einstellungen korrigieren oder Koordinaten eintragen.`); }
    let failed = 0;
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      btn.textContent = `Suche Adressen … ${i + 1}/${stops.length}`;
      s.geo = await geocode(s); s.geoErr = s.geo ? null : 'Adresse nicht gefunden';
      if (!s.geo) failed++;
      renderStops();
    }
    saveState();
    if (failed) { state.editing = stops.find(s => !s.geo).id; renderStops(); throw new Error(`${failed} Adresse(n) nicht gefunden – bitte korrigieren und erneut planen.`); }
    btn.textContent = 'Berechne Fahrzeiten …';
    const pts = [home, ...stops.map(s => s.geo)];
    const T = await osrmTable(pts);
    const firstIdx = state.firstId ? stops.findIndex(s => s.id === state.firstId) + 1 : -1;
    const order = solveTour(T.dur, firstIdx);
    const seqPts = [home, ...order.map(i => pts[i]), home];
    let legs, geometry = null;
    try { const r = await osrmRoute(seqPts); legs = r.legs; geometry = r.geometry; }
    catch { legs = []; let p = 0; for (const i of [...order, 0]) { legs.push({ dur: T.dur[p][i], dist: T.dist[p][i] }); p = i; } }
    const ordered = order.map(i => { const s = stops[i - 1]; return { auftrag: s.auftrag, kategorie: s.kategorie, datum: s.datum, kunde: s.kunde, plz: s.plz, ort: s.ort, strasse: s.strasse, typ: s.typ, betrag: s.betrag, geo: s.geo }; });
    const datum = (stops.find(s => s.datum) || {}).datum || new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const result = {
      id: uid(), created: Date.now(), driver: drv.name, driverName: drv.name, datum,
      home: { addr: drv.address, lat: home.lat, lon: home.lon, approx: home.approx },
      stops: ordered, legs, geometry,
      totalDur: legs.reduce((a, l) => a + l.dur, 0), totalDist: legs.reduce((a, l) => a + l.dist, 0)
    };
    state.result = result; saveState();
    tours.unshift(result); tours = tours.slice(0, 20); LS.set('tp_tours', tours);
    renderResult(); renderTours();
    $('#resultSection').scrollIntoView({ behavior: 'smooth' });
    if (home.approx) toast('Hinweis: Startadresse nur ungefähr gefunden (PLZ/Ort).', 5000);
  } catch (e) {
    console.error(e); toast(e.message, 6000);
  } finally {
    planning = false; btn.disabled = false; btn.textContent = 'Tour planen';
  }
}

/* ---------------- Navigationslinks ---------------- */
const fmtMin = s => { const m = Math.round(s / 60); return m < 60 ? `${m} Min.` : `${Math.floor(m / 60)} Std. ${m % 60} Min.`; };
const fmtKm = m => (m / 1000).toLocaleString('de-DE', { maximumFractionDigits: m < 10000 ? 1 : 0 }) + ' km';
function locStr(p) {
  if (settings.coordLinks && p.lat != null) return `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  return p.addr + ', Deutschland';
}
function routePoints(res) {
  const home = { addr: res.home.addr, lat: res.home.lat, lon: res.home.lon };
  return [home, ...res.stops.map(s => ({ addr: addrText(s), lat: s.geo?.lat, lon: s.geo?.lon })), home];
}
function chunk(points, maxWp) {
  // teilt Punkte in Abschnitte mit max. maxWp Zwischenzielen; Abschnitte überlappen am Übergabepunkt
  const m = points.length - 1, per = maxWp + 1, k = Math.ceil(m / per), size = Math.ceil(m / k), parts = [];
  for (let i = 0; i < m; i += size) parts.push(points.slice(i, Math.min(i + size, m) + 1));
  return parts;
}
function googleUrl(pts) {
  const enc = encodeURIComponent;
  let u = `https://www.google.com/maps/dir/?api=1&origin=${enc(locStr(pts[0]))}&destination=${enc(locStr(pts[pts.length - 1]))}`;
  const wp = pts.slice(1, -1);
  if (wp.length) u += '&waypoints=' + wp.map(p => enc(locStr(p))).join('%7C');
  return u + '&travelmode=driving';
}
function appleUrl(pts) {
  const enc = encodeURIComponent;
  let u = `https://maps.apple.com/directions?source=${enc(locStr(pts[0]))}&destination=${enc(locStr(pts[pts.length - 1]))}`;
  for (const p of pts.slice(1, -1)) u += '&waypoint=' + enc(locStr(p));
  return u + '&mode=driving';
}
const googleStop = p => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(locStr(p))}&travelmode=driving`;
const appleStop = p => `https://maps.apple.com/?daddr=${encodeURIComponent(locStr(p))}&dirflg=d`;

/* ---------------- Rendering ---------------- */
function render() { renderDriver(); renderStops(); renderResult(); renderTours(); }
function renderDriver() {
  const drv = getDriver();
  $('#setupCard').hidden = !!drv; $('#driverCard').hidden = !drv;
  $('#driverSeg').innerHTML = settings.drivers.filter(d => d.name && d.address).map(d => `<button data-driver="${esc(d.name)}" class="${drv && d.name === drv.name ? 'on' : ''}">${esc(d.name)}</button>`).join('');
  $('#homeAddr').textContent = drv ? drv.address : '';
}
function renderStops() {
  const ul = $('#stopList'); const st = state.stops;
  $('#stopCount').textContent = st.length ? `(${st.length})` : '';
  $('#clearStops').hidden = !st.length; $('#firstHint').hidden = !st.length;
  if (!st.length) { ul.innerHTML = '<li class="empty">Noch keine Aufträge. Lade Screenshots hoch oder gib Adressen ein.</li>'; return; }
  ul.innerHTML = st.map((s, i) => {
    const first = s.id === state.firstId, ed = state.editing === s.id;
    const tags = [];
    if (first) tags.push('<span class="tag first">1. Ziel</span>');
    if (s.typ && /termin/i.test(s.typ)) tags.push(`<span class="tag termin">${esc(s.typ)}</span>`);
    if (s.geoErr) tags.push(`<span class="tag err">${esc(s.geoErr)}</span>`);
    else if (s.geo?.approx) tags.push('<span class="tag warn">nur PLZ/Ort gefunden</span>');
    else if (s.geo) tags.push('<span class="tag">📍 gefunden</span>');
    const head = s.auftrag ? `${esc(s.auftrag)} <span class="cat">| ${esc(s.kategorie)} | ${esc(s.datum)}</span>` : '<span class="cat">Manuelle Adresse</span>';
    return `<li class="stop${first ? ' first' : ''}" data-id="${s.id}">
      <div class="badge">${first ? '1' : i + 1}</div>
      <div class="h">${head}</div>
      ${s.kunde ? `<div class="k">${esc(s.kunde)}</div>` : ''}
      <div class="a">${esc(addrText(s)) || '<i>keine Adresse</i>'}</div>
      ${tags.length ? `<div class="tags">${tags.join('')}</div>` : ''}
      <div class="tools"><button class="icon" data-act="edit" aria-label="Bearbeiten">✎</button><button class="icon del" data-act="del" aria-label="Löschen">✕</button></div>
      ${ed ? `<div class="edit" data-edit>
        <input class="full" name="kunde" placeholder="Kunde" value="${esc(s.kunde)}">
        <input class="full" name="strasse" placeholder="Straße und Hausnr." value="${esc(s.strasse)}">
        <input name="plz" placeholder="PLZ" inputmode="numeric" value="${esc(s.plz)}">
        <input name="ort" placeholder="Ort" value="${esc(s.ort)}">
        <input name="auftrag" placeholder="Auftrag" value="${esc(s.auftrag)}">
        <input name="kategorie" placeholder="Kategorie" value="${esc(s.kategorie)}">
        <div class="row"><button class="btn small secondary" data-act="cancel">Abbrechen</button><button class="btn small" data-act="save">Übernehmen</button></div>
      </div>` : ''}
    </li>`;
  }).join('');
}
let map = null, mapLayer = null;
function renderResult() {
  const res = state.result, sec = $('#resultSection');
  if (!res) { sec.hidden = true; return; }
  sec.hidden = false;
  $('#resultMeta').textContent = `${res.driverName} · ${res.datum}`;
  $('#totals').innerHTML = `<div><b>${fmtKm(res.totalDist)}</b><span>Strecke</span></div><div><b>${fmtMin(res.totalDur).replace(' Min.', ' m').replace(' Std.', ' h')}</b><span>Fahrzeit</span></div><div><b>${res.stops.length}</b><span>Stopps</span></div>`;
  const pts = routePoints(res);
  const g = chunk(pts, 9), a = chunk(pts, 13);
  let html = '';
  html += `<div class="row">${g.map((p, i) => `<a class="btn gmaps" target="_blank" rel="noopener" href="${esc(googleUrl(p))}">Google Maps${g.length > 1 ? ` ${i + 1}/${g.length}` : ''}</a>`).join('')}</div>`;
  if (g.length > 1) html += `<div class="lbl">Google erlaubt max. 9 Zwischenziele pro Link – Teil 2 startet bei ${esc(g.slice(1).map(p => shortName(p[0], res)).join(', '))}.</div>`;
  html += `<div class="row">${a.map((p, i) => `<a class="btn amaps" target="_blank" rel="noopener" href="${esc(appleUrl(p))}">Apple Karten${a.length > 1 ? ` ${i + 1}/${a.length}` : ''}</a>`).join('')}</div>`;
  html += '<div class="lbl">Apple-Gesamtroute benötigt iOS 18.4 oder neuer. Sonst die Einzel-Links je Stopp verwenden.</div>';
  $('#routeBtns').innerHTML = html;
  const rows = res.stops.map((s, i) => {
    const l = res.legs[i] || { dur: 0, dist: 0 }; const p = pts[i + 1];
    return `<li class="stop"><div class="badge" style="background:var(--blue);color:#fff">${i + 1}</div>
      <div class="leg">↳ ${fmtMin(l.dur)} · ${fmtKm(l.dist)}</div>
      <div class="h">${s.auftrag ? `${esc(s.auftrag)} <span class="cat">| ${esc(s.kategorie)}</span>` : ''}</div>
      ${s.kunde ? `<div class="k">${esc(s.kunde)}</div>` : ''}
      <div class="a">${esc(addrText(s))}</div>
      ${s.typ && /termin/i.test(s.typ) ? `<div class="tags"><span class="tag termin">${esc(s.typ)}</span></div>` : ''}
      <div class="navs"><a class="btn small gmaps" target="_blank" rel="noopener" href="${esc(googleStop(p))}">Google</a><a class="btn small amaps" target="_blank" rel="noopener" href="${esc(appleStop(p))}">Apple Karten</a></div>
    </li>`;
  });
  const lb = res.legs[res.stops.length] || { dur: 0, dist: 0 };
  rows.push(`<li class="stop"><div class="badge" style="background:var(--green);color:#000">⌂</div><div class="leg">↳ ${fmtMin(lb.dur)} · ${fmtKm(lb.dist)}</div><div class="k">Zurück nach Hause</div><div class="a">${esc(res.home.addr)}</div>
    <div class="navs"><a class="btn small gmaps" target="_blank" rel="noopener" href="${esc(googleStop(pts[0]))}">Google</a><a class="btn small amaps" target="_blank" rel="noopener" href="${esc(appleStop(pts[0]))}">Apple Karten</a></div></li>`);
  $('#routeList').innerHTML = rows.join('');
  renderMap(res);
}
function shortName(p, res) {
  const s = res.stops.find(x => addrText(x) === p.addr); if (!s) return p.addr; const k = s.kunde.length > 22 ? s.kunde.slice(0, 21) + '…' : s.kunde; return s.ort + (k ? ` (${k})` : '');
}
function renderMap(res) {
  if (typeof L === 'undefined') { $('#map').hidden = true; return; }
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  const ll = [[res.home.lat, res.home.lon], ...res.stops.map(s => [s.geo.lat, s.geo.lon])];
  if (res.geometry) L.polyline(res.geometry, { color: '#0a84ff', weight: 4, opacity: .9 }).addTo(mapLayer);
  else L.polyline([...ll, ll[0]], { color: '#0a84ff', weight: 3, dashArray: '6 6' }).addTo(mapLayer);
  L.marker(ll[0], { icon: L.divIcon({ className: 'num-marker home', html: '⌂' }) }).addTo(mapLayer);
  res.stops.forEach((s, i) => L.marker(ll[i + 1], { icon: L.divIcon({ className: 'num-marker', html: String(i + 1) }) }).bindPopup(esc(s.kunde || addrText(s))).addTo(mapLayer));
  setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(ll), { padding: [24, 24] }); }, 50);
}
function renderTours() {
  const ul = $('#tourList');
  if (!tours.length) { ul.innerHTML = '<li class="empty">Noch keine Touren geplant.</li>'; return; }
  ul.innerHTML = tours.map(t => `<li class="tour" data-tid="${t.id}">
    <div><div class="t">${esc(t.driverName)} · ${esc(t.datum)}</div><div class="s">${t.stops.length} Stopps · ${fmtKm(t.totalDist)} · ${fmtMin(t.totalDur)}</div></div>
    <div style="display:flex;gap:6px"><button class="btn small secondary" data-act="open">Öffnen</button><button class="icon del" data-act="deltour" aria-label="Löschen">✕</button></div></li>`).join('');
}

/* ---------------- Einstellungen ---------------- */
function renderDriverFields(keepOpen) {
  if (!settings.drivers.length) settings.drivers = [{ name: '', address: '', lat: null, lon: null }];
  $('#driverFields').innerHTML = settings.drivers.map((d, i) => `<div class="drv" data-i="${i}">
    <div class="drv-head"><b>Fahrer ${i + 1}</b>${settings.drivers.length > 1 ? `<button class="link danger" data-del="${i}">Entfernen</button>` : ''}</div>
    <label class="field">Name<input name="name" value="${esc(d.name)}" placeholder="z. B. Janik"></label>
    <label class="field">Start- und Zieladresse<input name="address" value="${esc(d.address)}" placeholder="Straße Nr., PLZ Ort"></label>
    <label class="field">Koordinaten (optional, genauer)<input name="coords" inputmode="decimal" value="${Number.isFinite(d.lat) && d.lat ? d.lat + ', ' + d.lon : ''}" placeholder="z. B. 51.0504, 13.7373"></label>
    <label class="check"><input type="radio" name="defdrv" value="${i}" ${d.name && d.name === settings.defaultDriver ? 'checked' : ''}> Standard-Fahrer auf diesem Gerät</label>
  </div>`).join('');
  if (keepOpen) $('#settings').open = true;
}
function collectDriverFields() {
  const def = document.querySelector('#driverFields input[name=defdrv]:checked');
  settings.drivers = [...document.querySelectorAll('#driverFields .drv')].map(el => {
    const v = n => el.querySelector(`[name=${n}]`).value.trim();
    const c = v('coords').match(/(-?\d+(?:[.]\d+)?)\s*[,; ]\s*(-?\d+(?:[.]\d+)?)/);
    return { name: v('name'), address: v('address'), lat: c ? +c[1] : null, lon: c ? +c[2] : null };
  });
  if (def && settings.drivers[+def.value]) settings.defaultDriver = settings.drivers[+def.value].name;
}
function openSettings() { renderDriverFields(); const d = $('#settings'); d.open = true; d.scrollIntoView({ behavior: 'smooth' }); }

/* ---------------- Events ---------------- */
function bind() {
  $('#today').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#driverSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.driver = b.dataset.driver; state.result = null; saveState(); renderDriver(); renderResult();
  });
  $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
  $('#toggleManual').addEventListener('click', () => { const b = $('#manualBox'); b.hidden = !b.hidden; if (!b.hidden) $('#manualText').focus(); });
  $('#addManual').addEventListener('click', () => {
    const txt = $('#manualText').value; if (!txt.trim()) return;
    let list = parseOrders(txt);
    if (!list.length) list = txt.split(/\n/).map(parseManualLine).filter(Boolean);
    const n = addStops(list); $('#manualText').value = ''; $('#manualBox').hidden = true;
    toast(`${n} Adresse(n) hinzugefügt`);
  });
  $('#clearStops').addEventListener('click', () => {
    if (!confirm('Alle Aufträge aus der Liste löschen?')) return;
    state.stops = []; state.firstId = null; state.result = null; saveState(); render();
  });
  $('#stopList').addEventListener('click', e => {
    const li = e.target.closest('.stop'); if (!li) return;
    const s = state.stops.find(x => x.id === li.dataset.id); if (!s) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'del') { state.stops = state.stops.filter(x => x !== s); if (state.firstId === s.id) state.firstId = null; state.result = null; }
    else if (act === 'edit') state.editing = state.editing === s.id ? null : s.id;
    else if (act === 'cancel') state.editing = null;
const getDriver = () => { const ds = settings.drivers.filter(d => d.name && d.address); return ds.find(d => d.name === state.driver) || ds.find(d => d.name === settings.defaultDriver) || ds[0] || null; };
if (getDriver()) state.driver = getDriver().name;
    else if (act === 'save') {
      const box = li.querySelector('[data-edit]'); const old = addrText(s);
      box.querySelectorAll('input').forEach(i => s[i.name] = i.value.trim());
      if (addrText(s) !== old) { s.geo = null; s.geoErr = null; }
      state.editing = null;
const getDriver = () => { const ds = settings.drivers.filter(d => d.name && d.address); return ds.find(d => d.name === state.driver) || ds.find(d => d.name === settings.defaultDriver) || ds[0] || null; };
if (getDriver()) state.driver = getDriver().name; state.result = null;
    } else if (e.target.closest('[data-edit]')) return;
    else { state.firstId = state.firstId === s.id ? null : s.id; state.result = null; }
    saveState(); renderStops(); renderResult();
  });
  $('#planBtn').addEventListener('click', plan);
  $('#tourList').addEventListener('click', e => {
    const li = e.target.closest('.tour'); if (!li) return;
    const act = e.target.closest('[data-act]')?.dataset.act; const t = tours.find(x => x.id === li.dataset.tid);
    if (act === 'deltour') { tours = tours.filter(x => x !== t); LS.set('tp_tours', tours); renderTours(); }
    else if (act === 'open' && t) { state.result = t; saveState(); renderResult(); $('#resultSection').scrollIntoView({ behavior: 'smooth' }); }
  });
  $('#coordLinks').checked = !!settings.coordLinks;
  renderDriverFields();
  $('#addDriver').addEventListener('click', () => { collectDriverFields(); settings.drivers.push({ name: '', address: '', lat: null, lon: null }); renderDriverFields(true); });
  $('#driverFields').addEventListener('click', e => {
    const b = e.target.closest('[data-del]'); if (!b) return;
    collectDriverFields(); settings.drivers.splice(+b.dataset.del, 1); renderDriverFields(true);
  });
  $('#openSetup').addEventListener('click', () => openSettings());
  $('#saveSettings').addEventListener('click', () => {
    collectDriverFields();
    const bad = settings.drivers.find(d => !d.address);
    settings.drivers = settings.drivers.filter(d => d.name);
    if (bad && bad.name) return toast(`Bitte Startadresse für ${bad.name} eintragen.`);
    if (!settings.drivers.length) return toast('Bitte mindestens einen Fahrer eintragen.');
    if (!settings.drivers.some(d => d.name === settings.defaultDriver)) settings.defaultDriver = settings.drivers[0].name;
    settings.coordLinks = $('#coordLinks').checked;
    saveSettingsLS(); if (!getDriver() || !settings.drivers.some(d => d.name === state.driver)) state.driver = getDriver().name;
    state.result = null; saveState(); renderDriverFields(); renderDriver(); renderResult(); toast('Gespeichert');
  });
  $('#clearCache').addEventListener('click', () => { geoCache = {}; LS.set('tp_geocache', {}); state.stops.forEach(s => { s.geo = null; s.geoErr = null; }); saveState(); renderStops(); toast('Adress-Cache geleert'); });
}

bind(); render();
if (setupApplied) toast('Einrichtung übernommen: ' + settings.drivers.map(d => d.name).join(', '), 4000);
else if (!getDriver()) openSettings();
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
// für Tests
window.TP = { parseOrders, solveTour, chunk, googleUrl, appleUrl, state: () => state, handleFiles, plan };
window.addEventListener('hashchange', () => { if (/[#&]setup=/.test(location.hash)) location.reload(); });
