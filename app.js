'use strict';
/* Tourenplaner – statische PWA. OCR: tesseract.js, Geocoding: Nominatim, Routing: OSRM */
const VERSION = 'tp-v17';

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
  coordLinks: false,
  startTime: '05:30',   // Standard-Abfahrtszeit
  onsite: 5             // Standard-Minuten vor Ort je Stopp
};
const KNOWN_CATS = ['WF (DE)', 'AGCO Bl_DE', 'Creditplus', 'DLL Blue', 'Cosmo', 'PF Service', 'Open AG'];

let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('tp_settings', {}));
if (!Array.isArray(settings.drivers)) settings.drivers = [];
const saveSettingsLS = () => LS.set('tp_settings', settings);

// Hash-Links: #setup= und #tour= sind base64url(UTF-8-JSON). #tour= darf zusätzlich gzip-komprimiert sein (Magic 1f 8b).
// Nach dem Lesen aus der Adresszeile entfernen. #setup= bleibt unkomprimiertes JSON.
function hashBytes(raw) {
  let b = raw.replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
  return Uint8Array.from(atob(b), c => c.charCodeAt(0));
}
function decodeHashJson(raw) {
  return JSON.parse(new TextDecoder().decode(hashBytes(raw)));
}
const isGzip = b => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
async function gunzipJson(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('gzip nicht verfügbar');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(new TextDecoder().decode(new Uint8Array(await new Response(stream).arrayBuffer())));
}
let setupApplied = false;
let tourHashSeen = false, tourHashBad = false, tourHashPayload, tourHashGzip = null;
(function applySetupFromHash() {
  const setupM = location.hash.match(/[#&]setup=([A-Za-z0-9_\-]+=*)/);
  const tourM = location.hash.match(/[#&]tour=([A-Za-z0-9_\-]+=*)/);
  if (setupM) {
    try {
      const cfg = decodeHashJson(setupM[1]);
      const drivers = (cfg.drivers || []).filter(d => d && d.name).map(d => ({
        name: String(d.name), address: String(d.address || ''),
        lat: d.lat != null && d.lat !== '' ? +d.lat : null, lon: d.lon != null && d.lon !== '' ? +d.lon : null }));
      if (drivers.length) {
        settings.drivers = drivers;
        settings.defaultDriver = drivers.some(d => d.name === cfg.default) ? cfg.default : drivers[0].name;
        if (typeof cfg.googleKey === 'string' && cfg.googleKey.trim()) settings.googleKey = cfg.googleKey.trim();
        saveSettingsLS();
        const st = LS.get('tp_state', {}); st.driver = settings.defaultDriver; st.result = null; LS.set('tp_state', st);
        setupApplied = true;
      }
    } catch (e) { console.warn('Setup-Link ungültig', e); }
  }
  if (tourM) {
    tourHashSeen = true;
    try {
      const bytes = hashBytes(tourM[1]);
      if (isGzip(bytes)) tourHashGzip = bytes;
      else tourHashPayload = JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { tourHashBad = true; console.warn('Tour-Link ungültig', e); }
  }
  if (setupM || tourM) history.replaceState(null, '', location.pathname + location.search);
})();

let state = Object.assign({ driver: null, stops: [], firstId: null, result: null, editing: null }, LS.get('tp_state', {}));
state.editing = null;
const getDriver = () => { const ds = settings.drivers.filter(d => d.name && d.address); return ds.find(d => d.name === state.driver) || ds.find(d => d.name === settings.defaultDriver) || ds[0] || null; };
if (getDriver()) state.driver = getDriver().name;
let tours = LS.get('tp_tours', []);
let geoCache = LS.get('tp_geocache', {});
// Erledigt-Zeiten hängen an Auftrag und Stopp-Id, nicht nur an der gerade offenen Tour.
let doneMemory = LS.get('tp_done', null);
if (!doneMemory || typeof doneMemory !== 'object' || Array.isArray(doneMemory)) doneMemory = { byAuftrag: {}, byId: {} };
if (!doneMemory.byAuftrag || typeof doneMemory.byAuftrag !== 'object' || Array.isArray(doneMemory.byAuftrag)) doneMemory.byAuftrag = {};
if (!doneMemory.byId || typeof doneMemory.byId !== 'object' || Array.isArray(doneMemory.byId)) doneMemory.byId = {};
const saveDoneMemory = () => LS.set('tp_done', doneMemory);
function doneStamp(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = +v;
  return Number.isFinite(n) && n > 0 ? n : null;
}
function rememberDoneStop(s) {
  const ts = doneStamp(s && s.done);
  if (!ts) return false;
  let changed = false;
  const auf = String(s.auftrag || '').trim();
  if (auf) {
    const prev = doneStamp(doneMemory.byAuftrag[auf]);
    if (!prev || ts < prev) { doneMemory.byAuftrag[auf] = ts; changed = true; }
  }
  const id = s.id != null ? String(s.id).trim() : '';
  if (id) {
    const prev = doneStamp(doneMemory.byId[id]);
    if (!prev || ts < prev) { doneMemory.byId[id] = ts; changed = true; }
  }
  return changed;
}
function memoryTime(s) {
  if (!s) return null;
  const times = [];
  const auf = String(s.auftrag || '').trim();
  if (auf) { const t = doneStamp(doneMemory.byAuftrag[auf]); if (t) times.push(t); }
  const id = s.id != null ? String(s.id).trim() : '';
  if (id) { const t = doneStamp(doneMemory.byId[id]); if (t) times.push(t); }
  return times.length ? Math.min.apply(null, times) : null;
}
function applyRememberedDone(stops) {
  if (!Array.isArray(stops)) return false;
  let changed = false;
  for (const s of stops) {
    if (!s) continue;
    if (drafting() && draftUndo.has(draftKey(s))) continue;
    const own = doneStamp(s.done);
    const mem = memoryTime(s);
    if (own && mem && mem < own) { s.done = mem; changed = true; }
    else if (!own && mem) { s.done = mem; changed = true; }
    if (!drafting() && rememberDoneStop(s)) changed = true;
  }
  if (changed && !drafting()) saveDoneMemory();
  return changed;
}
function rememberTourDone(res) {
  if (!res || !Array.isArray(res.stops)) return false;
  let changed = false;
  for (const s of res.stops) if (rememberDoneStop(s)) changed = true;
  if (changed) saveDoneMemory();
  return changed;
}
function seedDoneMemoryFromStored() {
  if (state.result) rememberTourDone(state.result);
  if (Array.isArray(tours)) for (const tour of tours) rememberTourDone(tour);
}
function forgetDoneStop(s) {
  if (!s) return;
  const auf = String(s.auftrag || '').trim();
  if (auf) delete doneMemory.byAuftrag[auf];
  const id = s.id != null ? String(s.id).trim() : '';
  if (id) delete doneMemory.byId[id];
  saveDoneMemory();
}
let draftId = null;
let draftSnapshot = null;
let draftUndo = new Set();
const cloneTour = t => JSON.parse(JSON.stringify(t));
function drafting() { return !!(draftId && state.result && String(state.result.id) === String(draftId)); }
function draftKey(s) {
  if (!s) return '';
  const id = s.id != null ? String(s.id).trim() : '';
  return id || String(s.auftrag || '').trim();
}
const saveState = () => LS.set('tp_state', { driver: state.driver, stops: state.stops, firstId: state.firstId, result: drafting() ? draftSnapshot : state.result });
function datumToInput(d) {
  const m = String(d || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}
function inputToDatum(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

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
  if (drafting()) abandonDraft(); else keepShownTour();
  state.result = null; saveState(); render();
  return added;
}

/* ---------------- Geocoding (Nominatim, max 1 Anfrage/s, Cache) ---------------- */
let lastNominatim = 0;
async function nominatim(params) {
  const wait = lastNominatim + 1100 - Date.now(); if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const qp = Object.assign({ format: 'jsonv2', limit: '1', countrycodes: 'de', addressdetails: '1', 'accept-language': 'de' }, params); delete qp.__all;
  const qs = new URLSearchParams(qp);
  const r = await fetch('https://nominatim.openstreetmap.org/search?' + qs);
  if (!r.ok) throw new Error('Nominatim HTTP ' + r.status);
  const j = await r.json();
  return params.__all ? j : (j[0] || null);
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
async function geocode(a, opt) {
  const key = addrText(a).toLowerCase().replace(/\s+/g, ' ');
  if (!(opt && opt.fresh) && geoCache[key]) return geoCache[key];
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
  const res = { lat: +hit.lat, lon: +hit.lon, approx, label: hit.display_name, state: hit.address?.state || '' };
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
  keepShownTour();
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
    const ordered = order.map(i => { const s = stops[i - 1]; return { id: s.id, auftrag: s.auftrag, kategorie: s.kategorie, datum: s.datum, kunde: s.kunde, plz: s.plz, ort: s.ort, strasse: s.strasse, typ: s.typ, betrag: s.betrag, geo: s.geo }; });
    const datum = (stops.find(s => s.datum) || {}).datum || new Date().toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const result = {
      id: uid(), created: Date.now(), driver: drv.name, driverName: drv.name, datum,
      home: { addr: drv.address, lat: home.lat, lon: home.lon, approx: home.approx },
      stops: ordered.map(o => Object.assign(o, { onsite: null, done: null })), legs, geometry,
      startTime: settings.startTime || '05:30',
      totalDur: legs.reduce((a, l) => a + l.dur, 0), totalDist: legs.reduce((a, l) => a + l.dist, 0)
    };
    applyRememberedDone(result.stops);
    tours.unshift(result); tours = tours.slice(0, 20); LS.set('tp_tours', tours);
    beginDraft(result);
    renderResult(); renderTours();
    fetchHoursForResult(state.result);
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
function finiteNum(v) {
  if (v == null || v === '') return null;
  const n = +v;
  return Number.isFinite(n) ? n : null;
}
function hasPos(p) {
  if (!p) return false;
  const lat = finiteNum(p.lat), lon = finiteNum(p.lon);
  return lat != null && lon != null && !!(lat || lon);
}
// res.dest ist optional. Fehlt es, ist das Ziel gleich dem Start (bisheriges Verhalten).
function hasExplicitDest(res) {
  const d = res && res.dest;
  return !!(d && (String(d.addr || '').trim() || hasPos(d)));
}
function routeStart(res) {
  const h = (res && res.home) || {};
  return { addr: h.addr || '', lat: finiteNum(h.lat), lon: finiteNum(h.lon), approx: !!h.approx };
}
function routeEnd(res) {
  if (hasExplicitDest(res)) {
    const d = res.dest;
    return { addr: d.addr || '', lat: finiteNum(d.lat), lon: finiteNum(d.lon), approx: !!d.approx };
  }
  return routeStart(res);
}
function pointLabel(p) {
  if (!p) return '';
  const addr = String(p.addr || '').trim();
  if (addr) return addr;
  if (hasPos(p)) return finiteNum(p.lat).toFixed(5) + ', ' + finiteNum(p.lon).toFixed(5);
  return '';
}
function routePoints(res) {
  const start = routeStart(res), end = routeEnd(res);
  return [
    { addr: pointLabel(start), lat: start.lat, lon: start.lon },
    ...res.stops.map(s => ({ addr: addrText(s), lat: s.geo?.lat, lon: s.geo?.lon })),
    { addr: pointLabel(end), lat: end.lat, lon: end.lon }
  ];
}
function parseCoordPair(text) {
  const m = String(text || '').trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) return null;
  return { lat, lon };
}
async function locateManual(addr, coordsText) {
  const typedCoords = String(coordsText || '').trim();
  if (typedCoords) {
    const coords = parseCoordPair(typedCoords);
    if (!coords) { const err = new Error('Koordinaten nicht erkannt. Beispiel: 51.0504, 13.7373'); err.user = true; throw err; }
    const label = String(addr || '').trim() || (coords.lat.toFixed(5) + ', ' + coords.lon.toFixed(5));
    return { addr: label, lat: coords.lat, lon: coords.lon, approx: false };
  }
  const text = String(addr || '').trim();
  if (!text) return null;
  const asCoords = parseCoordPair(text);
  if (asCoords) return { addr: text, lat: asCoords.lat, lon: asCoords.lon, approx: false };
  const parsed = parseManualLine(text) || { strasse: '', plz: '', ort: text };
  const geo = await geocode(parsed, { fresh: true });
  if (!geo) return null;
  return { addr: text, lat: geo.lat, lon: geo.lon, approx: !!geo.approx };
}
async function recomputeLegs(res) {
  const pts = routePoints(res);
  if (pts.length < 2 || pts.some(p => !hasPos(p))) return false;
  const raw = pts.map(p => ({ lat: finiteNum(p.lat), lon: finiteNum(p.lon) }));
  let legs, geometry;
  try {
    const r = await osrmRoute(raw);
    legs = r.legs; geometry = r.geometry;
  } catch {
    try {
      const T = await osrmTable(raw);
      legs = [];
      for (let i = 0; i < raw.length - 1; i++) legs.push({ dur: T.dur[i][i + 1] || 0, dist: T.dist[i][i + 1] || 0 });
      geometry = null;
    } catch { return false; }
  }
  res.legs = legs;
  res.geometry = geometry;
  res.totalDur = legs.reduce((a, l) => a + (Number(l.dur) || 0), 0);
  res.totalDist = legs.reduce((a, l) => a + (Number(l.dist) || 0), 0);
  return true;
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
/* ---------------- Händler-Notizen (nur lokal auf diesem Gerät, nie im Netz) ---------------- */
let notes = LS.get('tp_notes', {});   // { key: {id, key, name, strasse, plz, ort, placeId, text, updated, deleted} } – sync-fähig (Zeitstempel + Lösch-Markierung)
const liveNotes = () => Object.values(notes).filter(n => !n.deleted);
const delNote = key => { const n = notes[key]; if (n) { n.deleted = true; n.text = ''; n.updated = Date.now(); } };
let noteEdit = null;                       // 'list|<id>' oder 'route|<i>'
const saveNotes = () => LS.set('tp_notes', notes);
const nName = x => toks(x).filter(t => !WEAK.has(t)).join(' ') || toks(x).join(' ');
const nStreet = x => normAddr(expandStreet(x || '')).replace(/strasse/g, 'str');
function dealerKey(s) { return [nName(s.kunde), nStreet(s.strasse), s.plz || normAddr(s.ort)].join('|'); }
function findNote(s) {
  if (!s) return null;
  const k = dealerKey(s); if (notes[k] && !notes[k].deleted) return notes[k];
  const pid = s.hours?.placeId;
  if (pid) { const n = liveNotes().find(n => n.placeId && n.placeId === pid); if (n) return n; }
  // gleicher Händler trotz kleiner OCR-Abweichungen: gleiche PLZ/Ort + Straße und ähnlicher Name
  const st = nStreet(s.strasse), loc = s.plz || normAddr(s.ort);
  return liveNotes().find(n => (n.plz || normAddr(n.ort)) === loc && st && (nStreet(n.strasse) === st || lev(nStreet(n.strasse), st) <= 1) && nameScore(s.kunde, { name: n.name }, s.ort) >= 0.6)
    || liveNotes().find(n => (n.plz || normAddr(n.ort)) === loc && nName(n.name) && nName(n.name) === nName(s.kunde)) || null;
}
function saveNote(s, text) {
  const ex = findNote(s); const key = ex?.key || dealerKey(s);
  text = (text || '').replace(/\s+$/, '');
  if (!text.trim()) { delNote(key); }
  else notes[key] = { id: notes[key]?.id || ex?.id || uid() + uid(), key, name: s.kunde || ex?.name || '', strasse: s.strasse || ex?.strasse || '', plz: s.plz || ex?.plz || '', ort: s.ort || ex?.ort || '',
    auftrag: s.auftrag || ex?.auftrag || '', placeId: s.hours?.placeId || ex?.placeId || '', text, updated: Date.now() };
  saveNotes(); renderNotesList();
}
function noteHtml(s, id) {
  const n = findNote(s);
  if (noteEdit === id) return `<div class="dnote editing" data-note="${esc(id)}"><textarea data-act="note-text" rows="3" placeholder="z. B. Ansprechpartner, Zufahrt, Schlüsselabgabe …">${esc(n?.text || '')}</textarea>
    <div class="row"><button class="btn small secondary" data-act="note-cancel">Abbrechen</button><button class="btn small" data-act="note-save">Speichern</button></div></div>`;
  if (n) return `<div class="dnote has" data-note="${esc(id)}"><span class="ni">📝</span><div class="ntext">${esc(n.text)}</div><button class="icon" data-act="note-edit" aria-label="Notiz bearbeiten">✎</button></div>`;
  return `<div class="dnote add" data-note="${esc(id)}"><button class="link" data-act="note-edit">📝 Notiz hinzufügen</button></div>`;
}
// Beim Neuzeichnen eine gerade bearbeitete Notiz nicht verlieren
function keepNoteEditing(fn) {
  const ta = document.activeElement?.matches?.('textarea[data-act=note-text]') ? document.activeElement : null;
  const v = ta?.value, a = ta?.selectionStart, b = ta?.selectionEnd;
  fn();
  if (ta && noteEdit) { const n = document.querySelector(`[data-note="${CSS.escape(noteEdit)}"] textarea`); if (n) { n.value = v; n.focus(); try { n.setSelectionRange(a, b); } catch { } } }
}
function stopForNote(el) {
  const box = el.closest('[data-note]'); if (!box) return null;
  const [where, ref] = box.dataset.note.split('|');
  const s = where === 'list' ? state.stops.find(x => x.id === ref) : state.result?.stops[+ref];
  return s ? { s, id: box.dataset.note, box } : null;
}
function handleNoteClick(e) {
  const act = e.target.closest('[data-act]')?.dataset.act; if (!act || !act.startsWith('note-')) return false;
  const t = stopForNote(e.target); if (!t) return true;
  if (act === 'note-edit') { noteEdit = t.id; rerenderNotes(); const ta = document.querySelector(`[data-note="${CSS.escape(t.id)}"] textarea`); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  else if (act === 'note-cancel') { noteEdit = null; rerenderNotes(); }
  else if (act === 'note-save') { const ta = t.box.querySelector('textarea'); if (ta) saveNote(t.s, ta.value); noteEdit = null; rerenderNotes(); toast('Notiz gespeichert'); }
  return true;
}
function handleNoteBlur(e) {
  if (!e.target.matches('textarea[data-act=note-text]')) return;
  if (e.relatedTarget?.dataset?.act === 'note-cancel') return;
  const t = stopForNote(e.target); if (!t) return;
  saveNote(t.s, e.target.value);
  if (e.relatedTarget?.dataset?.act === 'note-save') return;   // Klick-Handler übernimmt
  noteEdit = null; setTimeout(rerenderNotes, 0);
}
function rerenderNotes() { renderStops(); renderResult(); }
function renderNotesList() {
  const ul = $('#notesList'); if (!ul) return;
  const list = liveNotes().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'de'));
  $('#notesCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) { ul.innerHTML = '<li class="empty">Noch keine Notizen. Notizen legst du direkt am Auftrag an.</li>'; return; }
  ul.innerHTML = list.map(n => `<li class="nitem" data-key="${esc(n.key)}">
    <div class="nhead"><b>${esc(n.name || 'Ohne Namen')}</b><span>${noteListEdit === n.key ? '' : `<button class="icon" data-act="nl-edit" aria-label="Bearbeiten">✎</button><button class="icon del" data-act="nl-del" aria-label="Löschen">✕</button>`}</span></div>
    <div class="a">${esc([n.strasse, [n.plz, n.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</div>
    ${noteListEdit === n.key ? `<textarea rows="3">${esc(n.text)}</textarea><div class="row"><button class="btn small secondary" data-act="nl-cancel">Abbrechen</button><button class="btn small" data-act="nl-save">Speichern</button></div>` : `<div class="ntext">${esc(n.text)}</div>`}
  </li>`).join('');
}
let noteListEdit = null;
function exportNotes() {
  const data = { type: 'tourenplaner-notizen', version: 1, exported: new Date().toISOString(), notes: liveNotes() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `tourenplaner-notizen-${new Date().toISOString().slice(0, 10)}.json`; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
async function importNotes(file) {
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data.notes;
    if (!Array.isArray(list)) throw new Error('Keine Notizen in der Datei');
    let added = 0, updated = 0;
    for (const n of list) {
      if (!n || typeof n.text !== 'string' || !n.text.trim()) continue;
      const stop = { kunde: n.name || '', strasse: n.strasse || '', plz: n.plz || '', ort: n.ort || '', hours: n.placeId ? { placeId: n.placeId } : null };
      const ex = findNote(stop); const key = ex?.key || n.key || dealerKey(stop);
      if (ex && (ex.updated || 0) >= (n.updated || 0)) continue;
      notes[key] = { id: notes[key]?.id || n.id || uid() + uid(), key, name: stop.kunde, strasse: stop.strasse, plz: stop.plz, ort: stop.ort, auftrag: n.auftrag || '', placeId: n.placeId || '', text: n.text, updated: n.updated || Date.now() };
      ex ? updated++ : added++;
    }
    saveNotes(); renderNotesList(); rerenderNotes();
    toast(`Import: ${added} neu, ${updated} aktualisiert`);
  } catch (e) { toast('Import fehlgeschlagen: ' + e.message, 5000); }
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
      ${s.kunde || s.strasse ? noteHtml(s, 'list|' + s.id) : ''}
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
let map = null, mapLayer = null, mapFor = null;
const label = s => [s.auftrag, s.kunde].filter(Boolean).join(' · ') || addrText(s);
const hhmm = d => d ? d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '–';
const WD = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function tourDate(res) {
  const m = (res.datum || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  const d = m ? new Date(+m[3], +m[2] - 1, +m[1]) : new Date(); d.setHours(0, 0, 0, 0); return d;
}
const onsiteOf = s => (s.onsite != null && s.onsite !== '' ? +s.onsite : (+settings.onsite || 0));

/* Zeitplan: Start + Fahrzeit + Standzeit; nach „Erledigt“ ab Erledigt-Zeitpunkt neu gerechnet */
function computeSchedule(res) {
  const d = tourDate(res); const [h, m] = (res.startTime || settings.startTime || '05:30').split(':').map(Number);
  let cursor = new Date(d.getTime() + ((h || 0) * 60 + (m || 0)) * 60000);
  const rows = res.stops.map((s, i) => {
    const drive = (res.legs[i]?.dur || 0) * 1000;
    if (s.done) { cursor = new Date(s.done); return { done: true, dep: cursor }; }
    const arr = new Date(cursor.getTime() + drive), dep = new Date(arr.getTime() + onsiteOf(s) * 60000);
    cursor = dep; return { done: false, arr, dep };
  });
  const homeArr = new Date(cursor.getTime() + (res.legs[res.stops.length]?.dur || 0) * 1000);
  const next = rows.findIndex(r => !r.done);
  return { rows, homeArr, next };
}

/* ---------------- Öffnungszeiten (OpenStreetMap / Overpass + opening_hours.js) ---------------- */
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let hoursCache = LS.get('tp_hours', {});
const hoursKey = s => `${s.auftrag || ''}|${s.kunde || ''}|${s.geo ? s.geo.lat.toFixed(4) + ',' + s.geo.lon.toFixed(4) : ''}`;
function cachedHours(s) {
  const c = hoursCache[hoursKey(s)]; if (!c) return null;
  const ttl = (c.source === 'google' ? 7 : c.status === 'found' && c.oh ? 30 : c.status === 'found' ? 7 : 3) * 864e5;
  return Date.now() - c.ts < ttl ? c : null;
}
const scriptP = {};
function loadScript(src) {
  return scriptP[src] || (scriptP[src] = new Promise((res, rej) => {
    const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => { delete scriptP[src]; rej(new Error('Skript nicht ladbar: ' + src)); }; document.head.appendChild(el);
  }));
}
async function loadOH() {
  if (window.opening_hours) return;
  await loadScript('https://cdn.jsdelivr.net/npm/suncalc@1.9.0/suncalc.js');
  await loadScript('https://cdn.jsdelivr.net/npm/opening_hours@3.15.0/build/opening_hours.js');
}
const STATES = ['Baden-Württemberg', 'Bayern', 'Berlin', 'Brandenburg', 'Bremen', 'Hamburg', 'Hessen', 'Mecklenburg-Vorpommern', 'Niedersachsen', 'Nordrhein-Westfalen', 'Rheinland-Pfalz', 'Saarland', 'Sachsen-Anhalt', 'Sachsen', 'Schleswig-Holstein', 'Thüringen'];
function makeOH(str, s) {
  if (!window.opening_hours || !str) return null;
  const st = s.geo?.state || STATES.find(x => (s.geo?.label || '').includes(x)) || '';
  const nom = { lat: s.geo?.lat || 51, lon: s.geo?.lon || 10, address: { country_code: 'de', state: st } };
  try { return new opening_hours(str, nom, { locale: 'de' }); } catch (e) {
    try { return new opening_hours(str, nom); } catch (e2) { return null; }
  }
}
// Namensvergleich: Rechtsformen und Füllwörter ignorieren
const LEGAL = new Set(['gmbh', 'mbh', 'co', 'kg', 'ohg', 'ag', 'ug', 'gbr', 'ek', 'e', 'k', 'inh', 'inhaber', 'und', 'u', 'haftungsbeschraenkt', 'niederlassung', 'filiale', 'der', 'die', 'das', 'am', 'an', 'in']);
const WEAK = new Set(['autohaus', 'auto', 'autos', 'automobile', 'automobil', 'kfz', 'service', 'center', 'centrum', 'zentrum', 'werkstatt', 'handel', 'gruppe', 'technik', 'soehne', 'sohn', 'waren', 'fahrzeuge', 'fahrzeug', 'cars', 'car', 'motors', 'motor', 'partner', 'firma']);
function toks(x) {
  return (x || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/e\.\s?k\./g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length >= 2 && !LEGAL.has(t));
}
function tokEq(a, b) {
  if (a === b) return true;
  if (a.length >= 5 && b.length >= 5 && lev(a, b) <= 1) return true;
  return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a));
}
function nameScore(kunde, tags, ort) {
  const ct = toks(kunde); if (!ct.length) return 0;
  const weakLocal = new Set(toks(ort));   // Ortsname im Firmennamen zählt kaum
  let best = 0;
  for (const k of ['name', 'brand', 'operator', 'official_name', 'alt_name', 'short_name']) {
    if (!tags[k]) continue;
    const nt = toks(tags[k]); let tot = 0, hit = 0, strongHit = 0, strongTot = 0;
    for (const t of ct) {
      const w = WEAK.has(t) || weakLocal.has(t) ? 0.25 : 1; tot += w; if (w === 1) strongTot++;
      if (nt.some(n => tokEq(t, n))) { hit += w; if (w === 1) strongHit++; }
    }
    let sc = tot ? hit / tot : 0;
    if (strongTot && !strongHit) sc = 0;
    // umgekehrt: steckt der kürzere Ortsname vollständig im Kundennamen? (z. B. „Autohaus Schöne Aussicht“)
    const nStrong = nt.filter(t => !WEAK.has(t) && !weakLocal.has(t));
    if (nStrong.length >= 2 && nStrong.every(t => ct.some(c => tokEq(c, t)))) sc = Math.max(sc, 0.8);
    best = Math.max(best, sc);
  }
  return best;
}
const RELEVANT = t => (t.shop || t.craft || t.office || t.amenity || t.company || t.industrial || t.tourism || t.healthcare || t.leisure ||
  (t.building && !t.highway) || /^(commercial|retail|industrial)$/.test(t.landuse || '')) && !t.highway && !t.boundary && !t.route && !t.place && !t.public_transport && !t.railway;
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
      clearTimeout(to);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('Overpass nicht erreichbar');
}
async function searchHours(stops, radius) {
  const q = `[out:json][timeout:25];(${stops.map(s => `nwr(around:${radius},${s.geo.lat.toFixed(6)},${s.geo.lon.toFixed(6)})[name];`).join('')});out tags center;`;
  const els = (await overpass(q)).map(e => ({ tags: e.tags || {}, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon, id: e.type + '/' + e.id })).filter(e => e.lat != null && RELEVANT(e.tags));
  const out = new Map();
  for (const s of stops) {
    let best = null;
    for (const e of els) {
      const d = distM(s.geo, e); if (d > radius + 40) continue;
      const sc = nameScore(s.kunde, e.tags, s.ort); if (sc < 0.6) continue;
      const rank = sc + (e.tags.opening_hours ? 0.15 : 0) + (/^car/.test(e.tags.shop || '') ? 0.05 : 0) - d / 20000;
      if (!best || rank > best.rank) best = { rank, e, d };
    }
    if (best) {
      const t = best.e.tags;
      out.set(s, { status: 'found', name: t.name, oh: t.opening_hours || '', phone: t.phone || t['contact:phone'] || '', website: t.website || t['contact:website'] || '', osm: 'https://www.openstreetmap.org/' + best.e.id, dist: Math.round(best.d), ts: Date.now() });
    }
  }
  return out;
}
// Ersatzweg, wenn Overpass nicht erreichbar ist: Firmenname über Nominatim suchen (liefert OSM-Zusatzdaten inkl. opening_hours)
async function nominatimPOI(s) {
  const nm = (s.kunde || '').replace(/\b(GmbH|mbH|Co\.?|KG|OHG|AG|UG|e\.\s?K\.?|Inh\.?|Inhaber)\b/gi, ' ').replace(/[&,+-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!nm) return null;
  const list = await nominatim({ q: `${nm}, ${s.ort || s.plz}`, extratags: '1', limit: '5', __all: true });
  let best = null;
  for (const h of list || []) {
    const tags = Object.assign({ name: h.name || '' }, h.extratags || {});
    const d = distM(s.geo, { lat: +h.lat, lon: +h.lon }); if (d > 1500) continue;
    const sc = nameScore(s.kunde, tags, s.ort); if (sc < 0.6) continue;
    const rank = sc + (tags.opening_hours ? 0.15 : 0) - d / 20000;
    if (!best || rank > best.rank) best = { rank, h, tags, d };
  }
  if (!best) return null;
  const t = best.tags;
  return { status: 'found', name: t.name, oh: t.opening_hours || '', phone: t.phone || t['contact:phone'] || '', website: t.website || t['contact:website'] || '', osm: `https://www.openstreetmap.org/${best.h.osm_type}/${best.h.osm_id}`, dist: Math.round(best.d), ts: Date.now() };
}
/* ---- Google Places API (New): primäre Quelle, wenn ein Schlüssel auf dem Gerät hinterlegt ist ---- */
const G_FIELDS = 'places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.currentOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.googleMapsUri';
let googleWarned = false;
const normAddr = x => (x || '').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/strasse|str\./g, 'str').replace(/[^a-z0-9]/g, '');
async function googleSearch(s) {
  const body = { textQuery: [s.kunde, s.strasse, [s.plz, s.ort].filter(Boolean).join(' ')].filter(Boolean).join(', '), languageCode: 'de', regionCode: 'DE', pageSize: 5,
    locationBias: { circle: { center: { latitude: s.geo.lat, longitude: s.geo.lon }, radius: 500 } } };
  const r = await fetch('https://places.googleapis.com/v1/places:searchText', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': settings.googleKey, 'X-Goog-FieldMask': G_FIELDS }, body: JSON.stringify(body) });
  if (!r.ok) {
    let msg = 'HTTP ' + r.status; try { msg = (await r.json()).error?.message || msg; } catch { }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  const places = (await r.json()).places || [];
  let best = null;
  const street = normAddr(s.strasse);
  for (const p of places) {
    if (!p.location) continue;
    const d = distM(s.geo, { lat: p.location.latitude, lon: p.location.longitude });
    const sc = nameScore(s.kunde, { name: p.displayName?.text || '' }, s.ort);
    const sameAddr = street && normAddr(p.formattedAddress).includes(street);
    let conf = null, rank = 0;
    if (sc >= 0.6 && d <= 500) { conf = 'name'; rank = 2 + sc - d / 5000; }
    else if (d <= 60 || (sameAddr && d <= 150)) { conf = 'address'; rank = 1 - d / 1000; }   // Treffer nur über die Adresse
    if (!conf) continue;
    if (p.regularOpeningHours) rank += 0.1;
    if (!best || rank > best.rank) best = { rank, p, d, conf };
  }
  if (!best) return null;
  const p = best.p;
  return { status: 'found', source: 'google', placeId: p.id || '', confidence: best.conf, name: p.displayName?.text || '', address: p.formattedAddress || '',
    periods: p.regularOpeningHours?.periods || null, weekday: p.regularOpeningHours?.weekdayDescriptions || null,
    current: p.currentOpeningHours?.periods || null, oh: (p.regularOpeningHours?.periods || p.currentOpeningHours?.periods) ? 'google' : '',
    phone: p.nationalPhoneNumber || '', website: p.websiteUri || '', gmaps: p.googleMapsUri || '', dist: Math.round(best.d), ts: Date.now() };
}
// Google-Perioden (day 0 = Sonntag) als Objekt mit derselben Schnittstelle wie opening_hours.js
function googleOH(h) {
  const reg = h.periods || [];
  const cur = (h.current || []).filter(p => p.open?.date);
  const curDays = new Set(cur.map(p => `${p.open.date.year}-${p.open.date.month}-${p.open.date.day}`));
  const fetched = new Date(h.ts); fetched.setHours(0, 0, 0, 0);
  const inCurRange = d => cur.length && d >= fetched && d < new Date(fetched.getTime() + 7 * 864e5);
  const at = (d, t) => { const x = new Date(d); x.setHours(t?.hour || 0, t?.minute || 0, 0, 0); return x; };
  function dayIntervals(day) {          // Intervalle, die an diesem Kalendertag beginnen
    const out = [];
    if (inCurRange(day)) {
      for (const p of cur) {
        const o = p.open.date; if (o.year !== day.getFullYear() || o.month !== day.getMonth() + 1 || o.day !== day.getDate()) continue;
        const a = at(day, p.open); let b;
        if (p.close?.date) b = at(new Date(p.close.date.year, p.close.date.month - 1, p.close.date.day), p.close); else b = new Date(a.getTime() + 7 * 864e5);
        out.push([a, b]);
      }
      return out;   // für diesen Tag gelten die aktuellen Zeiten (inkl. Feiertage); keine Einträge = geschlossen
    }
    for (const p of reg) {
      if (p.open?.day !== day.getDay()) continue;
      const a = at(day, p.open);
      if (!p.close) { out.push([a, new Date(a.getTime() + 7 * 864e5)]); continue; }   // 24/7
      let off = (p.close.day - p.open.day + 7) % 7; const b0 = at(day, p.close);
      if (off === 0 && b0 <= a) off = 7;
      out.push([a, new Date(b0.getTime() + off * 864e5)]);
    }
    return out;
  }
  function intervals(from, to) {
    const res = []; const d = new Date(from); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 7);
    for (; d < to; d.setDate(d.getDate() + 1)) for (const [a, b] of dayIntervals(new Date(d))) if (b > from && a < to) res.push([a < from ? new Date(from) : a, b > to ? new Date(to) : b]);
    res.sort((x, y) => x[0] - y[0]);
    const merged = []; for (const iv of res) { const l = merged[merged.length - 1]; if (l && iv[0] <= l[1]) { if (iv[1] > l[1]) l[1] = iv[1]; } else merged.push([iv[0], iv[1]]); }
    return merged;
  }
  return {
    getOpenIntervals: (from, to) => intervals(from, to).map(([a, b]) => [a, b, false, '']),
    getState: t => intervals(new Date(t.getTime() - 1), new Date(t.getTime() + 1)).length > 0,
    getNextChange: t => {
      const iv = intervals(t, new Date(t.getTime() + 8 * 864e5));
      if (!iv.length) return undefined;
      return iv[0][0] <= t ? iv[0][1] : iv[0][0];
    }
  };
}
let hoursBusy = false; const hoursRetries = {};
async function fetchHoursForResult(res, force) {
  if (hoursBusy) return; hoursBusy = true;
  try {
    const need = [];
    for (const s of res.stops) {
      if (!s.geo) continue;
      if (force || s.hours?.status === 'error' || s.hours?.status === 'loading') s.hours = null;
      if (!s.hours && !force) s.hours = cachedHours(s);
      if (!s.hours) need.push(s);
    }
    if (need.length) {
      need.forEach(s => s.hours = { status: 'loading' }); renderResult();
      let osmNeed = need;
      if (settings.googleKey) {
        osmNeed = [];
        let gBlocked = false;
        for (const s of need) {
          if (s.gTried || gBlocked) { osmNeed.push(s); continue; }          // höchstens eine Google-Suche je Stopp und Tour
          try {
            const h = await googleSearch(s); s.gTried = true;
            if (h && h.oh) { s.hours = h; hoursCache[hoursKey(s)] = h; renderResult(); }
            else { if (h) s.gNoHours = h; osmNeed.push(s); }   // Google-Treffer ohne Zeiten: OSM versuchen, Telefon/Web behalten
          } catch (e) {
            console.warn('Google Places', e.status || '', e.message);
            if (!googleWarned) { googleWarned = true; toast('Google-Suche fehlgeschlagen: ' + e.message + ' – nutze OpenStreetMap.', 6000); }
            if (e.status === 400 || e.status === 403) gBlocked = true;   // Schlüssel ungültig/gesperrt: in diesem Durchlauf nicht weiter versuchen
            osmNeed.push(s);
          }
        }
        LS.set('tp_hours', hoursCache); saveResult(res);
      }
      if (osmNeed.length) try {
        let left = osmNeed;
        for (const r of [200, 600]) {
          if (!left.length) break;
          const found = await searchHours(left, r);
          for (const [s, h] of found) { s.hours = h; hoursCache[hoursKey(s)] = h; }
          left = left.filter(s => !found.has(s));
        }
        for (const s of left) { s.hours = s.gNoHours || { status: 'none', ts: Date.now() }; hoursCache[hoursKey(s)] = s.hours; }
        LS.set('tp_hours', hoursCache);
      } catch (e) {
        console.warn('Overpass', e);
        for (const s of osmNeed) {
          if (s.hours?.status !== 'loading') continue;
          try { const h = await nominatimPOI(s); s.hours = h || s.gNoHours || { status: 'error' }; if (h) hoursCache[hoursKey(s)] = h; }
          catch { s.hours = { status: 'error' }; }
          renderResult();
        }
        LS.set('tp_hours', hoursCache);
        // Overpass-Server sind oft überlastet: später automatisch erneut versuchen
        if (osmNeed.some(s => s.hours?.status === 'error') && (hoursRetries[res.id] = (hoursRetries[res.id] || 0) + 1) <= 4) setTimeout(() => { if (state.result?.id === res.id) fetchHoursForResult(state.result); }, 45000 * hoursRetries[res.id]);
      }
    }
    if (res.stops.some(s => s.hours?.oh && s.hours.source !== 'google')) await loadOH().catch(e => console.warn(e));
    saveResult(res);
  } finally { hoursBusy = false; renderResult(); }
}
function fmtIntervals(oh, day) {
  const to = new Date(day.getTime() + 864e5);
  try {
    const iv = oh.getOpenIntervals(day, to);
    if (!iv.length) return 'geschlossen';
    return iv.map(([a, b, unk]) => (b - a >= 864e5 - 60000 ? '24 Std.' : `${hhmm(a)}–${b.getHours() === 0 && b.getMinutes() === 0 ? '24:00' : hhmm(b)}`) + (unk ? ' (?)' : '')).join(', ');
  } catch { return '?'; }
}
function hoursHtml(s, sched, res) {
  const h = s.hours; const gq = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([s.kunde, s.ort].filter(Boolean).join(' '))}`;
  const glink = `<a href="${esc(gq)}" target="_blank" rel="noopener">In Google Maps prüfen</a>`;
  if (!h || h.status === 'loading') return `<div class="oh muted">🕘 Öffnungszeiten werden gesucht …</div>`;
  if (h.status === 'error') return `<div class="oh muted">🕘 Keine Öffnungszeiten gefunden – OSM-Server gerade überlastet, es wird automatisch erneut gesucht. <button class="link" data-act="retryhours">Jetzt erneut suchen</button> · ${glink}</div>`;
  const extra = [h.phone ? `<a href="tel:${esc(h.phone.replace(/[^+\d]/g, ''))}">📞 ${esc(h.phone)}</a>` : '', h.website ? `<a href="${esc(/^https?:/.test(h.website) ? h.website : 'https://' + h.website)}" target="_blank" rel="noopener">🌐 Webseite</a>` : ''].filter(Boolean).join(' · ');
  let glink2 = '', lowConf = '';
  if (h.status === 'none' || !h.oh) {
    if (h.source === 'google') return `<div class="oh muted">🕘 Keine Öffnungszeiten bei Google (${esc(h.name)}) · ${h.gmaps ? `<a href="${esc(h.gmaps)}" target="_blank" rel="noopener">In Google Maps öffnen</a>` : glink}${extra ? '<br>' + extra : ''}</div>`;
    return `<div class="oh muted">🕘 Keine Öffnungszeiten gefunden${h.status === 'found' ? ` (OSM: ${esc(h.name)})` : ''} · ${glink}${extra ? '<br>' + extra : ''}</div>`;
  }
  const isG = h.source === 'google';
  const oh = isG ? googleOH(h) : makeOH(h.oh, s);
  if (isG) {
    const gl = h.gmaps ? `<a href="${esc(h.gmaps)}" target="_blank" rel="noopener">In Google Maps öffnen</a>` : glink;
    glink2 = `${esc(h.name)} · Quelle: Google${h.confidence === 'address' ? ' (nur Adress-Treffer)' : ''} · ${gl}`;
    lowConf = h.confidence === 'address' ? `<div class="lowconf">Nur über die Adresse gefunden: „${esc(h.name)}“ – bitte prüfen</div>` : '';
  }
  if (!oh) return `<div class="oh">🕘 ${esc(h.oh)}<br><span class="muted">(${esc(h.name)} · OSM) · ${glink}</span>${extra ? '<br>' + extra : ''}</div>`;
  const day = tourDate(res); const dayRef = sched && !sched.done && sched.arr ? new Date(sched.arr) : day; dayRef.setHours(0, 0, 0, 0);
  let warn = '';
  if (sched && !sched.done && sched.arr) {
    try {
      const open = oh.getState(sched.arr), nx = oh.getNextChange(sched.arr);
      if (!open) {
        const sameDay = nx && nx.toDateString() === sched.arr.toDateString();
        warn = `⚠️ Ankunft ${hhmm(sched.arr)} – ${sameDay ? 'öffnet erst um ' + hhmm(nx) : 'an diesem Tag geschlossen'}`;
      } else if (nx && nx < sched.dep) warn = `⚠️ Schließt um ${hhmm(nx)} – vor der geplanten Abfahrt ${hhmm(sched.dep)}`;
    } catch { }
  }
  const mon = new Date(dayRef); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const week = [...Array(7)].map((_, i) => { const d = new Date(mon); d.setDate(mon.getDate() + i); const cur = d.getTime() === dayRef.getTime();
    return `<tr class="${cur ? 'cur' : ''}"><td>${WD[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.</td><td>${fmtIntervals(oh, d)}</td></tr>`; }).join('');
  return `<details class="oh${warn ? ' warnbox' : ''}"><summary>🕘 ${WD[dayRef.getDay()]}: <b>${fmtIntervals(oh, dayRef)}</b>${lowConf}${warn ? `<div class="ohwarn">${warn}</div>` : ''}</summary>
    <table class="week">${week}</table><div class="muted small">${glink2 || `${esc(h.name)} · Quelle: <a href="${esc(h.osm)}" target="_blank" rel="noopener">OpenStreetMap</a> · ${glink}`}</div>${extra ? `<div class="small">${extra}</div>` : ''}</details>`;
}

function hoursLines(s, sched, res) {
  const h = s.hours;
  if (!h || h.status === 'loading') return ['Öffnungszeiten werden gesucht …'];
  if (h.status === 'error') return ['Keine Öffnungszeiten gefunden'];
  if (h.status === 'none' || !h.oh) {
    const who = h && h.name ? ` (${h.name})` : '';
    return [`Keine Öffnungszeiten${h && (h.status === 'found' || (h.source === 'google' && h.name)) ? who : ''}`];
  }
  const isG = h.source === 'google';
  const oh = isG ? googleOH(h) : makeOH(h.oh, s);
  if (!oh) return [h.oh && h.oh !== 'google' ? `Öffnungszeiten: ${h.oh}` : 'Keine Öffnungszeiten gefunden'];
  const day = tourDate(res);
  const dayRef = sched && !sched.done && sched.arr ? new Date(sched.arr) : new Date(day);
  dayRef.setHours(0, 0, 0, 0);
  const lines = [`Öffnungszeiten ${WD[dayRef.getDay()]}: ${fmtIntervals(oh, dayRef)}`];
  if (isG && h.confidence === 'address' && h.name) lines.push(`Nur über die Adresse gefunden: „${h.name}“ – bitte prüfen`);
  if (sched && !sched.done && sched.arr) {
    try {
      const open = oh.getState(sched.arr), nx = oh.getNextChange(sched.arr);
      if (!open) {
        const sameDay = nx && nx.toDateString() === sched.arr.toDateString();
        lines.push(`Hinweis: Ankunft ${hhmm(sched.arr)} – ${sameDay ? 'öffnet erst um ' + hhmm(nx) : 'an diesem Tag geschlossen'}`);
      } else if (nx && nx < sched.dep) lines.push(`Hinweis: Schließt um ${hhmm(nx)} – vor der geplanten Abfahrt ${hhmm(sched.dep)}`);
    } catch { }
  }
  return lines;
}
function visibleNote(s, i) {
  if (noteEdit === 'route|' + i) {
    const ta = document.querySelector(`[data-note="${CSS.escape('route|' + i)}"] textarea`);
    if (ta) return ta.value.replace(/\s+$/, '').trim();
  }
  const n = findNote(s);
  return n && n.text ? String(n.text).trim() : '';
}
function routeSheet(res) {
  const S = computeSchedule(res);
  const doneN = res.stops.filter(s => s.done).length;
  const blocks = [];
  const startLines = [];
  const startLabel = pointLabel(routeStart(res));
  if (startLabel) startLines.push({ k: 'addr', t: startLabel });
  startLines.push({ k: 'time', t: 'Abfahrt ' + (res.startTime || settings.startTime || '–') });
  blocks.push({ kicker: 'Start', lines: startLines });
  res.stops.forEach((s, i) => {
    const r = S.rows[i] || {};
    const leg = (res.legs && res.legs[i]) || { dur: 0, dist: 0 };
    const ord = [s.auftrag || 'ohne Nr.'];
    if (s.kategorie) ord.push(s.kategorie);
    if (s.typ && /termin/i.test(s.typ)) ord.push(s.typ);
    const lines = [];
    if (r.done) lines.push({ k: 'time', t: 'Erledigt um ' + hhmm(r.dep) });
    else lines.push({ k: 'time', t: (i === S.next ? 'Als Nächstes · ' : '') + 'Ankunft ca. ' + hhmm(r.arr) + ' · weiter ' + hhmm(r.dep) });
    lines.push({ k: 'ord', t: ord.join(' · ') });
    if (s.kunde) lines.push({ k: 'name', t: s.kunde });
    lines.push({ k: 'addr', t: addrText(s) || 'keine Adresse' });
    lines.push({ k: 'muted', t: 'Anfahrt ' + fmtMin(leg.dur) + ' · ' + fmtKm(leg.dist) });
    const note = visibleNote(s, i);
    if (note) lines.push({ k: 'note', t: note });
    const hourLs = hoursLines(s, r, res);
    const known = hourLs.some(t => t.startsWith('Öffnungszeiten'));
    if (known || !r.done) hourLs.forEach(t => lines.push({ k: t.startsWith('Hinweis') || t.startsWith('Nur über') ? 'warn' : 'muted', t }));
    blocks.push({ kicker: String(i + 1), lines });
  });
  const lb = (res.legs && res.legs[res.stops.length]) || { dur: 0, dist: 0 };
  const customEnd = hasExplicitDest(res);
  const endLabel = pointLabel(routeEnd(res));
  const endLines = [
    { k: 'time', t: (customEnd ? 'Ziel ca. ' : 'Zurück ca. ') + hhmm(S.homeArr) },
    { k: 'name', t: customEnd ? 'Ziel' : 'Zurück nach Hause' }
  ];
  if (endLabel) endLines.push({ k: 'addr', t: endLabel });
  endLines.push({ k: 'muted', t: 'Anfahrt ' + fmtMin(lb.dur) + ' · ' + fmtKm(lb.dist) });
  blocks.push({ kicker: 'Ziel', lines: endLines });
  return {
    title: 'Tourenplan',
    meta: [res.name, res.driverName || res.driver, res.datum].filter(Boolean).join(' · '),
    sub: 'Abfahrt ' + (res.startTime || settings.startTime || '–') + ' · Zurück ca. ' + hhmm(S.homeArr),
    totals: `${fmtKm(res.totalDist || 0)} · ${fmtMin(res.totalDur || 0)} Fahrzeit · ${doneN ? doneN + '/' : ''}${res.stops.length} ${doneN ? 'erledigt' : 'Stopps'}`,
    foot: 'Ankunftszeiten sind Schätzungen ohne Verkehr (Fahrzeit + Zeit vor Ort).',
    blocks
  };
}
function renderSheetHtml(model) {
  const blocks = model.blocks.map(b => `<section class="pstop"><div class="pnum">${esc(b.kicker)}</div><div class="pbody">${
    b.lines.map(l => `<div class="p-${l.k}">${l.k === 'note' ? '<b>Notiz:</b> ' + esc(l.t) : esc(l.t)}</div>`).join('')
  }</div></section>`).join('');
  return `<header class="phead"><h1>${esc(model.title)}</h1><p class="pmeta">${esc(model.meta)}</p><p class="psub">${esc(model.sub)}</p><p class="ptot">${esc(model.totals)}</p></header>${blocks}<p class="pfoot">${esc(model.foot)}</p>`;
}
function usePdfShare() {
  const ua = navigator.userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!ios) return false;
  return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}
function routePdfName(res) {
  const m = (res.datum || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `Tourenplan-${m[3]}-${m[2]}-${m[1]}.pdf` : 'Tourenplan.pdf';
}
async function printRoute() {
  const res = state.result;
  if (!res) return toast('Bitte zuerst eine Tour planen.');
  const model = routeSheet(res);
  const sheet = $('#printSheet');
  if (sheet) sheet.innerHTML = renderSheetHtml(model);
  if (usePdfShare()) {
    try {
      const blob = buildRoutePdf(model);
      const file = new File([blob], routePdfName(res), { type: 'application/pdf' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Tourenplan' });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.warn('PDF teilen', e);
    }
  }
  const gen = ++printRoute.gen;
  document.body.classList.add('printing');
  let started = false;
  const onBefore = () => { started = true; };
  const onAfter = () => {
    if (gen !== printRoute.gen) return;
    document.body.classList.remove('printing');
    window.removeEventListener('beforeprint', onBefore);
    window.removeEventListener('afterprint', onAfter);
  };
  window.addEventListener('beforeprint', onBefore);
  window.addEventListener('afterprint', onAfter);
  window.print();
  setTimeout(() => { if (!started) onAfter(); }, 1500);
}
printRoute.gen = 0;

/* Minimales PDF (Helvetica, WinAnsi) – offline, ohne Bibliothek. Für die installierte iOS-App, in der window.print() oft nichts öffnet. */
const PDF_W = { ' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,"'":191,'(':333,')':333,'*':389,'+':584,',':278,'-':333,'.':278,'/':278,
  '0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,
  'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,
  'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,'m':833,'n':556,'o':556,'p':556,'q':556,'r':333,'s':500,'t':278,'u':556,'v':500,'w':722,'x':500,'y':500,'z':500,
  'Ä':667,'Ö':778,'Ü':722,'ä':556,'ö':556,'ü':556,'ß':611,'–':556,'—':1000,'•':350,'„':278,'“':355,'”':355,'€':556,'‘':222,'’':222 };
const PDF_WIN = { '\u20AC':128,'\u201A':130,'\u201E':132,'\u2026':133,'\u2020':134,'\u2021':135,'\u02C6':136,'\u2030':137,'\u0160':138,'\u2039':139,'\u0152':140,'\u017D':142,'\u2018':145,'\u2019':146,'\u201C':147,'\u201D':148,'\u2022':149,'\u2013':150,'\u2014':151,'\u02DC':152,'\u2122':153,'\u0161':154,'\u203A':155,'\u0153':156,'\u017E':158,'\u0178':159 };
function pdfCharWidth(ch, size, bold) {
  const w = PDF_W[ch] ?? 520;
  return w / 1000 * size * (bold ? 1.08 : 1);
}
function wrapPdf(text, size, bold, maxW) {
  const lines = [];
  for (const part of String(text ?? '').split('\n')) lines.push(...wrapPdfWords(part, size, bold, maxW));
  return lines.length ? lines : [''];
}
function wrapPdfWords(text, size, bold, maxW) {
  const width = s => { let w = 0; for (const ch of s) w += pdfCharWidth(ch, size, bold); return w; };
  const lines = [];
  let cur = '';
  const words = String(text || '').split(/[ \t]+/).filter(Boolean);
  if (!words.length) return [''];
  const take = word => {
    if (width(word) <= maxW) return word;
    let buf = '';
    for (const ch of word) {
      if (buf && width(buf + ch) > maxW) { lines.push(buf); buf = ch; }
      else buf += ch;
    }
    return buf;
  };
  for (const word of words) {
    const part = cur ? null : take(word);
    if (!cur) { cur = part; continue; }
    if (width(cur + ' ' + word) <= maxW) cur += ' ' + word;
    else { lines.push(cur); cur = take(word); }
  }
  if (cur) lines.push(cur);
  return lines;
}
function pdfEsc(str) {
  let out = '';
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    const b = cp <= 255 ? cp : PDF_WIN[ch];
    if (b == null) continue;
    if (b === 92 || b === 40 || b === 41) out += '\\' + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += '\\' + b.toString(8).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out;
}
function pdfNum(n) { return (Math.round(n * 100) / 100).toString(); }
function buildRoutePdf(model) {
  const W = 595.28, H = 841.89, M = 42, bottom = 40;
  const pages = [];
  let ops = null, y = 0;
  const header = [model.title, model.meta].filter(Boolean).join(' · ');
  function draw(text, size, font, x, gap, allowBreak) {
    const bold = font === 'F2';
    const lines = wrapPdf(text, size, bold, Math.max(40, W - M - x));
    const lh = Math.round(size * 1.38);
    for (const line of lines) {
      if (allowBreak !== false && y - lh < bottom) newPage(true);
      ops.push({ op: 't', text: line, x, y: y - size, size, font });
      y -= lh;
    }
    if (gap) y -= gap;
  }
  function newPage(cont) {
    if (ops) pages.push(ops);
    ops = [];
    y = H - M;
    if (cont) draw(header, 11, 'F2', M, 8, false);
    else {
      draw(model.title, 18, 'F2', M, 3, false);
      if (model.meta) draw(model.meta, 13, 'F2', M, 2, false);
      draw(model.sub, 10.5, 'F1', M, 1, false);
      draw(model.totals, 10.5, 'F1', M, 8, false);
    }
  }
  function addBlock(kicker, rows) {
    const x = M + 46;
    const contentW = W - M - x;
    const prepared = rows.map(r => ({ ...r, lines: wrapPdf(r.t, r.size, !!r.bold, contentW), lh: Math.round(r.size * 1.38) }));
    let h = 8;
    for (const r of prepared) h += r.lines.length * r.lh + (r.gap || 0);
    if (y - h < bottom && h < H - M - bottom - 36) newPage(true);
    ops.push({ op: 't', text: kicker, x: M, y: y - 12, size: 11, font: 'F2' });
    for (const r of prepared) {
      const font = r.bold ? 'F2' : 'F1';
      for (const line of r.lines) {
        if (y - r.lh < bottom) newPage(true);
        ops.push({ op: 't', text: line, x, y: y - r.size, size: r.size, font });
        y -= r.lh;
      }
      if (r.gap) y -= r.gap;
    }
    y -= 4;
    ops.push({ op: 'l', x1: M, y1: y, x2: W - M, y2: y });
    y -= 8;
  }
  newPage(false);
  for (const b of model.blocks) {
    addBlock(b.kicker, b.lines.map(l => {
      if (l.k === 'time') return { t: l.t, size: 12, bold: true, gap: 1 };
      if (l.k === 'ord' || l.k === 'name') return { t: l.t, size: 11, bold: true };
      if (l.k === 'note') return { t: 'Notiz: ' + l.t, size: 10, bold: false, gap: 1 };
      if (l.k === 'warn') return { t: l.t, size: 10, bold: true };
      return { t: l.t, size: 10, bold: false };
    }));
  }
  const footLines = wrapPdf(model.foot || '', 9, false, W - 2 * M);
  if (y - footLines.length * 13 < bottom) newPage(true);
  for (const line of footLines) { ops.push({ op: 't', text: line, x: M, y: y - 9, size: 9, font: 'F1' }); y -= 13; }
  if (ops) pages.push(ops);
  pages.forEach((page, i) => {
    const label = (i + 1) + ' / ' + pages.length;
    let tw = 0; for (const ch of label) tw += pdfCharWidth(ch, 9, false);
    page.push({ op: 't', text: label, x: (W - tw) / 2, y: 22, size: 9, font: 'F1' });
  });
  const bodies = pages.map(page => {
    let s = '0 G 0 g\n';
    for (const o of page) {
      if (o.op === 't') s += `BT /${o.font} ${pdfNum(o.size)} Tf 1 0 0 1 ${pdfNum(o.x)} ${pdfNum(o.y)} Tm (${pdfEsc(o.text)}) Tj ET\n`;
      else s += `0.65 G 0.4 w ${pdfNum(o.x1)} ${pdfNum(o.y1)} m ${pdfNum(o.x2)} ${pdfNum(o.y2)} l S 0 G\n`;
    }
    return s;
  });
  const n = pages.length;
  const offsets = [];
  const parts = [];
  let pos = 0;
  const write = s => { parts.push(s); pos += s.length; };
  const obj = (id, body) => { offsets[id] = pos; write(id + ' 0 obj\n' + body + '\nendobj\n'); };
  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const pageIds = [], contentIds = [];
  let next = 5;
  for (let i = 0; i < n; i++) { pageIds.push(next++); contentIds.push(next++); }
  const total = next - 1;
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count ${n} >>`);
  obj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  bodies.forEach((stream, i) => {
    obj(contentIds[i], `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
    obj(pageIds[i], `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNum(W)} ${pdfNum(H)}] /Contents ${contentIds[i]} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
  });
  const xref = pos;
  write(`xref\n0 ${total + 1}\n0000000000 65535 f \n`);
  for (let i = 1; i <= total; i++) write(String(offsets[i]).padStart(10, '0') + ' 00000 n \n');
  write(`trailer << /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  const raw = parts.join('');
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 255;
  return new Blob([bytes], { type: 'application/pdf' });
}

function copyHoursOnto(fromStops, toStops) {
  if (!Array.isArray(fromStops) || !Array.isArray(toStops)) return;
  toStops.forEach(dst => {
    if (!dst) return;
    const src = fromStops.find(s => s && dst.id != null && s.id != null && String(s.id) === String(dst.id)) || null;
    if (!src || src === dst) return;
    if (src.hours) dst.hours = src.hours;
    if (src.gTried) dst.gTried = true;
  });
}
function sameStop(a, b) {
  if (!a || !b) return false;
  if (a.id != null && b.id != null && String(a.id) === String(b.id)) return true;
  const aa = String(a.auftrag || '').trim(), bb = String(b.auftrag || '').trim();
  return !!(aa && aa === bb);
}
function doneElsewhere(s, exceptId) {
  return (tours || []).some(t => t && String(t.id) !== String(exceptId) && (t.stops || []).some(x => doneStamp(x.done) && sameStop(x, s)));
}
function abandonDraft() {
  draftId = null;
  draftSnapshot = null;
  draftUndo = new Set();
}
function beginDraft(saved) {
  if (!saved) return;
  draftSnapshot = cloneTour(saved);
  draftId = saved.id;
  draftUndo = new Set();
  state.result = cloneTour(saved);
  routeEdit = null;
  saveState();
}
function commitDraft() {
  if (!state.result) return;
  const res = state.result;
  if (draftSnapshot) {
    for (const prev of draftSnapshot.stops || []) {
      if (!doneStamp(prev.done)) continue;
      const now = (res.stops || []).find(s => sameStop(s, prev));
      if ((!now || !doneStamp(now.done)) && !doneElsewhere(prev, res.id)) forgetDoneStop(prev);
    }
  }
  rememberTourDone(res);
  const id = res.id;
  abandonDraft();
  saveResult(res);
  const saved = (tours || []).find(t => t && String(t.id) === String(id));
  if (saved) beginDraft(saved);
  renderTours();
  renderResult();
  toast('Route gespeichert');
}
function discardDraft() {
  const snap = draftSnapshot ? cloneTour(draftSnapshot) : null;
  abandonDraft();
  if (snap) beginDraft(snap);
  else { state.result = null; saveState(); }
  renderTours();
  renderResult();
  toast('Änderungen verworfen. Die gespeicherte Route bleibt.');
}
function saveResult(res) {
  res = res || state.result; if (!res) return;
  if (drafting() && String(res.id) === String(draftId)) {
    if (state.result && state.result !== res && String(state.result.id) === String(res.id)) copyHoursOnto(res.stops, state.result.stops);
    return;
  }
  const live = state.result && String(state.result.id) === String(res.id) ? state.result : null;
  let i = Array.isArray(tours) ? tours.findIndex(t => t && String(t.id) === String(res.id)) : -1;
  const prev = i >= 0 ? tours[i] : null;
  // Eine spätere Öffnungszeiten-Suche darf die Erledigt-Zeit einer anderen Kopie nicht löschen.
  if (live && res !== live) { copyHoursOnto(res.stops, live.stops); res = live; }
  else if (!live && prev && res !== prev) { copyHoursOnto(res.stops, prev.stops); res = prev; }
  applyRememberedDone(res.stops);
  res.updated = Date.now();
  i = Array.isArray(tours) ? tours.findIndex(t => t && String(t.id) === String(res.id)) : -1;
  if (!Array.isArray(tours)) tours = [];
  if (i >= 0) tours[i] = res;
  else { tours.unshift(res); tours = tours.slice(0, 20); }
  LS.set('tp_tours', tours);
  if (state.result && String(state.result.id) === String(res.id)) { state.result = res; saveState(); }
}
function keepShownTour() {
  if (state.result) saveResult(state.result);
}
function geoFailToast(e) {
  const msg = e && (e.user || /nicht gefunden|Bitte|Koordinaten/.test(e.message || '')) ? e.message : 'Adresse konnte nicht gesucht werden. Bitte später noch einmal.';
  toast(msg, 6000);
}
function syncSourceStop(before, after, placeChanged) {
  let match = null;
  if (before.id) match = state.stops.find(s => s && s.id === before.id) || null;
  if (!match && before.auftrag) {
    const hits = state.stops.filter(s => s && s.auftrag === before.auftrag);
    if (hits.length === 1) match = hits[0];
  }
  if (!match) match = state.stops.find(s => s && s.strasse === before.strasse && s.plz === before.plz && s.ort === before.ort && (s.kunde || '') === (before.kunde || '')) || null;
  if (!match) return;
  match.kunde = after.kunde; match.strasse = after.strasse; match.plz = after.plz; match.ort = after.ort;
  match.auftrag = after.auftrag; match.kategorie = after.kategorie;
  if (placeChanged) { match.geo = after.geo || null; match.geoErr = after.geo ? null : 'Adresse nicht gefunden'; }
}
async function saveEndpoint(box) {
  if (routeSaving || !state.result) return;
  const kind = box.dataset.end;
  if (kind !== 'start' && kind !== 'dest') return;
  const addr = box.querySelector('[name=addr]')?.value || '';
  const coords = box.querySelector('[name=coords]')?.value || '';
  if (!String(addr).trim() && !String(coords).trim()) {
    toast(kind === 'start' ? 'Bitte eine Startadresse eingeben.' : 'Bitte eine Zieladresse eingeben.');
    return;
  }
  routeSaving = true;
  const btn = box.querySelector('[data-act=saveend]');
  if (btn) { btn.disabled = true; btn.textContent = 'Suche …'; }
  try {
    const point = await locateManual(addr, coords);
    if (!point) throw Object.assign(new Error(kind === 'start' ? 'Startadresse nicht gefunden – bitte genauer eingeben.' : 'Zieladresse nicht gefunden – bitte genauer eingeben.'), { user: true });
    const res = state.result;
    let keptDest = hasExplicitDest(res);
    if (kind === 'start') {
      // Ziel merken, damit ein neuer Start das bisherige Ziel nicht mit verschiebt.
      if (!keptDest) {
        const prev = routeStart(res);
        if (prev.addr || hasPos(prev)) {
          res.dest = { addr: prev.addr || '', lat: prev.lat, lon: prev.lon, approx: !!prev.approx };
          keptDest = true;
        }
      }
      res.home = Object.assign({}, res.home, { addr: point.addr, lat: point.lat, lon: point.lon, approx: !!point.approx });
    } else {
      res.dest = Object.assign({}, res.dest, { addr: point.addr, lat: point.lat, lon: point.lon, approx: !!point.approx });
    }
    const ok = await recomputeLegs(res);
    routeEdit = null; mapFor = null;
    saveResult();
    renderResult();
    const msg = !ok ? 'Adresse gespeichert. Die Fahrzeit konnte nicht neu berechnet werden.'
      : kind === 'dest' ? 'Ziel gespeichert. Der Start bleibt, wie es ist.'
      : keptDest ? 'Start gespeichert. Das Ziel bleibt, wie es ist.'
      : 'Start gespeichert.';
    toast(msg, ok ? 4000 : 6000);
    if (point.approx) toast('Hinweis: nur ungefähr gefunden (PLZ/Ort).', 5000);
  } catch (e) {
    geoFailToast(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Übernehmen'; }
  } finally { routeSaving = false; }
}
async function saveRouteStop(li) {
  if (routeSaving || !state.result) return;
  const s = state.result.stops[+li.dataset.i];
  const box = li.querySelector('[data-route-edit]');
  if (!s || !box) return;
  const next = {};
  box.querySelectorAll('input').forEach(inp => { if (inp.name) next[inp.name] = inp.value.trim(); });
  const before = { id: s.id, kunde: s.kunde, strasse: s.strasse, plz: s.plz, ort: s.ort, auftrag: s.auftrag, kategorie: s.kategorie };
  const addrChanged = addrText(before) !== addrText(next);
  const coordsText = next.coords || '';
  if (!addrText(next) && !coordsText) { toast('Bitte eine Adresse eingeben.'); return; }
  routeSaving = true;
  const btn = box.querySelector('[data-act=savestop]');
  if (btn) { btn.disabled = true; btn.textContent = 'Suche …'; }
  try {
    let geo = s.geo, placeChanged = false;
    if (coordsText) {
      const coords = parseCoordPair(coordsText);
      if (!coords) throw Object.assign(new Error('Koordinaten nicht erkannt. Beispiel: 51.0504, 13.7373'), { user: true });
      geo = { lat: coords.lat, lon: coords.lon, approx: false, label: addrText(next) };
      placeChanged = true;
    } else if (addrChanged) {
      geo = await geocode({ strasse: next.strasse, plz: next.plz, ort: next.ort }, { fresh: true });
      if (!geo) throw Object.assign(new Error('Adresse nicht gefunden – bitte Straße, PLZ und Ort prüfen.'), { user: true });
      placeChanged = true;
    }
    const keptDone = doneStamp(s.done);
    s.kunde = next.kunde; s.strasse = next.strasse; s.plz = next.plz; s.ort = next.ort;
    s.auftrag = next.auftrag; s.kategorie = next.kategorie;
    if (keptDone) s.done = keptDone;
    applyRememberedDone([s]);
    if (placeChanged) { s.geo = geo; s.hours = null; s.gTried = false; delete s.gNoHours; }
    syncSourceStop(before, s, placeChanged);
    const ok = placeChanged ? await recomputeLegs(state.result) : true;
    routeEdit = null; mapFor = null;
    saveResult();
    renderStops();
    renderResult();
    if (placeChanged && state.result) fetchHoursForResult(state.result);
    toast(ok ? 'Stopp gespeichert. Die Reihenfolge bleibt.' : 'Stopp gespeichert. Die Fahrzeit konnte nicht neu berechnet werden.', ok ? 4000 : 6000);
    if (placeChanged && geo && geo.approx) toast('Hinweis: nur ungefähr gefunden (PLZ/Ort).', 5000);
  } catch (e) {
    geoFailToast(e);
    if (btn) { btn.disabled = false; btn.textContent = 'Übernehmen'; }
  } finally { routeSaving = false; }
}

let routeEdit = null;      // 'start' | 'dest' | 'stop|<i>' – nur die Ansicht, wird nicht gespeichert
let routeEditTour = null;
let routeSaving = false;
function keepRouteEditing(fn) {
  const box = routeEdit ? document.querySelector('[data-route-edit]') : null;
  const vals = {};
  if (box) box.querySelectorAll('input').forEach(i => { if (i.name) vals[i.name] = i.value; });
  const active = document.activeElement;
  const activeName = active && box && box.contains(active) && active.name ? active.name : '';
  const sel = activeName ? [active.selectionStart, active.selectionEnd] : null;
  fn();
  if (!routeEdit || !box) return;
  const nbox = document.querySelector('[data-route-edit]');
  if (!nbox) return;
  nbox.querySelectorAll('input').forEach(i => { if (i.name in vals) i.value = vals[i.name]; });
  if (activeName) {
    const n = nbox.querySelector(`[name="${CSS.escape(activeName)}"]`);
    if (n) { n.focus(); try { if (sel) n.setSelectionRange(sel[0], sel[1]); } catch { } }
  }
}
function focusRouteEdit() {
  setTimeout(() => { const el = document.querySelector('[data-route-edit] input'); if (el) el.focus(); }, 0);
}
function endpointBlock(kind, res) {
  const p = kind === 'start' ? routeStart(res) : routeEnd(res);
  const label = pointLabel(p);
  const title = kind === 'start' ? 'Start' : 'Ziel';
  const action = label ? `${title} ändern` : `${title} hinzufügen`;
  const editing = routeEdit === kind;
  const warn = p && p.approx ? '<div class="tags"><span class="tag warn">nur ungefähr gefunden</span></div>' : '';
  const form = `<div class="edit" data-route-edit>
      <input class="full" name="addr" placeholder="Straße Nr., PLZ Ort" value="${esc(label)}">
      <input class="full" name="coords" inputmode="decimal" placeholder="Koordinaten optional, z. B. 51.0504, 13.7373" value="">
      <div class="row"><button type="button" class="btn small secondary" data-act="canceledit">Abbrechen</button><button type="button" class="btn small" data-act="saveend">Übernehmen</button></div>
    </div>`;
  return `<div class="endpoint" data-end="${kind}">
    <div class="k">${title}</div>
    ${editing ? form : `<div class="a">${label ? esc(label) : '<i>Keine Adresse</i>'}</div>${warn}<button type="button" class="btn editbtn" data-act="editend">${action}</button>`}
  </div>`;
}
function stopEditForm(s) {
  return `<div class="edit" data-route-edit>
    <input class="full" name="kunde" placeholder="Kunde" value="${esc(s.kunde)}">
    <input class="full" name="strasse" placeholder="Straße und Hausnr." value="${esc(s.strasse)}">
    <input name="plz" placeholder="PLZ" inputmode="numeric" value="${esc(s.plz)}">
    <input name="ort" placeholder="Ort" value="${esc(s.ort)}">
    <input name="auftrag" placeholder="Auftrag" value="${esc(s.auftrag)}">
    <input name="kategorie" placeholder="Kategorie" value="${esc(s.kategorie)}">
    <input class="full" name="coords" inputmode="decimal" placeholder="Koordinaten optional, z. B. 51.0504, 13.7373" value="">
    <div class="row"><button type="button" class="btn small secondary" data-act="canceledit">Abbrechen</button><button type="button" class="btn small" data-act="savestop">Übernehmen</button></div>
  </div>`;
}
function openStopEdit(index) {
  if (routeSaving || !state.result || !state.result.stops || !state.result.stops[index]) return;
  routeEdit = 'stop|' + index;
  renderResult();
  focusRouteEdit();
  const row = document.querySelector(`#routeList .rstop[data-i="${index}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function editFirstStop() {
  if (!state.result || !state.result.stops || !state.result.stops.length) {
    if (state.result) toast('Diese Tour hat keinen Stopp.');
    return;
  }
  openStopEdit(0);
}
function firstStopBox(res) {
  const host = $('#firstStop');
  if (!host) return;
  const s = res && res.stops && res.stops[0];
  if (!s) { host.innerHTML = ''; return; }
  const who = s.kunde || s.auftrag || 'Stopp 1';
  host.innerHTML = `<div class="firststop">
    <div class="k">Erster Stopp</div>
    <div class="who">${esc(who)}</div>
    <div class="a">${esc(addrText(s)) || '<i>keine Adresse</i>'}</div>
    <button type="button" class="btn firstbtn" data-act="editfirst">Ersten Stopp bearbeiten</button>
    <p class="note">Der erste Kunde. Nicht die Startadresse. In der Liste nach rechts wischen.</p>
  </div>`;
}
async function removeRouteStop(index) {
  if (routeSaving || !state.result || !state.result.stops || !state.result.stops[index]) return;
  const res = state.result;
  const removed = res.stops[index];
  res.stops.splice(index, 1);
  if (routeEdit && routeEdit.startsWith('stop|')) {
    const ei = +routeEdit.slice(5);
    if (ei === index) routeEdit = null;
    else if (ei > index) routeEdit = 'stop|' + (ei - 1);
  }
  routeSaving = true;
  let ok = false;
  try {
    ok = await recomputeLegs(res);
    if (!ok) {
      res.legs = Array.from({ length: res.stops.length + 1 }, () => ({ dur: 0, dist: 0 }));
      res.geometry = null;
      res.totalDur = 0;
      res.totalDist = 0;
    }
    mapFor = null;
    saveResult(res);
    renderStops();
    renderResult();
    renderTours();
    toast(ok ? `${label(removed)} entfernt. Zeiten neu berechnet.` : `${label(removed)} entfernt. Die Fahrzeit konnte nicht neu berechnet werden.`, ok ? 3200 : 5000);
  } finally { routeSaving = false; }
}
function routeSaveBox() {
  const host = $('#routeSave');
  if (!host) return;
  if (!drafting()) { host.innerHTML = ''; return; }
  host.innerHTML = `<p class="note">Änderungen gelten erst nach Speichern.</p>
    <button type="button" class="btn savebtn" data-act="save-route">Speichern</button>
    <button type="button" class="btn secondary discardbtn" data-act="discard-route">Verwerfen</button>`;
}
function renderResult() { keepNoteEditing(() => keepRouteEditing(renderResultInner)); }
function renderResultInner() {
  const res = state.result, sec = $('#resultSection');
  if (!res) { routeEdit = null; routeEditTour = null; sec.hidden = true; mapFor = null; const host = $('#firstStop'); if (host) host.innerHTML = ''; const saveHost = $('#routeSave'); if (saveHost) saveHost.innerHTML = ''; return; }
  if (routeEditTour !== res.id) { routeEdit = null; routeEditTour = res.id; }
  if (applyRememberedDone(res.stops)) saveResult(res);
  sec.hidden = false;
  const S = computeSchedule(res);
  const doneN = res.stops.filter(s => s.done).length;
  $('#resultMeta').textContent = res.name ? (res.datum ? `${res.name} · ${res.datum}` : res.name) : `${res.driverName} · ${res.datum}`;
  $('#totals').innerHTML = `<div><b>${fmtKm(res.totalDist)}</b><span>Strecke</span></div><div><b>${fmtMin(res.totalDur).replace(' Min.', ' m').replace(' Std.', ' h')}</b><span>Fahrzeit</span></div><div><b>${doneN ? doneN + '/' : ''}${res.stops.length}</b><span>${doneN ? 'erledigt' : 'Stopps'}</span></div>`;
  $('#tourCtl').innerHTML = `<label>Datum <input type="date" id="tourDate" value="${esc(datumToInput(res.datum))}"></label><label>Abfahrt <input type="time" id="tourStart" value="${esc(res.startTime || settings.startTime)}"></label><span>Zurück ca. <b>${hhmm(S.homeArr)}</b></span>`;
  routeSaveBox();
  const pts = routePoints(res);
  // Nächster Stopp
  if (S.next >= 0) {
    const s = res.stops[S.next], r = S.rows[S.next], p = pts[S.next + 1];
    $('#nextBox').innerHTML = `<div class="nb-l">Nächster Stopp</div><div class="nb-t"><span class="ordno">${esc(s.auftrag || '–')}</span> ${esc(s.kunde || addrText(s))}</div>
      <div class="nb-eta">Ankunft ca. <b>${hhmm(r.arr)}</b></div>
      <div class="navs"><a class="btn small gmaps" target="_blank" rel="noopener" href="${esc(googleStop(p))}">Google</a><a class="btn small amaps" target="_blank" rel="noopener" href="${esc(appleStop(p))}">Apple Karten</a></div>`;
    $('#nextBox').hidden = false;
  } else { $('#nextBox').innerHTML = `<div class="nb-l">Alle Stopps erledigt ✓</div><div class="nb-eta">Zurück ${hasExplicitDest(res) ? 'am Ziel' : 'zu Hause'} ca. <b>${hhmm(S.homeArr)}</b></div>`; $('#nextBox').hidden = false; }
  const ends = $('#endPoints');
  if (ends) ends.innerHTML = endpointBlock('start', res) + endpointBlock('dest', res) + '<p class="note endpoints-note">Nur diese Route. Die Fahrer-Adressen in den Einstellungen bleiben unverändert.</p>';
  firstStopBox(res);
  const g = chunk(pts, 9), a = chunk(pts, 13);
  let html = '';
  html += `<div class="row">${g.map((p, i) => `<a class="btn gmaps" target="_blank" rel="noopener" href="${esc(googleUrl(p))}">Google Maps${g.length > 1 ? ` ${i + 1}/${g.length}` : ''}</a>`).join('')}</div>`;
  if (g.length > 1) html += `<div class="lbl">Google erlaubt max. 9 Zwischenziele pro Link – Teil 2 startet bei ${esc(g.slice(1).map(p => shortName(p[0], res)).join(', '))}.</div>`;
  html += `<div class="row">${a.map((p, i) => `<a class="btn amaps" target="_blank" rel="noopener" href="${esc(appleUrl(p))}">Apple Karten${a.length > 1 ? ` ${i + 1}/${a.length}` : ''}</a>`).join('')}</div>`;
  html += '<div class="lbl">Apple-Gesamtroute benötigt iOS 18.4 oder neuer. Sonst die Einzel-Links je Stopp verwenden.</div>';
  $('#routeBtns').innerHTML = html;
  const rows = res.stops.map((s, i) => {
    const l = res.legs[i] || { dur: 0, dist: 0 }; const p = pts[i + 1], r = S.rows[i], isNext = i === S.next;
    const eta = r.done ? `<div class="eta done">✓ Erledigt um ${hhmm(r.dep)}</div>`
      : `<div class="eta">${isNext ? '<span class="nexttag">Als Nächstes</span> ' : ''}Ankunft ca. <b>${hhmm(r.arr)}</b> <span class="muted">· weiter ${hhmm(r.dep)}</span></div>`;
    const editing = routeEdit === 'stop|' + i;
    return `<li class="stop rstop swipe${r.done ? ' isdone' : ''}${isNext ? ' isnext' : ''}" data-i="${i}">
      <div class="swipe-bg" aria-hidden="true"><span class="swipe-hint edit">Bearbeiten</span><span class="swipe-hint remove">Entfernen</span></div>
      <div class="swipe-face"><div class="badge">${r.done ? '✓' : i + 1}</div>
      ${eta}
      <div class="ordline"><span class="ordno">${esc(s.auftrag || 'ohne Nr.')}</span>${s.kategorie ? `<span class="cat">${esc(s.kategorie)}</span>` : ''}${s.typ && /termin/i.test(s.typ) ? `<span class="tag termin">${esc(s.typ)}</span>` : ''}</div>
      ${editing ? stopEditForm(s) : `${s.kunde ? `<div class="k">${esc(s.kunde)}</div>` : ''}
      <div class="a">${esc(addrText(s)) || '<i>keine Adresse</i>'}</div>`}
      <div class="leg">🚗 ${fmtMin(l.dur)} · ${fmtKm(l.dist)} Anfahrt</div>
      ${noteHtml(s, 'route|' + i)}
      ${r.done ? '' : hoursHtml(s, r, res)}
      <div class="stopctl">
        ${r.done ? `<button class="btn small secondary" data-act="undo">↶ Rückgängig</button>` : `<label class="onsite">Vor Ort <input type="number" min="0" max="600" inputmode="numeric" data-act="onsite" value="${onsiteOf(s)}"> Min.</label><button class="btn small donebtn" data-act="done">✓ Erledigt</button>`}
      </div>
      ${r.done ? '' : `<div class="navlbl">Navigation zu ${esc(label(s))}</div><div class="navs"><a class="btn small gmaps" target="_blank" rel="noopener" href="${esc(googleStop(p))}">Google</a><a class="btn small amaps" target="_blank" rel="noopener" href="${esc(appleStop(p))}">Apple Karten</a></div>`}
    </div></li>`;
  });
  const lb = res.legs[res.stops.length] || { dur: 0, dist: 0 };
  const endPt = pts[pts.length - 1];
  const endTitle = hasExplicitDest(res) ? 'Ziel' : 'Zurück nach Hause';
  rows.push(`<li class="stop rstop"><div class="badge" style="background:var(--green);color:#000">${hasExplicitDest(res) ? 'Z' : '⌂'}</div><div class="eta">${hasExplicitDest(res) ? 'Ziel ca.' : 'Zurück ca.'} <b>${hhmm(S.homeArr)}</b></div><div class="k">${endTitle}</div><div class="a">${esc(pointLabel(routeEnd(res)))}</div><div class="leg">🚗 ${fmtMin(lb.dur)} · ${fmtKm(lb.dist)}</div>
    <div class="navs"><a class="btn small gmaps" target="_blank" rel="noopener" href="${esc(googleStop(endPt))}">Google</a><a class="btn small amaps" target="_blank" rel="noopener" href="${esc(appleStop(endPt))}">Apple Karten</a></div></li>`);
  $('#routeList').innerHTML = rows.join('');
  if (mapFor !== res.id) { mapFor = res.id; renderMap(res); }
}
function shortName(p, res) {
  const s = res.stops.find(x => addrText(x) === p.addr); if (!s) return p.addr; const k = s.kunde.length > 22 ? s.kunde.slice(0, 21) + '…' : s.kunde; return (s.auftrag ? s.auftrag + ' · ' : '') + s.ort + (k ? ` (${k})` : '');
}
function renderMap(res) {
  const start = routeStart(res), end = routeEnd(res);
  const samePoint = hasPos(start) && hasPos(end) && Math.abs(start.lat - end.lat) < 1e-5 && Math.abs(start.lon - end.lon) < 1e-5;
  const separateEnd = hasExplicitDest(res) && hasPos(end) && !samePoint;
  const ll = [[start.lat, start.lon], ...res.stops.map(s => [s.geo?.lat, s.geo?.lon])];
  if (separateEnd) ll.push([end.lat, end.lon]);
  if (typeof L === 'undefined' || ll.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b))) { $('#map').hidden = true; return; }
  $('#map').hidden = false;
  if (!map) {
    map = L.map('map', { zoomControl: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
  }
  if (mapLayer) mapLayer.remove();
  mapLayer = L.layerGroup().addTo(map);
  if (res.geometry) L.polyline(res.geometry, { color: '#0a84ff', weight: 4, opacity: .9 }).addTo(mapLayer);
  else L.polyline(separateEnd ? ll : [...ll, ll[0]], { color: '#0a84ff', weight: 3, dashArray: '6 6' }).addTo(mapLayer);
  L.marker(ll[0], { icon: L.divIcon({ className: 'num-marker home', html: separateEnd ? 'S' : '⌂' }) }).addTo(mapLayer);
  res.stops.forEach((s, i) => L.marker(ll[i + 1], { icon: L.divIcon({ className: 'num-marker', html: String(i + 1) }) }).bindPopup(esc(label(s))).addTo(mapLayer));
  if (separateEnd) L.marker(ll[ll.length - 1], { icon: L.divIcon({ className: 'num-marker home', html: 'Z' }) }).addTo(mapLayer);
  setTimeout(() => { map.invalidateSize(); map.fitBounds(L.latLngBounds(ll), { padding: [24, 24] }); }, 50);
}
function renderTours() {
  const ul = $('#tourList');
  if (!tours.length) { ul.innerHTML = '<li class="empty">Noch keine Touren geplant.</li>'; return; }
  ul.innerHTML = tours.map(t => { const dn = t.stops.filter(s => s.done).length;
    const title = t.name ? (t.datum ? `${esc(t.name)} · ${esc(t.datum)}` : esc(t.name)) : `${esc(t.driverName)} · ${esc(t.datum)}`;
    return `<li class="tour" data-tid="${t.id}">
    <div><div class="t">${title}</div><div class="s">${t.stops.length} Stopps${dn ? ` (${dn} erledigt)` : ''} · ${fmtKm(t.totalDist)} · ${fmtMin(t.totalDur)}</div>
    <div class="s ords">Aufträge: ${t.stops.map(s => esc(s.auftrag || '–')).join(', ')}</div></div>
    <div style="display:flex;gap:6px"><button class="btn small secondary" data-act="open">Öffnen</button><button class="icon del" data-act="deltour" aria-label="Löschen">✕</button></div></li>`; }).join('');
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
function bindStopSwipe(list) {
  if (!list) return;
  let drag = null;
  const faceOf = li => li.querySelector('.swipe-face');
  const moveFace = (li, dx) => {
    const face = faceOf(li);
    if (!face) return 0;
    const max = Math.min(148, Math.max(96, li.clientWidth * 0.42));
    const x = Math.max(-max, Math.min(max, dx));
    face.style.transform = `translate3d(${x}px,0,0)`;
    li.classList.toggle('reveal-edit', x > 24);
    li.classList.toggle('reveal-remove', x < -24);
    return x;
  };
  const resetFace = li => {
    const face = faceOf(li);
    if (face) { face.classList.remove('dragging'); face.style.transform = ''; }
    li.classList.remove('reveal-edit', 'reveal-remove');
  };
  list.addEventListener('pointerdown', e => {
    if ((e.button != null && e.button !== 0) || routeSaving) return;
    if (e.target.closest('input, textarea, button, a, select, label, .edit')) return;
    const li = e.target.closest('.rstop.swipe[data-i]');
    if (!li || !state.result) return;
    if (routeEdit === 'stop|' + li.dataset.i) return;
    if (drag) resetFace(drag.li);
    drag = { li, id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, lock: null };
  });
  document.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.lock) {
      if (Math.hypot(dx, dy) < 12) return;
      drag.lock = Math.abs(dx) > Math.abs(dy) * 1.15 ? 'h' : 'v';
      if (drag.lock === 'v') { drag = null; return; }
      faceOf(drag.li)?.classList.add('dragging');
    }
    if (drag.lock !== 'h') return;
    if (e.cancelable) e.preventDefault();
    drag.dx = dx;
    moveFace(drag.li, dx);
  }, { passive: false, capture: true });
  const finish = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    const { li, dx, lock } = drag;
    drag = null;
    if (lock === 'h' && Math.abs(dx) > 10) list._suppressClickUntil = Date.now() + 500;
    if (lock !== 'h') { resetFace(li); return; }
    const need = Math.min(84, Math.max(64, li.clientWidth * 0.28));
    resetFace(li);
    if (dx >= need) openStopEdit(+li.dataset.i);
    else if (dx <= -need) removeRouteStop(+li.dataset.i);
  };
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
}
function bind() {
  $('#today').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#driverSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (drafting()) abandonDraft(); else keepShownTour();
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
    if (drafting()) abandonDraft(); else keepShownTour();
    state.stops = []; state.firstId = null; state.result = null; saveState(); render();
  });
  $('#stopList').addEventListener('click', e => {
    if (handleNoteClick(e)) return;
    if (e.target.closest('.dnote')) return;
    const li = e.target.closest('.stop'); if (!li) return;
    const s = state.stops.find(x => x.id === li.dataset.id); if (!s) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'del') { if (drafting()) abandonDraft(); else keepShownTour(); state.stops = state.stops.filter(x => x !== s); if (state.firstId === s.id) state.firstId = null; state.result = null; }
    else if (act === 'edit') state.editing = state.editing === s.id ? null : s.id;
    else if (act === 'cancel') state.editing = null;
    else if (act === 'save') {
      const box = li.querySelector('[data-edit]'); const old = addrText(s);
      box.querySelectorAll('input').forEach(i => s[i.name] = i.value.trim());
      if (addrText(s) !== old) { s.geo = null; s.geoErr = null; }
      if (drafting()) abandonDraft(); else keepShownTour();
      state.editing = null; state.result = null;
    } else if (e.target.closest('[data-edit]')) return;
    else { if (drafting()) abandonDraft(); else keepShownTour(); state.firstId = state.firstId === s.id ? null : s.id; state.result = null; }
    saveState(); renderStops(); renderResult();
  });
  $('#planBtn').addEventListener('click', plan);
  $('#printRoute').addEventListener('click', () => {
    printRoute().catch(e => { if (e && e.name === 'AbortError') return; console.error(e); toast('Drucken fehlgeschlagen'); });
  });
  $('#firstStop').addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !state.result) return;
    if (b.dataset.act === 'editfirst') editFirstStop();
  });
  bindStopSwipe($('#routeList'));
  $('#endPoints').addEventListener('click', e => {
    const b = e.target.closest('[data-act]'); const box = e.target.closest('[data-end]');
    if (!b || !box || !state.result) return;
    const act = b.dataset.act;
    if (act === 'editend') { routeEdit = box.dataset.end; renderResult(); focusRouteEdit(); }
    else if (act === 'canceledit') { routeEdit = null; renderResult(); }
    else if (act === 'saveend') saveEndpoint(box);
  });
  $('#stopList').addEventListener('focusout', handleNoteBlur);
  $('#routeList').addEventListener('focusout', handleNoteBlur);
  $('#notesList').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act; const li = e.target.closest('.nitem'); if (!act || !li) return;
    const n = notes[li.dataset.key]; if (!n || n.deleted) return;
    if (act === 'nl-edit') noteListEdit = n.key;
    else if (act === 'nl-cancel') noteListEdit = null;
    else if (act === 'nl-save') { const v = li.querySelector('textarea').value; if (v.trim()) { n.text = v.replace(/\s+$/, ''); n.updated = Date.now(); } else delNote(n.key); saveNotes(); noteListEdit = null; rerenderNotes(); toast('Notiz gespeichert'); }
    else if (act === 'nl-del') { if (!confirm(`Notiz für „${n.name}“ löschen?`)) return; delNote(n.key); saveNotes(); rerenderNotes(); }
    renderNotesList();
  });
  $('#exportNotes').addEventListener('click', exportNotes);
  $('#importNotes').addEventListener('change', e => { const f = e.target.files[0]; if (f) importNotes(f); e.target.value = ''; });
  $('#importTour').addEventListener('change', e => { const f = e.target.files[0]; if (f) importTourFile(f); e.target.value = ''; });
  renderNotesList();
  $('#routeList').addEventListener('click', e => {
    if ($('#routeList')._suppressClickUntil > Date.now()) { $('#routeList')._suppressClickUntil = 0; e.preventDefault(); e.stopPropagation(); return; }
    if (handleNoteClick(e)) return;
    const b = e.target.closest('[data-act]'); const li = e.target.closest('.rstop'); if (!b || !li || !state.result) return;
    const act = b.dataset.act;
    if (act === 'canceledit') { routeEdit = null; renderResult(); return; }
    if (act === 'savestop') { saveRouteStop(li); return; }
    const s = state.result.stops[+li.dataset.i]; if (!s) return;
    if (act === 'done') {
      const mem = memoryTime(s);
      s.done = mem || Date.now();
      draftUndo.delete(draftKey(s));
      if (!drafting()) { rememberDoneStop(s); saveDoneMemory(); }
      toast(`${label(s)} erledigt – Zeiten neu berechnet`);
    }
    else if (act === 'undo') {
      s.done = null;
      if (drafting()) draftUndo.add(draftKey(s));
      else forgetDoneStop(s);
    }
    else if (b.dataset.act === 'retryhours') { fetchHoursForResult(state.result, false); return; }
    else return;
    if (!drafting()) saveResult();
    renderResult(); renderTours();
  });
  $('#routeList').addEventListener('change', e => {
    if (e.target.dataset.act !== 'onsite' || !state.result) return;
    const s = state.result.stops[+e.target.closest('.rstop').dataset.i];
    s.onsite = Math.max(0, Math.min(600, parseInt(e.target.value, 10) || 0));
    if (!drafting()) saveResult();
    renderResult();
  });
  $('#tourCtl').addEventListener('change', e => {
    if (!state.result) return;
    if (e.target.id === 'tourDate') {
      const d = inputToDatum(e.target.value);
      if (d) state.result.datum = d;
      renderResult();
      return;
    }
    if (e.target.id !== 'tourStart') return;
    state.result.startTime = e.target.value || settings.startTime;
    if (!drafting()) saveResult();
    renderResult();
  });
  $('#routeSave').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'save-route') commitDraft();
    else if (act === 'discard-route') discardDraft();
  });
  $('#tourList').addEventListener('click', e => {
    const li = e.target.closest('.tour'); if (!li) return;
    const act = e.target.closest('[data-act]')?.dataset.act; const t = tours.find(x => x.id === li.dataset.tid);
    if (act === 'deltour') {
      if (drafting() && t && String(draftId) === String(t.id)) abandonDraft();
      tours = tours.filter(x => x !== t); LS.set('tp_tours', tours);
      if (state.result && t && String(state.result.id) === String(t.id)) { state.result = null; saveState(); renderResult(); }
      renderTours();
    }
    else if (act === 'open' && t) {
      if (!drafting()) keepShownTour();
      const saved = tours.find(x => x && String(x.id) === String(t.id)) || t;
      beginDraft(saved);
      renderResult(); renderTours(); fetchHoursForResult(state.result); $('#resultSection').scrollIntoView({ behavior: 'smooth' });
    }
  });
  $('#coordLinks').checked = !!settings.coordLinks;
  $('#googleKey').value = settings.googleKey || '';
  $('#toggleKey').addEventListener('click', () => { const i = $('#googleKey'); i.type = i.type === 'password' ? 'text' : 'password'; });
  $('#defStart').value = settings.startTime || '05:30'; $('#defOnsite').value = settings.onsite ?? 5;
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
    const newKey = $('#googleKey').value.trim();
    if (newKey !== (settings.googleKey || '')) { settings.googleKey = newKey; googleWarned = false; if (state.result) state.result.stops.forEach(x => { x.gTried = false; if (x.hours && x.hours.source !== 'google') x.hours = null; }); hoursCache = {}; LS.set('tp_hours', {}); }
    settings.startTime = $('#defStart').value || '05:30';
    settings.onsite = Math.max(0, parseInt($('#defOnsite').value, 10) || 0);
    saveSettingsLS(); if (!getDriver() || !settings.drivers.some(d => d.name === state.driver)) state.driver = getDriver().name;
    saveState(); renderDriverFields(); renderDriver(); renderResult(); toast('Gespeichert');
    window.dispatchEvent(new Event('tp-settings-saved'));
  });
  $('#clearCache').addEventListener('click', () => { geoCache = {}; LS.set('tp_geocache', {}); state.stops.forEach(s => { s.geo = null; s.geoErr = null; }); saveState(); renderStops(); toast('Adress-Cache geleert'); });
}

