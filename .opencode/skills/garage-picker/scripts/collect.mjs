#!/usr/bin/env node
/**
 * Garage Picker — собирает объявления о продаже гаражей в Витебске,
 * фильтрует по бюджету/площади/локации, оценивает по методике doc.md
 * и формирует отчёт с датой запуска.
 *
 * Запуск:
 *   node .opencode/skills/garage-picker/scripts/collect.mjs
 *   node .opencode/skills/garage-picker/scripts/collect.mjs --top 5 --max-price 32000
 *
 * Зависимостей нет (Node 18+). Источники: re.kufar.by, realt.by.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../../..');
const SKILL_DIR = path.resolve(__dirname, '..');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CLI ----------
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const config = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));
const CITY = arg('city', config.city);
const TOP = Number(arg('top', config.top));
const MAX_PRICE = Number(arg('max-price', config.budget.max));
const MIN_PRICE = Number(arg('min-price', config.budget.min));
const WITH_REALT = !args.includes('--no-realt');
const GK = arg('gk', null);

// ---------- Utils ----------
async function fetchText(url, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, 'accept-language': 'ru-RU,ru;q=0.9' },
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw lastErr;
}

function nextData(html) {
  const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('__NEXT_DATA__ not found');
  return JSON.parse(m[1]);
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const money = (n) => Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const stripTags = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const ageDays = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 86400000));
};
const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('ru-RU');
};

function textHas(text, words) {
  const t = String(text || '').toLowerCase();
  return words.some((w) => t.includes(w));
}

function cleanAddress(raw, cityLabel) {
  const a = stripTags(raw)
    .replace(/Витебская область/gi, '')
    .replace(/Витебский район/gi, '')
    .replace(/ая область/gi, '')
    .replace(new RegExp(cityLabel, 'gi'), '')
    .replace(/\b\d+\s*блок\s*\d+\s*к\s*\d+\b/gi, '')
    .replace(/\bблок\s*\d+\s*к\s*\d+\b/gi, '')
    .replace(/\s*,\s*,+/g, ',')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .replace(/\s{2,}/g, ' ');
  return a || cityLabel;
}

function areaFromText(text) {
  const m = String(text || '').match(/(\d+(?:[.,]\d+)?)\s*(?:кв\.?\s*м|м2|м²|м\.\s*кв)/i);
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  return v >= 10 && v <= 200 ? v : null;
}

function featuresFromText(text) {
  const t = String(text || '').toLowerCase();
  const out = [];
  if (/яма|смотров/.test(t)) out.push('Смотровая яма');
  if (/подвал|погреб/.test(t)) out.push('Подвал');
  if (/электричеств|свет|220/.test(t)) out.push('Электричество 220В');
  if (/видеонаблюден/.test(t)) out.push('Видеонаблюдение');
  else if (/охрана|сторож|шлагбаум/.test(t)) out.push('Охрана');
  if (/кирпич/.test(t)) out.push('Кирпич');
  if (/ж\/б|железобетон|плит[аы] перекрытия/.test(t)) out.push('Ж/б перекрытия');
  if (/сухой|вентиляц/.test(t)) out.push('Сухой, вентиляция');
  if (/отоплен|печк|котел/.test(t)) out.push('Отопление');
  if (/утепл/.test(t)) out.push('Утеплён');
  return out;
}

function mergeFeatures(list, text) {
  const merged = [...(list || [])];
  for (const f of featuresFromText(text)) {
    if (!merged.some((m) => m.toLowerCase().includes(f.toLowerCase().split(' ')[0]))) merged.push(f);
  }
  return merged;
}

function cooperativeFromText(text) {
  const m = String(text || '').match(/(ГПК|ГСК|ГСП|ГСПК)[-\s№]*\s*[«"]?([\wА-Яа-яЁё-]+)[»"]?/i);
  return m ? `${m[1].toUpperCase()} ${m[2]}` : null;
}

// ---------- Kufar ----------
function kufarAdToItem(ad) {
  const params = Object.fromEntries((ad.ad_parameters || []).map((p) => [p.p, p]));
  const acc = Object.fromEntries((ad.account_parameters || []).map((p) => [p.p, p]));
  const price = ad.price_byn != null ? ad.price_byn / 100 : null;
  const dist = params.distance_to_center_km ? Number(params.distance_to_center_km.v) : null;
  const improvements = params.garage_improvements?.vl;
  const features = Array.isArray(improvements) ? improvements : improvements ? [improvements] : [];
  const text = stripTags([ad.body_short, ad.body, ad.subject].filter(Boolean).join(' '));
  const areaParam = params.size ? Number(params.size.v) : null;
  const area = areaParam || areaFromText(text);
  const areaEstimated = !areaParam && !!area;
  const address = cleanAddress(acc.address?.v || acc.region?.v || config.cityLabel, config.cityLabel);
  const loc = Number.isFinite(dist) ? { km: dist, approx: false } : estimateDistance(address, config.centerStreets, config.centerDistricts);

  return {
    source: 'Kufar',
    id: String(ad.ad_id),
    url: ad.ad_link,
    address,
    type: params.garage_type?.vl || 'Гараж',
    price,
    area,
    areaEstimated,
    distanceKm: loc.km,
    distanceApprox: loc.approx,
    features: mergeFeatures(features, text),
    text,
    images: Array.isArray(ad.images) ? ad.images.length : 0,
    createdAt: ad.list_time || null,
  };
}

async function collectKufarSale(maxPages = 8) {
  const base = `https://re.kufar.by/l/${CITY}/kupit/garazh`;
  const items = [];
  let url = base;
  for (let page = 1; page <= maxPages; page++) {
    const data = nextData(await fetchText(url));
    const listing = data.props.initialState.listing;
    const ads = listing.ads || [];
    items.push(...ads.map(kufarAdToItem));
    const next = (listing.pagination || []).find((p) => p.label === 'next' && p.token);
    if (!next || !ads.length) break;
    url = `${base}?cursor=${encodeURIComponent(next.token)}`;
    await sleep(350);
  }
  return items;
}

async function collectKufarRentBenchmark() {
  try {
    const data = nextData(await fetchText(`https://re.kufar.by/l/${CITY}/snyat/garazh`));
    const ads = data.props.initialState.listing.ads || [];
    const rows = ads
      .map((ad) => {
        const p = Object.fromEntries((ad.ad_parameters || []).map((x) => [x.p, x]));
        return { price: ad.price_byn / 100, area: Number(p.size?.v) };
      })
      .filter((r) => r.price >= 80 && r.price <= 400 && r.area >= 12 && r.area <= 45);
    const ppm = rows.map((r) => r.price / r.area);
    return {
      sample: rows.length,
      medianPpm: ppm.length ? median(ppm) : null,
      medianRent: rows.length ? median(rows.map((r) => r.price)) : null,
      medianArea: rows.length ? median(rows.map((r) => r.area)) : null,
    };
  } catch {
    return { sample: 0, medianPpm: null, medianRent: null, medianArea: null };
  }
}

// ---------- Realt ----------
function estimateDistance(address, centers, districts = {}) {
  const a = String(address || '').toLowerCase();
  for (const [street, km] of Object.entries(centers)) {
    if (a.includes(street)) return { km, approx: false };
  }
  for (const [district, km] of Object.entries(districts)) {
    if (a.includes(district)) return { km, approx: true };
  }
  return { km: null, approx: false };
}

function realtToItem(o, centers) {
  const byn = o.priceRates?.['933'] ?? (o.priceCurrency === 933 ? o.price : null);
  const text = stripTags([o.headline, o.title, o.description].filter(Boolean).join(' '));
  const areaParam = o.areaTotal || o.areaMin || o.areaMax || null;
  const area = areaParam || areaFromText(text);
  const areaEstimated = !areaParam && !!Number(area);

  let addressRaw;
  if (o.streetName) {
    addressRaw = `${o.streetName}${o.houseNumber ? ', ' + o.houseNumber : ''}`;
  } else if (o.address && /ул|просп|пер\.|б-р|тракт|д\./i.test(o.address)) {
    addressRaw = o.address;
  } else {
    addressRaw = cooperativeFromText(text) || o.address || o.townName || config.cityLabel;
  }

  const loc = estimateDistance(`${addressRaw} ${text}`, centers, config.centerDistricts);

  return {
    source: 'Realt',
    id: String(o.code || o.uuid),
    url: `https://realt.by/vitebsk-region/sale-garage/object/${o.code}/`,
    address: cleanAddress(addressRaw, config.cityLabel),
    type: 'Гараж',
    price: byn ? Number(byn) : null,
    area: area ? Number(area) : null,
    areaEstimated,
    distanceKm: loc.km,
    distanceApprox: loc.approx,
    features: mergeFeatures([], text),
    text,
    images: Array.isArray(o.images) ? o.images.length : 0,
    createdAt: o.createdAt || null,
  };
}

async function collectRealt(maxPages = 4) {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://realt.by/${CITY}-region/sale/garage/garazh/${page > 1 ? `?page=${page}` : ''}`;
    const data = nextData(await fetchText(url));
    const objs = data.props.pageProps.objects || [];
    let fresh = 0;
    for (const o of objs) {
      const key = String(o.code || o.uuid);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(realtToItem(o, config.centerStreets));
      fresh++;
    }
    if (fresh === 0 || objs.length < 10) break;
    await sleep(350);
  }
  return items;
}

// ---------- Scoring ----------
function scoreLegal(item) {
  let s = 2.2;
  const t = item.text.toLowerCase();
  if (/приватизирован/.test(t)) s += 1.2;
  if (/свидетельств|техпаспорт|техническ\w* документ|документы/.test(t)) s += 0.9;
  if (/без долг|без задолж|собственник|от собственника/.test(t)) s += 0.7;
  if (/торг/.test(t)) s += 0.3;
  if (/договорная цена|цена договорная/.test(t)) s -= 0.6;
  if (/нет документ|документы отсутств/.test(t)) s -= 2;
  return clamp(round(s, 2), 0, 5);
}

function scoreLocation(item) {
  const d = item.distanceKm;
  if (d == null) return 2.6;
  if (d <= 1.5) return 5;
  if (d <= 2.5) return 4.4;
  if (d <= 3.5) return 3.6;
  if (d <= 4.5) return 2.8;
  if (d <= config.maxDistanceKm) return 2;
  return 1;
}

function scoreTech(item) {
  const t = (item.text + ' ' + item.features.join(' ')).toLowerCase();
  let s = 1;
  if (/яма|смотров/.test(t)) s += 1;
  if (/подвал|погреб/.test(t)) s += 1;
  if (/электричеств|свет|220/.test(t)) s += 1;
  if (/охрана|сторож|шлагбаум|видеонаблюден/.test(t)) s += 0.8;
  if (/кирпич|ж\/б|железобетон|капитальн|монолит/.test(t)) s += 0.6;
  if (/сухой|новая крыша|крыша.*(замен|ремонт|перекрыт)/.test(t)) s += 0.6;
  if (/отоплен|печк|котел/.test(t)) s += 0.4;
  if (/утепл/.test(t)) s += 0.3;
  return clamp(round(s, 2), 0, 5);
}

function scoreValue(item) {
  const p = item.price;
  const ppm = item.area ? p / item.area : null;
  let s;
  if (p <= 20000) s = 5;
  else if (p <= 23000) s = 4.6;
  else if (p <= 25000) s = 4.2;
  else if (p <= 28000) s = 3.4;
  else if (p <= MAX_PRICE) s = 2.5;
  else s = 1;
  if (ppm != null) {
    if (ppm < 850) s += 0.5;
    else if (ppm > 1400) s -= 0.6;
    else if (ppm > 1200) s -= 0.3;
  }
  return clamp(round(s, 2), 0, 5);
}

function scoreLiquidity(item) {
  const a = item.area || 0;
  let s;
  if (a >= 18 && a <= 27) s = 5;
  else if (a > 27 && a <= 32) s = 4.2;
  else if (a > 32 && a <= 40) s = 2.8;
  else if (a >= 15 && a < 18) s = 3.6;
  else s = 2;
  if (item.type && !/гараж/i.test(item.type)) s -= 1;
  if (/перв\w* лини|у въезда|рядом со сторож/.test(item.text.toLowerCase())) s += 0.3;
  return clamp(round(s, 2), 0, 5);
}

function scoreItem(item) {
  const criteria = {
    legal: scoreLegal(item),
    location: scoreLocation(item),
    tech: scoreTech(item),
    value: scoreValue(item),
    liquidity: scoreLiquidity(item),
  };
  const w = config.weights;
  const total = Object.entries(criteria).reduce((acc, [k, v]) => acc + v * w[k], 0) / 5;
  return { criteria, total: round(total, 1) };
}

// ---------- Rent / yield ----------
function estimateRent(item, bench) {
  let rent;
  if (bench.medianRent && bench.medianArea && item.area) {
    rent = bench.medianRent * Math.sqrt(item.area / bench.medianArea);
  } else if (item.area) {
    rent = 8.5 * item.area;
  } else {
    rent = 180;
  }
  const t = (item.text + ' ' + item.features.join(' ')).toLowerCase();
  if (/яма|смотров/.test(t)) rent *= 1.06;
  if (/подвал/.test(t)) rent *= 1.05;
  if (/электричеств|свет 220|220в/.test(t)) rent *= 1.05;
  if (/охрана|шлагбаум/.test(t)) rent *= 1.04;
  return Math.round(clamp(rent, 130, 280) / 10) * 10;
}

function estimateYield(item, rent) {
  const gross = rent * 12;
  const costs = config.taxPerMonthByn * 12 + config.hoaPerMonthByn * 12 + gross * config.reserveShare;
  return round(((gross - costs) / item.price) * 100, 1);
}

// ---------- Filtering ----------
function applyFilters(items) {
  const rejects = {};
  const rej = (reason) => (rejects[reason] = (rejects[reason] || 0) + 1);
  const seen = new Map();
  const out = [];

  for (const item of items) {
    if (GK && !`${item.address} ${item.text}`.toLowerCase().includes(GK.toLowerCase())) { rej(`не ГК «${GK}»`); continue; }
    if (!item.price) { rej('нет цены'); continue; }
    if (!item.area) { rej('нет площади'); continue; }
    if (item.price < MIN_PRICE || item.price > MAX_PRICE) { rej('вне бюджета'); continue; }
    if (item.area < config.area.min || item.area > config.area.max) { rej('неподходящая площадь'); continue; }
    const t = item.text.toLowerCase();
    if (textHas(t, config.negativeKeywords)) { rej('стоп-слово в описании'); continue; }
    if (item.distanceKm != null && item.distanceKm > config.maxDistanceKm) { rej('далеко от центра'); continue; }

    // дедупликация Kufar/Realt по улице и цене (±3%)
    const street = (item.address.toLowerCase().match(/[а-яё]+(?=\s*(ул|просп|пер|б-р|тракт))/)?.[0]) || item.address.toLowerCase().slice(0, 12);
    const key = `${street}|${Math.round(item.price / 500)}`;
    const prev = seen.get(key);
    if (prev) {
      if ((item.text?.length || 0) > (prev.text?.length || 0)) {
        out[out.indexOf(prev)] = item;
        seen.set(key, item);
      }
      rej('дубль на двух площадках');
      continue;
    }
    seen.set(key, item);
    out.push(item);
  }
  return { out, rejects };
}

// ---------- Report ----------
function buildReport({ items, ranked, bench, rejects, scanned }) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toLocaleString('ru-RU', { hour12: false });
  const top = ranked.slice(0, TOP);
  const next = ranked.slice(TOP, TOP + 3);

  const lines = [];
  lines.push(`# Гаражи под сдачу — ${config.cityLabel}, ${dateStr}`);
  lines.push('');
  lines.push(`**Дата отчёта:** ${timeStr}`);
  lines.push(`**Источники:** Kufar — ${scanned.kufar} объявл., Realt — ${scanned.realt} объявл.`);
  lines.push(`**Бюджет:** ${money(MIN_PRICE)}–${money(MAX_PRICE)} BYN · **Площадь:** ${config.area.min}–${config.area.max} м² · **До центра:** ≤ ${config.maxDistanceKm} км`);
  lines.push(`**Цель:** 1 гараж в центре под сдачу физлицу (фиксированный подоходный налог ${config.taxPerMonthByn} BYN/мес.).`);
  lines.push(`**Прошло фильтры:** ${items.length} из ${scanned.total}. В шорт-лист: ${top.length}.`);
  if (GK) lines.push(`**Фильтр по ГК:** «${GK}» (только объявления, где кооператив указан в тексте или адресе).`);

  const stale = top.filter((it) => (ageDays(it.createdAt) ?? 0) > 180);
  if (stale.length) {
    lines.push('');
    lines.push('> ⚠️ **Требуют проверки актуальности:** ' + stale.map((it) => `${it.address} — от ${fmtDate(it.createdAt)} (${ageDays(it.createdAt)} дн.)`).join('; ') + '. Объявления давно не обновлялись: возможна продажа или изменение цены.');
  }
  lines.push('');
  lines.push(`## Топ-${top.length}`);
  lines.push('');
  lines.push('| # | Цена, BYN | BYN/м² | Площадь | Адрес | До центра | Оценка | Аренда, BYN/мес. | Доходность |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  top.forEach((it, i) => {
    lines.push(
      `| ${i + 1} | ${money(it.price)} | ${money(it.price / it.area)} | ${it.area} м² | ${it.address} | ${it.distanceKm != null ? (it.distanceApprox ? '≈' : '') + it.distanceKm + ' км' : 'н/д'} | **${it.total}/100** | ~${it.rent} | ~${it.yieldPct}% |`
    );
  });
  lines.push('');

  top.forEach((it, i) => {
    const age = ageDays(it.createdAt);
    lines.push(`### ${i + 1}. ${it.address} — ${money(it.price)} BYN — ${it.total}/100`);
    lines.push('');
    lines.push(`- **Площадь:** ${it.area} м²${it.areaEstimated ? ' (по тексту объявления)' : ''} · **Цена за м²:** ${money(it.price / it.area)} BYN`);
    lines.push(`- **Тип:** ${it.type} · **До центра:** ${it.distanceKm != null ? (it.distanceApprox ? '≈' : '') + it.distanceKm + ' км' : 'не определено'}`);
    if (age != null) {
      lines.push(`- **Опубликовано:** ${fmtDate(it.createdAt)} (${age} дн. назад)${age > 180 ? ' — объявление давно не обновлялось, цену и актуальность нужно уточнять' : ''}`);
    }
    lines.push(`- **Фичи:** ${it.features.length ? it.features.join(', ') : '—'}`);
    lines.push(`- **Оценка аренды:** ~${it.rent} BYN/мес. (бенчмарк: ${bench.sample} объявл., медиана ${bench.medianRent ? money(bench.medianRent) : 'н/д'} BYN)`);
    lines.push(`- **Оценка доходности:** ~${it.yieldPct}% годовых (после налога, взносов и резерва)`);
    lines.push(`- **Критерии:** юр. чистота ${it.criteria.legal}/5 · локация ${it.criteria.location}/5 · техсостояние ${it.criteria.tech}/5 · цена ${it.criteria.value}/5 · ликвидность ${it.criteria.liquidity}/5`);
    lines.push(`- **Почему в топе:** ${it.why}`);
    lines.push(`- **Что проверить:** ${it.check}`);
    lines.push(`- **Ссылка:** ${it.url}`);
    lines.push(`- **Источник:** ${it.source}, ID ${it.id}`);
    lines.push('');
  });

  if (next.length) {
    lines.push('## Следующие кандидаты');
    lines.push('');
    lines.push('| Цена, BYN | Площадь | Адрес | Оценка | Ссылка |');
    lines.push('|---|---|---|---|---|');
    next.forEach((it) => lines.push(`| ${money(it.price)} | ${it.area} м² | ${it.address} | ${it.total}/100 | ${it.url} |`));
    lines.push('');
  }

  lines.push('## Что отсеялось');
  lines.push('');
  const rejRows = Object.entries(rejects).sort((a, b) => b[1] - a[1]);
  if (rejRows.length) {
    lines.push('| Причина | Кол-во |');
    lines.push('|---|---|');
    rejRows.forEach(([k, v]) => lines.push(`| ${k} | ${v} |`));
  } else {
    lines.push('Ничего — все объявления прошли фильтры.');
  }
  lines.push('');

  lines.push('## Методика');
  lines.push('');
  lines.push(`Оценка 0–100 = взвешенная сумма пяти критериев: юр. чистота ${config.weights.legal}%, локация ${config.weights.location}%, техсостояние ${config.weights.tech}%, цена ${config.weights.value}%, ликвидность ${config.weights.liquidity}%.`);
  lines.push('Юр. чистота и техсостояние оцениваются **только по тексту объявления** (ключевые слова: «приватизирован», «техпаспорт», «без долгов», «яма», «подвал», «свет» и т.п.) — это прокси, а не проверка документов.');
  lines.push(`Аренда оценивается по текущей медианной ставке ${bench.medianPpm ? round(bench.medianPpm, 1) + ' BYN/м²' : '8,5 BYN/м²'} с поправкой на фичи. Доходность = (аренда×12 − налог ${config.taxPerMonthByn}×12 − взносы ГСК ${config.hoaPerMonthByn}×12 − резерв ${Math.round(config.reserveShare * 100)}%) / цена.`);
  lines.push('Расстояние до центра берётся из параметров Kufar; если его нет — оценка по названию улицы, а при отсутствии улицы по району (такие значения помечены «≈»).');
  lines.push('');
  lines.push('## Ограничения');
  lines.push('');
  lines.push('- Данные на момент запуска; объявления могли измениться или быть сняты.');
  lines.push('- Юридическая чистота, обременения, долги ГСК и состояние крыши проверяются только на месте и по документам.');
  lines.push('- Металлические гаражи «без места», второй этаж и объекты с явными стоп-словами исключены автоматически.');
  lines.push('- Отчёт не является юридической консультацией.');
  lines.push('');

  return { dateStr, markdown: lines.join('\n') };
}

// ---------- Main ----------
async function main() {
  const scanned = { kufar: 0, realt: 0, total: 0 };
  const items = [];

  const results = await Promise.allSettled([
    collectKufarSale().then((x) => ({ name: 'kufar', items: x })),
    WITH_REALT ? collectRealt().then((x) => ({ name: 'realt', items: x })) : Promise.resolve({ name: 'realt', items: [] }),
    collectKufarRentBenchmark().then((x) => ({ name: 'bench', items: x })),
  ]);

  let bench = { sample: 0, medianPpm: null, medianRent: null, medianArea: null };
  for (const r of results) {
    if (r.status === 'rejected') {
      console.error('Источник недоступен:', r.reason?.message || r.reason);
      continue;
    }
    if (r.value.name === 'kufar') { scanned.kufar = r.value.items.length; items.push(...r.value.items); }
    if (r.value.name === 'realt') { scanned.realt = r.value.items.length; items.push(...r.value.items); }
    if (r.value.name === 'bench') bench = r.value.items;
  }
  scanned.total = items.length;

  if (!items.length) {
    console.error('Не удалось получить ни одного объявления. Проверьте доступ к kufar.by / realt.by.');
    process.exit(1);
  }

  const { out, rejects } = applyFilters(items);

  for (const it of out) {
    const { criteria, total } = scoreItem(it);
    it.criteria = criteria;
    it.total = total;
    it.rent = estimateRent(it, bench);
    it.yieldPct = estimateYield(it, it.rent);
    it.why = explain(it);
    it.check = checklist(it);
  }

  const ranked = out.sort((a, b) => b.total - a.total || a.price - b.price);

  const { dateStr, markdown } = buildReport({ items: out, ranked, bench, rejects, scanned });
  const outDir = path.join(ROOT, 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `garages-${CITY}-${dateStr}.md`);
  fs.writeFileSync(outPath, markdown, 'utf8');

  console.log(`Отчёт: ${outPath}`);
  console.log(`Просканировано: ${scanned.total} (Kufar ${scanned.kufar}, Realt ${scanned.realt}); прошло фильтры: ${out.length}`);
  ranked.slice(0, TOP).forEach((it, i) => {
    console.log(`${i + 1}. ${it.total}/100 · ${money(it.price)} BYN · ${it.area} м² · ${it.address} · ~${it.rent} BYN/мес · ${it.url}`);
  });
}

function explain(it) {
  const bits = [];
  if (it.criteria.legal >= 3.5) bits.push('документы/приватизация заявлены в описании');
  if (it.criteria.location >= 4) bits.push('близко к центру');
  if (it.criteria.tech >= 3.5) {
    const f = it.features.slice(0, 3).join(', ');
    bits.push(f ? `оснащение: ${f.toLowerCase()}` : 'техсостояние выше среднего по описанию');
  }
  if (it.criteria.value >= 4) bits.push('цена ниже или около рынка');
  if (it.criteria.liquidity >= 4) bits.push('типовой ликвидный размер');
  return bits.join('; ') || 'сбалансирован по критериям';
}

function checklist(it) {
  const checks = ['свидетельство и техпаспорт', 'отсутствие долгов ГСК', 'ЕГР: нет арестов/залога'];
  if (it.source === 'Realt') checks.push('уточнить площадь и год постройки');
  if (!/яма|смотров/.test(it.text.toLowerCase())) checks.push('состояние пола/ямы');
  if (!/крыш/.test(it.text.toLowerCase())) checks.push('состояние крыши');
  return checks.join(', ');
}

main().catch((e) => {
  console.error('Ошибка:', e);
  process.exit(1);
});
