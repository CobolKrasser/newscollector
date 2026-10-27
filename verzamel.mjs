#!/usr/bin/env node
// Verzamelt nieuws voor flissebaalje.nl/nieuws/ (draait elk kwartier via GitHub Actions, zie
// .github/workflows/kwartier.yml).
//
// Deze repo is openbaar; de persoonlijke instellingen (rubrieken, bronnen, betaalmuursites) staan
// niet hier maar komen samen met de dataset van de (afgeschermde) API. Daarom logt dit script in
// GitHub Actions alleen aantallen; de details per run gaan mee naar de server en staan op de pagina.
//
// 1. Haalt de huidige dataset, de duimpjes en de instellingen op bij /nieuws/api.php (export, met NIEUWS_TOKEN).
// 2. Leest alle bronnen en kiest de berichten die nog niet bekeken zijn.
// 3. Laat Claude (Haiku 5.5) per bericht de rubriek kiezen, een feitelijke kop (geen clickbait)
//    en een samenvatting van twee regels schrijven, en een interessescore geven op basis van de duimpjes.
// 4. Stuurt de bijgewerkte dataset terug (import). Berichten ouder dan 7 dagen vallen eraf.
//
// Lokaal testen zonder server:
//   node verzamel.mjs --lokaal pad/naar/data.json --bronnen pad/naar/bronnen.mjs
// (leest en schrijft data.json; duimpjes staan dan in data.json onder "stemmen").
// Met --droog wordt Claude overgeslagen (kop = originele titel); handig om bronnen en de pagina te testen.
import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Komen uit de instellingen van de server (of --bronnen bij lokaal testen).
let RUBRIEKEN = {}, BRONNEN = [], BETAALMUUR = [], PROFIEL = "";

const MODEL = "claude-haiku-5-5";
const UA = "Mozilla/5.0 (compatible; FlissebaaljeNieuws/1.0; +https://flissebaalje.nl)";
const BEWAAR_MS = 7 * 24 * 3600e3;
const NIEUW_MS = 36 * 3600e3;       // oudere berichten uit een feed slaan we over
const STEMMEN_MS = 120 * 24 * 3600e3;
const BATCH = 12;
const CONCURRENCY = 3;
const MAX_NIEUW_PER_RUN = 400;
const PROEF_KANS = 0.12;            // kans dat een net-niet-bericht als proef getoond wordt
const DREMPEL = 55;
const inCI = !!process.env.GITHUB_ACTIONS;

/** Promise.allSettled met maximaal n tegelijk. */
async function beperkt(lijst, n, fn) {
  const uit = new Array(lijst.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < lijst.length) {
      const k = i++;
      try { uit[k] = { status: "fulfilled", value: await fn(lijst[k]) }; } catch (reason) { uit[k] = { status: "rejected", reason }; }
    }
  }));
  return uit;
}

const meldingen = []; // gaan mee naar de server (run.meldingen), niet naar het openbare logboek
const warn = (msg) => {
  meldingen.push(msg);
  if (!inCI) console.warn(`WAARSCHUWING: ${msg}`);
};
const log = (msg) => { if (!inCI) console.log(msg); };
const verslag = []; // samenvatting van deze run, zichtbaar onderaan de nieuwspagina
const meld = (msg) => { verslag.push(msg); log(msg); };

// ---------- Ophalen ----------
async function haal(url, { timeout = 15000, max = 3_000_000, accept, headers = {} } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "nl-NL,nl;q=0.9,en;q=0.8", ...(accept ? { Accept: accept } : {}), ...headers },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (res.status === 304) return { tekst: null, url: res.url, res };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { tekst: buf.subarray(0, max).toString("utf8"), url: res.url, res };
}