// #tour=<base64url(JSON)> ergänzt oder ersetzt genau eine gespeicherte Tour. Andere lokale Daten bleiben.
// Formen: {name, tour:{…}}, gespeicherte Tour {stops, home}, oder {name, stops} ohne fertige Tour.
let tourLoadNotice = null;
const tourLoadedMsg = info => `Route „${info.name}“ geladen: ${info.n} ${info.n === 1 ? 'Stopp' : 'Stopps'}`;
// Eine Tour ergänzen oder ersetzen. payload ist bereits geparstes JSON. null = ungültig, nichts geschrieben.
function applyImportedTour(payload) {
  const tour = tourFromHashPayload(payload);
  if (!tour) return null;
  if (!Array.isArray(tours)) tours = [];
  const name = tour.name || '';
  let idx = tour.id ? tours.findIndex(t => t && String(t.id) === String(tour.id)) : -1;
  if (idx < 0 && name) idx = tours.findIndex(t => t && String(t.name || '').trim() === name);
  if (idx >= 0) tours[idx] = tour;
  else { tours.unshift(tour); tours = tours.slice(0, 20); }
  rememberTourDone(tour);
  applyRememberedDone(tour.stops);
  LS.set('tp_tours', tours);
  state.result = tour;
  saveState();
  return { name: name || tour.driverName || 'Tour', n: tour.stops.length };
}
async function applyTourFromHash() {
  if (!tourHashSeen) return;
  if (tourHashBad) { tourLoadNotice = { ok: false }; return; }
  try {
    const payload = tourHashGzip ? await gunzipJson(tourHashGzip) : tourHashPayload;
    const info = applyImportedTour(payload);
    if (!info) throw new Error('kein Tour-Objekt');
    tourLoadNotice = { ok: true, name: info.name, n: info.n };
  } catch (e) {
    console.warn('Tour-Link ungültig', e);
    tourLoadNotice = { ok: false };
  }
}
async function importTourFile(file) {
  try {
    const data = JSON.parse(String(await file.text()).replace(/^\uFEFF/, ''));
    const info = applyImportedTour(data);
    if (!info) throw new Error('kein Tour-Objekt');
    render();
    if (state.result) fetchHoursForResult(state.result);
    toast(tourLoadedMsg(info), 4000);
    $('#resultSection').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    console.warn('Tour-Datei ungültig', e);
    toast('Tour-Datei ungültig');
  }
}
function tourFromHashPayload(cfg) {
  if (!isObj(cfg)) return null;
  const wrapName = cleanName(cfg.name);
  if (isObj(cfg.tour)) {
    const nm = wrapName || cleanName(cfg.tour.name);
    return fullTourOrNull(cfg.tour, nm) || (Array.isArray(cfg.tour.stops) ? lightTourOrNull(cfg.tour.stops, nm, cfg.tour) : null);
  }
  if (Array.isArray(cfg.stops) && isObj(cfg.home)) return fullTourOrNull(cfg, wrapName);
  if (Array.isArray(cfg.stops)) return lightTourOrNull(cfg.stops, wrapName, cfg);
  return null;
}
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function cleanName(v) { const s = v == null ? '' : String(v).trim(); return s || null; }
function numOrNull(v) { if (v == null || v === '') return null; const n = +v; return Number.isFinite(n) ? n : null; }
const txt = v => v == null ? '' : String(v);
function normalizeStops(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    if (!isObj(s)) continue;
    const geo = normalizeGeo(s.geo) || normalizeGeo(s);
    const done = s.done != null && s.done !== '' && typeof s.done !== 'boolean' && Number.isFinite(+s.done) ? +s.done : null;
    const stop = {
      auftrag: txt(s.auftrag), kategorie: txt(s.kategorie), datum: txt(s.datum), kunde: txt(s.kunde),
      plz: txt(s.plz), ort: txt(s.ort), strasse: txt(s.strasse), typ: txt(s.typ), betrag: txt(s.betrag),
      geo, onsite: s.onsite != null && s.onsite !== '' && Number.isFinite(+s.onsite) ? +s.onsite : null, done
    };
    if (s.id != null && String(s.id).trim()) stop.id = String(s.id).trim();
    out.push(stop);
  }
  return out;
}
function normalizeGeo(g) {
  if (!isObj(g)) return null;
  const lat = numOrNull(g.lat), lon = numOrNull(g.lon);
  if (lat == null || lon == null) return null;
  const geo = { lat, lon };
  if (g.approx != null) geo.approx = !!g.approx;
  if (g.label != null) geo.label = String(g.label);
  if (g.state != null) geo.state = String(g.state);
  return geo;
}
function normalizeLegs(legs) {
  if (!Array.isArray(legs)) return [];
  return legs.map(l => ({ dur: Number(l && l.dur) || 0, dist: Number(l && l.dist) || 0 }));
}
function normalizeGeometry(g) {
  if (!Array.isArray(g) || !g.length) return null;
  const pts = [];
  for (const p of g) {
    if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) return null;
    pts.push([+p[0], +p[1]]);
  }
  return pts;
}
function fullTourOrNull(src, name) {
  if (!isObj(src) || !Array.isArray(src.stops) || !isObj(src.home)) return null;
  const stops = normalizeStops(src.stops);
  if (!stops.length) return null;
  const legs = normalizeLegs(src.legs);
  const driverName = cleanName(src.driverName) || cleanName(src.driver) || '';
  const driver = cleanName(src.driver) || driverName;
  const tour = {
    id: cleanName(src.id) || uid(),
    created: Number.isFinite(+src.created) ? +src.created : Date.now(),
    driver, driverName,
    datum: cleanName(src.datum) || (stops.find(s => s.datum) || {}).datum || '',
    home: { addr: txt(src.home.addr), lat: numOrNull(src.home.lat), lon: numOrNull(src.home.lon), approx: !!src.home.approx },
    stops, legs, geometry: normalizeGeometry(src.geometry),
    startTime: cleanName(src.startTime) || settings.startTime || '05:30',
    totalDur: Number.isFinite(+src.totalDur) ? +src.totalDur : legs.reduce((a, l) => a + l.dur, 0),
    totalDist: Number.isFinite(+src.totalDist) ? +src.totalDist : legs.reduce((a, l) => a + l.dist, 0)
  };
  if (name) tour.name = name;
  return attachDest(tour, src);
}
function attachDest(tour, src) {
  if (!isObj(src) || !isObj(src.dest)) return tour;
  const dAddr = txt(src.dest.addr).trim();
  const dLat = numOrNull(src.dest.lat), dLon = numOrNull(src.dest.lon);
  if (dAddr || (dLat != null && dLon != null)) tour.dest = { addr: txt(src.dest.addr), lat: dLat, lon: dLon, approx: !!src.dest.approx };
  return tour;
}
function lightTourOrNull(stopsRaw, name, src) {
  const stops = normalizeStops(stopsRaw);
  if (!stops.length) return null;
  src = isObj(src) ? src : {};
  const driverName = cleanName(src.driverName) || cleanName(src.driver) || '';
  const driver = cleanName(src.driver) || driverName;
  const tour = {
    id: cleanName(src.id) || uid(),
    created: Number.isFinite(+src.created) ? +src.created : Date.now(),
    driver, driverName,
    datum: cleanName(src.datum) || (stops.find(s => s.datum) || {}).datum || '',
    home: { addr: '', lat: null, lon: null, approx: false },
    stops, legs: [], geometry: null,
    startTime: cleanName(src.startTime) || settings.startTime || '05:30',
    totalDur: 0, totalDist: 0
  };
  if (name) tour.name = name;
  return attachDest(tour, src);
}

function lockPageZoom() {
  const block = e => { if (e.cancelable) e.preventDefault(); };
  document.addEventListener('gesturestart', block, { passive: false });
  document.addEventListener('gesturechange', block, { passive: false });
  document.addEventListener('gestureend', block, { passive: false });
  document.addEventListener('touchmove', e => {
    if (e.touches && e.touches.length > 1) block(e);
  }, { passive: false });
}
function pinBottomBar() {
  const apply = () => {
    const vv = window.visualViewport;
    const gap = vv ? Math.max(0, window.innerHeight - vv.offsetTop - vv.height) : 0;
    document.documentElement.style.setProperty('--vv-bottom', gap + 'px');
  };
  apply();
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', apply);
  window.visualViewport.addEventListener('scroll', apply);
}
lockPageZoom();
pinBottomBar();

(async function boot() {
  await applyTourFromHash();
  seedDoneMemoryFromStored();
  if (state.result && state.result.id) {
    const saved = (tours || []).find(t => t && String(t.id) === String(state.result.id));
    if (saved) beginDraft(saved);
  }
  bind(); render();
  if (state.result) fetchHoursForResult(state.result);
  window.addEventListener('tp-settings-saved', () => { if (state.result) fetchHoursForResult(state.result); });
  if (tourLoadNotice) {
    toast(tourLoadNotice.ok ? tourLoadedMsg(tourLoadNotice) : 'Tour-Link ungültig', 4000);
    if (tourLoadNotice.ok) $('#resultSection').scrollIntoView({ behavior: 'smooth' });
  } else if (setupApplied) toast('Einrichtung übernommen: ' + settings.drivers.map(d => d.name).join(', '), 4000);
  else if (!getDriver()) openSettings();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  // für Tests
  window.TP = { VERSION, notes: () => notes, findNote, dealerKey, computeSchedule, nameScore, fetchHoursForResult, parseOrders, solveTour, chunk, googleUrl, appleUrl, state: () => state, tours: () => tours, handleFiles, plan, routeSheet, buildRoutePdf, printRoute, routeStart, routeEnd, render: () => render() };
  window.addEventListener('hashchange', () => { if (/[#&](setup|tour)=/.test(location.hash)) location.reload(); });
})();