const ENTITEITEN = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", shy: "" };
function ontsleutel(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITEITEN[n.toLowerCase()] ?? m);
}
const cdata = (s) => String(s ?? "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const zonderTags = (s) => s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
// Twee keer: sommige feeds (GeenStijl) versleutelen de HTML in de beschrijving nog een keer.
const kaal = (html) => zonderTags(ontsleutel(zonderTags(cdata(html)))).replace(/\u00ad/g, "").replace(/\s+/g, " ").trim();

function tag(xml, naam) {
  const m = xml.match(new RegExp(`<${naam}(?:\\s[^>]*)?>([\\s\\S]*?)</${naam}>`, "i"));
  return m ? m[1] : "";
}

/** Eenvoudige RSS 2.0- en Atom-lezer voor de bekende feeds. */
function leesFeed(xml) {
  const items = [];
  const blokken = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blokken) {
    let link = kaal(tag(b, "link"));
    if (!link) {
      const alt = b.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*href=["']([^"']+)["']/i);
      link = alt ? ontsleutel(alt[1]) : "";
    }
    const datum = kaal(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date"));
    const ruw = tag(b, "description") || tag(b, "summary") || tag(b, "content:encoded") || tag(b, "content");
    const beschrijving = kaal(ruw);
    // Foto uit media:content/media:thumbnail, enclosure of de eerste <img> in de tekst
    const media = b.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i)
      || b.match(/<enclosure[^>]*type=["']image\/[^"']*["'][^>]*url=["']([^"']+)["']/i)
      || b.match(/<enclosure[^>]*url=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/i)
      || ontsleutel(cdata(ruw + tag(b, "content:encoded"))).match(/<img[^>]+src=["']([^"']+)["']/i);
    items.push({ titel: kaal(tag(b, "title")), link: link.trim(), datum, beschrijving, beeld: media ? ontsleutel(media[1]) : "" });
  }
  return items;
}

/** Bing Nieuws verwijst via apiclick.aspx; de echte URL staat in de parameter url. */
function bingLink(link) {
  try {
    const u = new URL(link);
    return u.searchParams.get("url") || link;
  } catch { return link; }
}

function schoneUrl(link) {
  try {
    const u = new URL(link);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|cmpid|at_)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.href;
  } catch { return link; }
}

const domein = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
const achterBetaalmuur = (url) => { const d = domein(url); return BETAALMUUR.some((b) => d === b || d.endsWith("." + b)); };

function tijd(datum, nu) {
  const t = Date.parse(datum);
  if (!Number.isFinite(t) || t > nu + 5 * 60e3) return nu;
  return t;
}

const INTERVAL = { rss: 15, bing: 60, dumpert: 30 }; // minuten, per bron te overschrijven met "elke"

/**
 * Leest een bron, maar niet vaker dan het interval van die bron, en met If-None-Match/If-Modified-Since
 * zodat ongewijzigde feeds alleen een 304 kosten. staat[bron.id] = { t, etag, lm }.
 */
async function leesBron(bron, nu, staat) {
  const st = staat[bron.id] || {};
  if (st.t && nu - st.t < ((bron.elke ?? INTERVAL[bron.soort]) - 3) * 60e3) return { overgeslagen: true, items: [] };
  staat[bron.id] = { ...st, t: nu };
  const items = await leesBronNu(bron, nu, staat[bron.id]);
  return { overgeslagen: items === null, items: items || [] };
}

async function leesBronNu(bron, nu, st) {
  if (bron.soort === "dumpert") {
    // Dumpert blokkeert GitHub-servers; daarom eerst via de eigen API op Strato, anders direct.
    let tekst;
    if (process.env.NIEUWS_API) {
      try {
        const res = await fetch(`${process.env.NIEUWS_API}?a=dumpert`, {
          headers: { "X-Nieuws-Token": process.env.NIEUWS_TOKEN, "User-Agent": UA },
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        tekst = await res.text();
      } catch (err) {
        warn(`Dumpert via de eigen server mislukt (${err.message}); direct proberen.`);
      }
    }
    tekst ??= (await haal(bron.url, { accept: "application/json" })).tekst;
    const data = JSON.parse(tekst);
    return (data.items || []).slice(0, 10).map((it, i) => ({
      bron, plek: i + 1,
      titel: kaal(it.title),
      link: `https://www.dumpert.nl/item/${encodeURIComponent(it.id)}`,
      t: tijd(it.date, nu),
      beschrijving: kaal(it.description),
      beeld: [it.stills?.["still-large"], it.stills?.still, it.still, it.thumbnail].find((u) => typeof u === "string" && u.startsWith("https://media.dumpert.nl/")),
    }));
  }
  const voorwaarden = {};
  if (st.etag) voorwaarden["If-None-Match"] = st.etag;
  if (st.lm) voorwaarden["If-Modified-Since"] = st.lm;
  const { tekst, res } = await haal(bron.url, { headers: voorwaarden });
  if (tekst === null) return null; // 304: niets nieuws
  st.etag = res.headers.get("etag") || undefined;
  st.lm = res.headers.get("last-modified") || undefined;
  return leesFeed(tekst)
    .slice(0, bron.max || 60)
    .map((it) => ({
      bron,
      titel: it.titel,
      link: schoneUrl(bron.soort === "bing" ? bingLink(it.link) : it.link),
      t: tijd(it.datum, nu),
      beschrijving: it.beschrijving.slice(0, 900),
      beeld: veiligBeeld(it.beeld, it.link),
    }))
    .filter((it) => it.titel && /^https?:\/\//.test(it.link));
}

/** Alleen absolute https-afbeeldingen (relatieve paden worden opgelost tegen de artikel-URL). */
function veiligBeeld(src, basis) {
  if (!src) return "";
  try {
    const u = new URL(ontsleutel(src).trim(), basis);
    if (u.protocol !== "https:" || u.href.length > 1000) return "";
    if (/\.(svg|gif)(\?|$)/i.test(u.pathname) || /(logo|avatar|placeholder|pixel|spacer)/i.test(u.pathname)) return "";
    return u.href;
  } catch { return ""; }
}

function meta(html, namen) {
  for (const naam of namen) {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${naam}["'][^>]+content=["']([^"']*)["']`, "i"))
      || html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${naam}["']`, "i"));
    if (m && m[1].trim()) return m[1];
  }
  return "";
}

/** Platte artikeltekst: articleBody uit JSON-LD, anders de alinea's in <article> (of de hele pagina). */
function artikelTekst(html) {
  const body = html.match(/"articleBody"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (body) {
    try { const t = kaal(JSON.parse(`"${body[1]}"`)); if (t.length > 200) return t.slice(0, 2500); } catch {}
  }
  let deel = html.replace(/<(script|style|nav|header|footer|aside|form|figure|noscript)[\s\S]*?<\/\1>/gi, " ");
  const art = deel.match(/<article[\s>][\s\S]*<\/article>/i);
  if (art) deel = art[0];
  const alineas = (deel.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(kaal).filter((p) => p.length > 60);
  let tekst = "";
  for (const p of alineas) {
    if (tekst.length + p.length > 2500) break;
    tekst += p + "\n";
  }
  return tekst.trim();
}

/**
 * Haalt de artikelpagina op: betaalmuurcontrole (schema.org isAccessibleForFree), hoofdfoto (og:image)
 * en de artikeltekst voor de uitgebreide samenvatting. false = achter een betaalmuur.
 * streng: ook op paywall-classes letten (voor onbekende sites uit Bing Nieuws).
 */
async function verrijk(it, streng) {
  try {
    const { tekst, url } = await haal(it.link, { timeout: 8000, max: 800_000, accept: "text/html" });
    if (achterBetaalmuur(url)) return false;
    // Doorgestuurd naar een cookie- of privacymuur (bv. DPG bij Tweakers): link houden, pagina negeren.
    const van = domein(it.link), naar = domein(url);
    if (naar !== van && !naar.endsWith("." + van) && !van.endsWith("." + naar)) return true;
    if (/consent|privacygate|cookiewall/i.test(url)) return true;
    if (/"isAccessibleForFree"\s*:\s*"?false/i.test(tekst)) return false;
    if (streng && /class=["'][^"']*(paywall|premium-content|piano-paywall)/i.test(tekst) && !/"isAccessibleForFree"\s*:\s*"?true/i.test(tekst)) return false;
    const og = kaal(meta(tekst, ["og:description", "description"]));
    if (og.length > it.beschrijving.length) it.beschrijving = og.slice(0, 900);
    it.beeld = veiligBeeld(meta(tekst, ["og:image", "og:image:url", "twitter:image"]), url) || it.beeld;
    it.tekst = artikelTekst(tekst);
    it.link = schoneUrl(url);
    return true;
  } catch {
    return true; // niet bereikbaar vanaf de runner: domeinlijst is dan de enige controle
  }
}

// ---------- Duimpjes en voorkeuren ----------
function woorden(s) {
  return new Set(String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 2));
}
function gelijkenis(a, b) {
  let gemeen = 0;
  for (const w of a) if (b.has(w)) gemeen++;
  return gemeen / Math.max(1, Math.min(a.size, b.size));
}

function voorkeurTekst(stemmen) {
  const perRubriek = {};
  for (const s of Object.values(stemmen).sort((a, b) => b.t - a.t)) {
    if (!RUBRIEKEN[s.cat]) continue;
    const r = (perRubriek[s.cat] ||= { op: [], neer: [] });
    const lijst = s.v > 0 ? r.op : r.neer;
    if (lijst.length < 15) lijst.push(s.kop);
  }
  const regels = [];
  for (const [cat, r] of Object.entries(perRubriek)) {
    if (r.op.length) regels.push(`[${cat}] 👍 interessant gevonden:\n${r.op.map((k) => `  - ${k}`).join("\n")}`);
    if (r.neer.length) regels.push(`[${cat}] 👎 niet interessant gevonden:\n${r.neer.map((k) => `  - ${k}`).join("\n")}`);
  }
  return regels.length ? regels.join("\n") : "(nog geen duimpjes gegeven)";
}

/** Drempel per rubriek: veel duimpjes omlaag = strenger, veel omhoog = ruimer. */
function drempels(stemmen) {
  const tel = {};
  for (const s of Object.values(stemmen)) {
    const t = (tel[s.cat] ||= { op: 0, neer: 0 });
    s.v > 0 ? t.op++ : t.neer++;
  }
  const uit = {};
  for (const cat of Object.keys(RUBRIEKEN)) {
    const t = tel[cat] || { op: 0, neer: 0 };
    const n = t.op + t.neer;
    uit[cat] = n < 5 ? DREMPEL : Math.round(DREMPEL + 20 * (t.neer - t.op) / n);
  }
  return uit;
}

// ---------- Claude ----------
const schema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["berichten"],
  properties: {
    berichten: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["nr", "rubriek", "kop", "samenvatting", "uitgebreid", "score", "reclame", "dubbel_van"],
        properties: {
          nr: { type: "integer" },
          rubriek: { type: "string", enum: [...Object.keys(RUBRIEKEN), "geen"] },
          kop: { type: "string" },
          samenvatting: { type: "string" },
          uitgebreid: { type: "string" },
          score: { type: "integer" },
          reclame: { type: "boolean" },
          dubbel_van: { type: ["string", "null"] },
        },
      },
    },
  },
});

function systeemPrompt(stemmen) {
  const rubrieken = Object.entries(RUBRIEKEN)
    .map(([id, r]) => `- ${id} (${r.label}; ${r.modus === "alles" ? "ALLE berichten van de bron horen erbij" : "alleen als het past"}): ${r.omschrijving}`)
    .join("\n");
  return `Je bent de nieuwsredacteur van een persoonlijke nieuwspagina. Over de lezer: ${PROFIEL || "(geen profiel opgegeven)"} Je krijgt nieuwe berichten uit RSS-feeds en geeft per bericht een beoordeling.

Rubrieken:
${rubrieken}

Per bericht:
- rubriek: kies uit de kandidaat-rubrieken van dat bericht. Past het bij geen enkele kandidaat, kies dan "geen". Bij een bron met één "alles"-rubriek kies je altijd die rubriek.
- kop: een feitelijke Nederlandse kop van maximaal 90 tekens die het echte onderwerp noemt. Geen clickbait, geen vragen, geen "dit", "zo", "je gelooft nooit", geen uitroeptekens. Bij een clickbaitkop zet je het eigenlijke nieuws in de kop (wie, wat, hoeveel). Engelse berichten vertaal je. Namen, merken en productnamen blijven ongewijzigd.
- samenvatting: Nederlands, to-the-point, maximaal twee korte zinnen (samen hooguit 220 tekens). Alleen feiten uit het bericht; verzin niets. Is er weinig informatie, houd het dan kort.
- uitgebreid: Nederlands, de kern van het hele artikel in 3 tot 6 zinnen (hooguit 750 tekens): wat er gebeurd is, de belangrijkste cijfers en namen, en waarom het ertoe doet. Gebruik de artikeltekst. Alleen feiten uit het bericht; herhaal de korte samenvatting niet letterlijk. Is er alleen een korte tekst, schrijf dan alleen wat erin staat (desnoods één zin).
- score: 0-100, hoe interessant dit bericht voor de lezer is binnen de gekozen rubriek. Gebruik de omschrijving van de rubriek en vooral de duimpjes hieronder. 70+ = duidelijk interessant, 40-55 = twijfel, onder 30 = niet interessant. Clickbait, opgeklopte verhalen en kleine bijzaken scoren laag.
- reclame: true bij advertorials, gesponsorde berichten, kortingsacties, deals, winacties en affiliate-artikelen ("de beste ... om nu te kopen").
- dubbel_van: als het bericht over precies hetzelfde nieuws gaat als een van de "mogelijke dubbelen" die erbij staan, geef dan diens id. Anders null.

Duimpjes van de lezer (meest recent eerst):
${voorkeurTekst(stemmen)}`;
}

async function beoordeel(client, systeem, batch) {
  const invoer = batch.map((it, i) => {
    const kandidaten = it.bron.rubrieken.join(", ");
    const dubbel = it.dubbelen.length ? `\nmogelijke dubbelen: ${it.dubbelen.map((d) => `[${d.id}] ${d.kop}`).join(" | ")}` : "";
    const artikel = it.tekst ? `\nartikeltekst: ${it.tekst}` : "";
    return `<bericht nr="${i}">\nbron: ${it.bron.naam} (${domein(it.link)})\nkandidaat-rubrieken: ${kandidaten}\ntitel: ${it.titel}\nbeschrijving: ${it.beschrijving || "(geen)"}${artikel}${dubbel}\n</bericht>`;
  }).join("\n\n");
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: "low", format: { type: "json_schema", schema: schema() } },
    system: systeem,
    messages: [{ role: "user", content: `Beoordeel deze ${batch.length} berichten. Geef voor elk nr precies één beoordeling.\n\n${invoer}` }],
  });
  if (response.stop_reason !== "end_turn") throw new Error(`stop_reason ${response.stop_reason}`);
  const tekst = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(tekst).berichten;
}

// ---------- Opslag ----------
async function laad(lokaal) {
  if (lokaal) {
    try { return JSON.parse(fs.readFileSync(lokaal, "utf8")); } catch { return {}; }
  }
  const res = await fetch(`${process.env.NIEUWS_API}?a=export`, {
    headers: { "X-Nieuws-Token": process.env.NIEUWS_TOKEN, "User-Agent": UA },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`export: HTTP ${res.status}`);
  return res.json();
}

async function bewaar(lokaal, data) {
  if (lokaal) {
    fs.writeFileSync(lokaal, JSON.stringify(data, null, 1));
    return;
  }
  const res = await fetch(`${process.env.NIEUWS_API}?a=import`, {
    method: "POST",
    headers: { "X-Nieuws-Token": process.env.NIEUWS_TOKEN, "Content-Type": "application/json", "Content-Encoding": "gzip", "User-Agent": UA },
    body: zlib.gzipSync(JSON.stringify(data)),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`import: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

const idVan = (url) => createHash("sha256").update(url).digest("base64url").slice(0, 12);

// ---------- Hoofdprogramma ----------
async function main() {
  const lokaalIdx = process.argv.indexOf("--lokaal");
  const lokaal = lokaalIdx > 0 ? process.argv[lokaalIdx + 1] : null;
  if (!lokaal && (!process.env.NIEUWS_API || !process.env.NIEUWS_TOKEN)) throw new Error("NIEUWS_API en NIEUWS_TOKEN ontbreken (of gebruik --lokaal <bestand>).");
  const droog = process.argv.includes("--droog");
  if (!droog && !process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY ontbreekt.");

  const nu = Date.now();
  const data = await laad(lokaal);
  const bronnenIdx = process.argv.indexOf("--bronnen");
  const config = bronnenIdx > 0
    ? await import(`${pathToFileURL(path.resolve(process.argv[bronnenIdx + 1])).href}?v=${nu}`)
    : data.config;
  if (!config?.BRONNEN?.length || !config.RUBRIEKEN) throw new Error("Geen instellingen ontvangen (config ontbreekt in de export, of geef --bronnen <bestand>).");
  ({ RUBRIEKEN, BRONNEN, BETAALMUUR = [], PROFIEL = "" } = config);
  const stemmen = Object.fromEntries(Object.entries(data.stemmen || {}).filter(([, s]) => nu - s.t < STEMMEN_MS));
  const staat = Object.fromEntries(Object.entries(data.bronnen || {}).filter(([id]) => BRONNEN.some((b) => b.id === id)));
  const gezien = Object.fromEntries(Object.entries(data.gezien || {}).filter(([, t]) => nu - t < BEWAAR_MS + NIEUW_MS));
  let items = (data.items || []).filter((it) => nu - Date.parse(it.t) < BEWAAR_MS);

  // 1. Bronnen lezen
  const resultaten = (await beperkt(BRONNEN, 8, (b) => leesBron(b, nu, staat)));
  const overgeslagen = resultaten.filter((r) => r.status === "fulfilled" && r.value.overgeslagen).length;
  const kandidaten = [];
  const perUrl = new Set();
  resultaten.forEach((r, i) => {
    if (r.status === "rejected") return warn(`Bron ${BRONNEN[i].id} niet gelezen: ${r.reason?.cause?.code || r.reason?.message || r.reason}`);
    for (const it of r.value.items) {
      if (gezien[it.link] || perUrl.has(it.link)) continue;
      if (nu - it.t > NIEUW_MS) continue;
      if (achterBetaalmuur(it.link)) { gezien[it.link] = nu; continue; }
      perUrl.add(it.link);
      kandidaten.push(it);
    }
  });
  kandidaten.sort((a, b) => b.t - a.t);
  const nieuw = kandidaten.slice(0, MAX_NIEUW_PER_RUN);
  // Wat deze run niet past, moet de volgende run nog zien: voor die bronnen geen 304 vragen.
  for (const it of kandidaten.slice(MAX_NIEUW_PER_RUN)) if (staat[it.bron.id]) { delete staat[it.bron.id].etag; delete staat[it.bron.id].lm; }
  meld(`Bronnen: ${resultaten.filter((r) => r.status === "fulfilled").length - overgeslagen}/${BRONNEN.length} opgehaald, ${overgeslagen} overgeslagen (interval of ongewijzigd), ${resultaten.filter((r) => r.status === "rejected").length} mislukt; ${nieuw.length} nieuwe berichten.`);

  // 2. Dumpert: geen beoordeling nodig, wel plek in de top 10 bijwerken
  const dumpert = nieuw.filter((it) => it.bron.soort === "dumpert");
  for (const it of dumpert) {
    gezien[it.link] = nu;
    items.push({ id: idVan(it.link), t: new Date(it.t).toISOString(), cat: "dumpert", kop: it.titel, sam: it.beschrijving.slice(0, 220), links: [{ bron: "Dumpert", url: it.link }], score: 50, plek: it.plek, ...(it.beeld ? { beeld: it.beeld } : {}) });
  }

  // 3. Artikelen ophalen: betaalmuur, hoofdfoto en tekst
  let teBeoordelen = nieuw.filter((it) => it.bron.soort !== "dumpert");
  const vrij = (await beperkt(teBeoordelen, 10, (it) => verrijk(it, it.bron.soort === "bing"))).map((r) => r.value !== false);
  const geblokkeerd = new Set(teBeoordelen.filter((_, i) => !vrij[i]));
  if (lokaal) for (const it of geblokkeerd) log(`  betaalmuur: ${it.link}`);
  for (const it of geblokkeerd) gezien[it.link] = nu;
  teBeoordelen = teBeoordelen.filter((it) => !geblokkeerd.has(it));
  meld(`Artikelen: ${teBeoordelen.filter((it) => it.tekst).length} met tekst, ${teBeoordelen.filter((it) => it.beeld).length} met foto, ${geblokkeerd.size} achter een betaalmuur overgeslagen.`);

  // 4. Mogelijke dubbelen zoeken (woordoverlap met berichten van de laatste 48 uur)
  const recent = items.filter((it) => nu - Date.parse(it.t) < 48 * 3600e3).map((it) => ({ it, w: woorden(`${it.orig || ""} ${it.kop}`) }));
  for (const it of teBeoordelen) {
    const w = woorden(it.titel);
    it.dubbelen = recent
      .filter((r) => r.it.cat !== "dumpert" && RUBRIEKEN[r.it.cat]?.kolom && it.bron.rubrieken.some((c) => RUBRIEKEN[c].kolom === RUBRIEKEN[r.it.cat].kolom))
      .map((r) => ({ r, s: gelijkenis(w, r.w) }))
      .filter((x) => x.s >= 0.34)
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map((x) => ({ id: x.r.it.id, kop: x.r.it.kop }));
  }

  // 5. Claude
  const client = droog ? null : new Anthropic();
  const systeem = systeemPrompt(stemmen);
  const drempel = drempels(stemmen);
  const batches = [];
  for (let i = 0; i < teBeoordelen.length; i += BATCH) batches.push(teBeoordelen.slice(i, i + BATCH));
  let geplaatst = 0, proef = 0, samengevoegd = 0, mislukt = 0, afgebroken = false;
  const perRubriek = {}; // rubriek -> { kandidaat, geplaatst }
  const perId = new Map(items.map((it) => [it.id, it]));

  async function verwerk(batch) {
    let oordelen;
    try {
      oordelen = droog
        ? batch.map((it, nr) => ({ nr, rubriek: it.bron.rubrieken[0], kop: it.titel, samenvatting: it.beschrijving.slice(0, 200), uitgebreid: (it.tekst || it.beschrijving).slice(0, 700), score: 40 + ((nr * 17) % 50), reclame: false, dubbel_van: null }))
        : await beoordeel(client, systeem, batch);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) afgebroken = true;
      mislukt += batch.length;
      warn(`Beoordeling mislukt (${batch.length} berichten): ${err.message}`);
      return; // niet als gezien markeren: volgende run opnieuw proberen
    }
    for (const o of oordelen) {
      const it = batch[o.nr];
      if (!it) continue;
      gezien[it.link] = nu;
      const rubriek = it.bron.rubrieken.includes(o.rubriek) ? o.rubriek : (RUBRIEKEN[it.bron.rubrieken[0]].modus === "alles" ? it.bron.rubrieken[0] : null);
      for (const c of it.bron.rubrieken) (perRubriek[c] ||= { kandidaat: 0, geplaatst: 0 }).kandidaat++;
      if (!rubriek || o.reclame) continue;
      const r = RUBRIEKEN[rubriek];
      const score = Math.max(0, Math.min(100, o.score | 0));
      const dubbel = o.dubbel_van && perId.get(o.dubbel_van);
      if (dubbel && RUBRIEKEN[dubbel.cat]?.kolom === r.kolom) {
        if (!dubbel.beeld && it.beeld) dubbel.beeld = it.beeld;
        if (!dubbel.links.some((l) => l.url === it.link) && dubbel.links.length < 4) dubbel.links.push({ bron: it.bron.naam === "Bing Nieuws" ? domein(it.link) : it.bron.naam, url: it.link });
        samengevoegd++;
        continue;
      }
      let isProef = false;
      if (r.modus === "filter" && score < drempel[rubriek]) {
        if (score < 25 || Math.random() > PROEF_KANS) continue;
        isProef = true;
      }
      const nieuwItem = {
        id: idVan(it.link),
        t: new Date(it.t).toISOString(),
        cat: rubriek,
        kop: String(o.kop).trim().slice(0, 140) || it.titel,
        sam: String(o.samenvatting).trim().slice(0, 300),
        lang: String(o.uitgebreid || "").trim().slice(0, 900),
        orig: it.titel,
        links: [{ bron: it.bron.naam === "Bing Nieuws" ? domein(it.link) : it.bron.naam, url: it.link }],
        score,
        ...(it.beeld ? { beeld: it.beeld } : {}),
        ...(isProef ? { proef: true } : {}),
      };
      items.push(nieuwItem);
      perId.set(nieuwItem.id, nieuwItem);
      isProef ? proef++ : geplaatst++;
      perRubriek[rubriek].geplaatst++;
    }
  }

  const wachtrij = [...batches];
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (wachtrij.length && !afgebroken) await verwerk(wachtrij.shift());
  }));
  meld(`Per rubriek (kandidaten → geplaatst): ${Object.entries(perRubriek).map(([c, t]) => `${c} ${t.kandidaat}→${t.geplaatst}`).join(", ")}`);
  meld(`Claude: ${geplaatst} geplaatst, ${proef} proefberichten, ${samengevoegd} samengevoegd met een bestaand bericht, ${mislukt} mislukt.`);

  // 6. Dumpert: alleen de actuele top 10 met de nieuwste plek
  const dumpertNu = new Map(resultaten[BRONNEN.findIndex((b) => b.soort === "dumpert")].value?.items.map((it) => [idVan(it.link), it.plek]) || []);
  for (const it of items) if (it.cat === "dumpert" && dumpertNu.has(it.id)) it.plek = dumpertNu.get(it.id);

  // 7. Opruimen en bewaren
  const uniek = new Map();
  for (const it of items) if (nu - Date.parse(it.t) < BEWAAR_MS) uniek.set(it.id, it);
  items = [...uniek.values()].sort((a, b) => Date.parse(b.t) - Date.parse(a.t));
  const run = { t: new Date(nu).toISOString(), duur: Math.round((Date.now() - nu) / 1000), verslag, meldingen: meldingen.slice(0, 40) };
  await bewaar(lokaal, { versie: 1, bijgewerkt: new Date(nu).toISOString(), items, gezien, bronnen: staat, run, ...(lokaal ? { stemmen } : {}) });
  console.log(`Klaar: ${nieuw.length} nieuwe berichten bekeken, ${geplaatst + proef} geplaatst, ${items.length} berichten in totaal, ${meldingen.length} meldingen.`);
  if (afgebroken) throw new Error("Claude API weigert de sleutel.");
}

main().catch((err) => {
  console.error(inCI ? `::error::${err.message}` : `FOUT: ${err.message}`);
  process.exit(1);
});
