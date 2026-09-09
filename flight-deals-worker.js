/**
 * flight-deals-worker.js  —  台日 / 台韓 特價機票 後端
 *
 * 三種資料來源：
 *   1. agg   : Travelpayouts (Aviasales) Data API — 免費 token，快取最低價（月曆 / 路線）
 *   2. live  : Duffel — 即時真實報價（test token 免費；live 需申請）
 *   3. promo : 各航空促銷頁 → fetch HTML → Claude 萃取成結構化 JSON
 *
 * 通知：Cron 定時跑 alerts（KV），低於門檻或出現新促銷 → LINE push
 *
 * 兩種部署方式：
 *   A. 獨立 Worker：直接用 default export（搭配 wrangler.toml）
 *   B. 掛進 arcar：
 *        import { mountFlightDeals, runFlightAlerts } from './flight-deals-worker.js';
 *        // 在 arcar 的 fetch() 開頭：
 *        const fd = await mountFlightDeals(request, env, '/flights');
 *        if (fd) return fd;
 *        // 在 arcar 的 scheduled() 裡：
 *        ctx.waitUntil(runFlightAlerts(env));
 *
 * 需要的 env：
 *   KV binding  DEALS
 *   secrets     TP_TOKEN, DUFFEL_TOKEN, ANTHROPIC_API_KEY, LINE_CHANNEL_TOKEN, LINE_USER_ID
 *   optional    ALLOWED_ORIGIN (預設 https://kftseng2oo1.github.io)
 */

// ───────────────────────── 常數 ─────────────────────────

const AGG_TTL = 30 * 60;          // Travelpayouts 快取 30 分
const PROMO_TTL = 12 * 60 * 60;   // 促銷頁快取 12 小時
const LIVE_TTL = 10 * 60;         // Duffel 即時報價快取 10 分

const CLAUDE_MODEL = 'claude-sonnet-4-6';

// 促銷頁來源。可在 KV 放 key = "promo_sources" (JSON array) 覆蓋這份清單。
const DEFAULT_PROMO_SOURCES = [
  { code: 'IT', name: '台灣虎航', region: 'TW', url: 'https://www.tigerairtw.com/zh-tw/promo' },
  { code: 'JX', name: '星宇航空', region: 'TW', url: 'https://www.starlux-airlines.com/zh-TW/promotions' },
  { code: 'BR', name: '長榮航空', region: 'TW', url: 'https://www.evaair.com/zh-tw/promotions/' },
  { code: 'CI', name: '中華航空', region: 'TW', url: 'https://www.china-airlines.com/tw/zh/promotion' },
  { code: 'MM', name: 'Peach', region: 'JP', url: 'https://www.flypeach.com/tw/campaign' },
  { code: 'JL', name: '日本航空 JAL', region: 'JP', url: 'https://www.jal.co.jp/tw/zhtw/promotions/' },
  { code: 'NH', name: '全日空 ANA', region: 'JP', url: 'https://www.ana.co.jp/zh/tw/promotions/' },
  { code: 'GK', name: 'Jetstar Japan', region: 'JP', url: 'https://www.jetstar.com/tw/zh/deals' },
  { code: 'TR', name: '酷航 Scoot', region: 'JP', url: 'https://www.flyscoot.com/zhtw/promotions' },
  { code: 'KE', name: '大韓航空', region: 'KR', url: 'https://www.koreanair.com/tw/zh/promotions' },
  { code: 'OZ', name: '韓亞航空', region: 'KR', url: 'https://flyasiana.com/C/TW/ZH/promotion' },
  { code: 'LJ', name: 'Jin Air', region: 'KR', url: 'https://www.jinair.com/promotion' },
  { code: 'TW', name: "T'way", region: 'KR', url: 'https://www.twayair.com/app/promotion' },
  { code: '7C', name: '濟州航空', region: 'KR', url: 'https://www.jejuair.net/tw/zh/event' },
  { code: 'BX', name: '釜山航空', region: 'KR', url: 'https://www.airbusan.com/content/individual/?lang=zh-TW' },
  { code: 'ZE', name: '易斯達航空', region: 'KR', url: 'https://www.eastarjet.com/newstar/PGWHB00001' },
];

// ───────────────────────── 工具 ─────────────────────────

function cors(env, extra) {
  const origin = (env && env.ALLOWED_ORIGIN) || 'https://kftseng2oo1.github.io';
  return Object.assign({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }, extra || {});
}

function json(env, body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: cors(env, { 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

function err(env, msg, status) {
  return json(env, { ok: false, error: msg }, status || 400);
}

async function kvGetJSON(env, key) {
  const raw = await env.DEALS.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function kvPutJSON(env, key, value, ttl) {
  const opts = ttl ? { expirationTtl: ttl } : undefined;
  await env.DEALS.put(key, JSON.stringify(value), opts);
}

function ym(d) {
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
}

function nextMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(ym(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1))));
  }
  return out;
}

async function sha1(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

// ───────────────────────── 1. Travelpayouts ─────────────────────────

async function tpFetch(env, path, params) {
  if (!env.TP_TOKEN) throw new Error('TP_TOKEN 未設定');
  const u = new URL('https://api.travelpayouts.com' + path);
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== '') u.searchParams.set(k, params[k]); });
  u.searchParams.set('token', env.TP_TOKEN);
  u.searchParams.set('currency', 'twd');
  const r = await fetch(u.toString(), { headers: { 'Accept-Encoding': 'gzip' } });
  if (!r.ok) throw new Error('Travelpayouts ' + r.status);
  const data = await r.json();
  if (data.success === false) throw new Error(data.error || 'Travelpayouts error');
  return data;
}

function normTP(row) {
  return {
    src: 'agg',
    origin: row.origin_airport || row.origin,
    destination: row.destination_airport || row.destination,
    airline: row.airline,
    flight: row.flight_number,
    price: row.price,
    currency: 'TWD',
    departAt: row.departure_at,
    returnAt: row.return_at || null,
    transfers: row.transfers || 0,
    duration: row.duration,
    link: row.link ? 'https://www.aviasales.com' + row.link : null,
  };
}

// 路線 × 月份 最便宜（含來回）
async function aggRoute(env, o, d, month, roundTrip) {
  const key = ['agg', o, d, month, roundTrip ? 'rt' : 'ow'].join(':');
  const cached = await kvGetJSON(env, key);
  if (cached) return cached;
  const data = await tpFetch(env, '/aviasales/v3/prices_for_dates', {
    origin: o, destination: d,
    departure_at: month,
    return_at: roundTrip ? month : undefined,
    sorting: 'price', direct: 'false', limit: 40, unique: 'false', one_way: roundTrip ? 'false' : 'true',
  });
  const out = { ok: true, fetchedAt: Date.now(), month, items: (data.data || []).map(normTP) };
  await kvPutJSON(env, key, out, AGG_TTL);
  return out;
}

// 月曆：每天最低價
async function aggCalendar(env, o, d, month, roundTrip) {
  const key = ['cal', o, d, month, roundTrip ? 'rt' : 'ow'].join(':');
  const cached = await kvGetJSON(env, key);
  if (cached) return cached;
  const data = await tpFetch(env, '/aviasales/v3/grouped_prices', {
    origin: o, destination: d,
    departure_at: month,
    return_at: roundTrip ? month : undefined,
    group_by: 'departure_at', direct: 'false', trip_duration: roundTrip ? 5 : undefined,
  });
  const days = {};
  const src = data.data || {};
  Object.keys(src).forEach(k => { days[k.slice(0, 10)] = normTP(src[k]); });
  const out = { ok: true, fetchedAt: Date.now(), month, days };
  await kvPutJSON(env, key, out, AGG_TTL);
  return out;
}

// ───────────────────────── 2. Duffel 即時報價 ─────────────────────────

async function liveSearch(env, o, d, dep, ret, adults) {
  if (!env.DUFFEL_TOKEN) throw new Error('DUFFEL_TOKEN 未設定');
  const key = ['live', o, d, dep, ret || '', adults].join(':');
  const cached = await kvGetJSON(env, key);
  if (cached) return cached;

  const slices = [{ origin: o, destination: d, departure_date: dep }];
  if (ret) slices.push({ origin: d, destination: o, departure_date: ret });
  const passengers = [];
  for (let i = 0; i < (adults || 1); i++) passengers.push({ type: 'adult' });

  const r = await fetch('https://api.duffel.com/air/offer_requests?return_offers=true', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.DUFFEL_TOKEN,
      'Duffel-Version': 'v2',
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ data: { slices, passengers, cabin_class: 'economy', max_connections: 1 } }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error('Duffel ' + r.status + ' ' + (body.errors && body.errors[0] ? body.errors[0].message : ''));

  const offers = (body.data && body.data.offers) || [];
  const items = offers.map(of => ({
    src: 'live',
    airline: of.owner && of.owner.iata_code,
    airlineName: of.owner && of.owner.name,
    price: Math.round(parseFloat(of.total_amount)),
    currency: of.total_currency,
    slices: (of.slices || []).map(s => ({
      origin: s.origin && s.origin.iata_code,
      destination: s.destination && s.destination.iata_code,
      segments: (s.segments || []).map(sg => ({
        carrier: sg.marketing_carrier && sg.marketing_carrier.iata_code,
        flight: (sg.marketing_carrier && sg.marketing_carrier.iata_code) + sg.marketing_carrier_flight_number,
        dep: sg.departing_at, arr: sg.arriving_at,
        from: sg.origin && sg.origin.iata_code, to: sg.destination && sg.destination.iata_code,
      })),
    })),
    expiresAt: of.expires_at,
  })).sort((a, b) => a.price - b.price).slice(0, 30);

  const out = { ok: true, fetchedAt: Date.now(), items, live: (body.data && body.data.live_mode) || false };
  await kvPutJSON(env, key, out, LIVE_TTL);
  return out;
}

// ───────────────────────── 3. 促銷頁 + Claude 萃取 ─────────────────────────

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function fetchPromoPage(src) {
  try {
    const r = await fetch(src.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'zh-TW,zh;q=0.9,ja;q=0.8,ko;q=0.7,en;q=0.6',
      },
      cf: { cacheTtl: 3600 },
    });
    if (!r.ok) return { src, error: 'HTTP ' + r.status };
    const html = await r.text();
    const text = htmlToText(html).slice(0, 14000);
    if (text.length < 200) return { src, error: 'JS 渲染頁，內容太短' };
    return { src, text };
  } catch (e) {
    return { src, error: String(e.message || e) };
  }
}

async function claudeExtract(env, page) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY 未設定');
  const system = [
    '你是機票促銷資訊萃取器。只回傳 JSON 陣列，不要 Markdown、不要說明。',
    '只保留「台灣 ↔ 日本」或「台灣 ↔ 韓國」相關的促銷；其他航線忽略。',
    '每個元素格式：',
    '{"title":"活動名稱","routes":["TPE-NRT","KHH-ICN"],"priceFrom":2999,"currency":"TWD",',
    ' "oneWay":true,"saleUntil":"2026-09-30","travelFrom":"2026-10-01","travelTo":"2027-03-31","note":"含稅/不含稅、限制"}',
    '價格若是 JPY 或 KRW 保持原幣別。日期不確定填 null。routes 用 IATA 機場代碼，城市不確定時用城市碼（TYO/OSA/SEL）。',
    '找不到任何相關促銷時回傳 []。',
  ].join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: '航空公司：' + page.src.name + ' (' + page.src.code + ')\n頁面：' + page.src.url + '\n\n' + page.text }],
    }),
  });
  const body = await r.json();
  if (!r.ok) throw new Error('Claude ' + r.status + ' ' + (body.error && body.error.message));
  const txt = (body.content || []).map(c => c.text || '').join('');
  const clean = txt.replace(/```json|```/g, '').trim();
  let arr = [];
  try { arr = JSON.parse(clean); } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  return arr.map(x => Object.assign({ src: 'promo', airline: page.src.code, airlineName: page.src.name, region: page.src.region, url: page.src.url }, x));
}

async function refreshPromos(env) {
  const sources = (await kvGetJSON(env, 'promo_sources')) || DEFAULT_PROMO_SOURCES;
  const pages = await Promise.all(sources.map(fetchPromoPage));
  const deals = [];
  const errors = [];
  // 逐家送 Claude（避免一次打爆 rate limit）
  for (const p of pages) {
    if (p.error) { errors.push({ airline: p.src.code, error: p.error }); continue; }
    try {
      const got = await claudeExtract(env, p);
      for (const g of got) {
        g.id = await sha1(g.airline + '|' + g.title + '|' + (g.priceFrom || '') + '|' + (g.saleUntil || ''));
        deals.push(g);
      }
    } catch (e) {
      errors.push({ airline: p.src.code, error: String(e.message || e) });
    }
  }
  const out = { ok: true, fetchedAt: Date.now(), deals, errors };
  await kvPutJSON(env, 'promos', out, PROMO_TTL * 2); // 留較久，Cron 會更新
  return out;
}

async function getPromos(env, force) {
  const cached = await kvGetJSON(env, 'promos');
  if (cached && !force && Date.now() - cached.fetchedAt < PROMO_TTL) return cached;
  return refreshPromos(env);
}

// ───────────────────────── 4. Alerts + LINE ─────────────────────────

async function linePush(env, text) {
  if (!env.LINE_CHANNEL_TOKEN || !env.LINE_USER_ID) return false;
  const r = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.LINE_CHANNEL_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: env.LINE_USER_ID, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  return r.ok;
}

async function getAlerts(env) {
  return (await kvGetJSON(env, 'alerts')) || [];
}

// alert: { id, origin, destination, months:["2026-10","2026-11"], maxPrice, roundTrip, lastPrice, lastNotified }
async function runFlightAlerts(env) {
  const alerts = await getAlerts(env);
  const report = [];
  let changed = false;

  for (const a of alerts) {
    if (!a.enabled) continue;
    const months = (a.months && a.months.length) ? a.months : nextMonths(3);
    let best = null;
    for (const m of months) {
      try {
        const res = await aggRoute(env, a.origin, a.destination, m, a.roundTrip !== false);
        for (const it of res.items) {
          if (!best || it.price < best.price) best = it;
        }
      } catch (e) {
        report.push({ id: a.id, error: String(e.message || e) });
      }
    }
    if (!best) continue;
    a.lastPrice = best.price;
    a.lastChecked = Date.now();
    changed = true;

    const hit = best.price <= a.maxPrice;
    // 只有「首次達標」或「比上次通知更低 5%」才推，避免洗版
    const shouldNotify = hit && (!a.lastNotifiedPrice || best.price < a.lastNotifiedPrice * 0.95);
    if (shouldNotify) {
      const msg = [
        '✈️ 特價機票達標',
        a.origin + ' ⇄ ' + a.destination + (a.roundTrip !== false ? '（來回）' : '（單程）'),
        'NT$' + best.price.toLocaleString() + '  門檻 NT$' + a.maxPrice.toLocaleString(),
        best.airline + ' ' + (best.flight || '') + '  ' + String(best.departAt).slice(0, 10) + (best.returnAt ? ' → ' + String(best.returnAt).slice(0, 10) : ''),
        best.transfers ? '轉機 ' + best.transfers + ' 次' : '直飛',
        best.link || '',
      ].join('\n');
      const ok = await linePush(env, msg);
      if (ok) a.lastNotifiedPrice = best.price;
      report.push({ id: a.id, notified: ok, price: best.price });
    } else {
      report.push({ id: a.id, price: best.price, hit });
    }
  }
  if (changed) await kvPutJSON(env, 'alerts', alerts);

  // 新促銷推播（每次 Cron 順便刷新，並只推新出現的活動）
  try {
    const promos = await refreshPromos(env);
    const seen = (await kvGetJSON(env, 'promo_seen')) || {};
    const fresh = promos.deals.filter(d => !seen[d.id]);
    if (fresh.length) {
      const lines = fresh.slice(0, 8).map(d =>
        '• ' + d.airlineName + '｜' + d.title +
        (d.priceFrom ? '  ' + d.currency + ' ' + d.priceFrom + ' 起' : '') +
        (d.saleUntil ? '  至 ' + d.saleUntil : '')
      );
      await linePush(env, '🏷️ 新促銷 ' + fresh.length + ' 則\n' + lines.join('\n'));
      fresh.forEach(d => { seen[d.id] = Date.now(); });
      // 修剪 60 天前的紀錄
      const cutoff = Date.now() - 60 * 86400000;
      Object.keys(seen).forEach(k => { if (seen[k] < cutoff) delete seen[k]; });
      await kvPutJSON(env, 'promo_seen', seen);
    }
    report.push({ promos: promos.deals.length, fresh: fresh.length });
  } catch (e) {
    report.push({ promoError: String(e.message || e) });
  }
  await kvPutJSON(env, 'last_cron', { at: Date.now(), report });
  return report;
}

// ───────────────────────── Router ─────────────────────────

async function handle(request, env, prefix) {
  const url = new URL(request.url);
  let path = url.pathname;
  if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
  if (!path.startsWith('/')) path = '/' + path;
  const q = url.searchParams;

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

  try {
    if (path === '/api/health') {
      return json(env, {
        ok: true,
        tp: !!env.TP_TOKEN, duffel: !!env.DUFFEL_TOKEN, claude: !!env.ANTHROPIC_API_KEY,
        line: !!(env.LINE_CHANNEL_TOKEN && env.LINE_USER_ID),
        lastCron: await kvGetJSON(env, 'last_cron'),
      });
    }

    if (path === '/api/agg') {
      const o = (q.get('o') || '').toUpperCase(), d = (q.get('d') || '').toUpperCase();
      if (!o || !d) return err(env, '缺 o / d');
      const month = q.get('m') || nextMonths(1)[0];
      const rt = q.get('rt') !== '0';
      return json(env, await aggRoute(env, o, d, month, rt));
    }

    if (path === '/api/calendar') {
      const o = (q.get('o') || '').toUpperCase(), d = (q.get('d') || '').toUpperCase();
      if (!o || !d) return err(env, '缺 o / d');
      const month = q.get('m') || nextMonths(1)[0];
      const rt = q.get('rt') !== '0';
      return json(env, await aggCalendar(env, o, d, month, rt));
    }

    if (path === '/api/live') {
      const o = (q.get('o') || '').toUpperCase(), d = (q.get('d') || '').toUpperCase();
      const dep = q.get('dep'), ret = q.get('ret') || null;
      if (!o || !d || !dep) return err(env, '缺 o / d / dep');
      return json(env, await liveSearch(env, o, d, dep, ret, parseInt(q.get('adults') || '1', 10)));
    }

    if (path === '/api/promos') {
      return json(env, await getPromos(env, q.get('refresh') === '1'));
    }

    if (path === '/api/alerts') {
      if (request.method === 'GET') return json(env, { ok: true, alerts: await getAlerts(env) });
      if (request.method === 'POST') {
        const body = await request.json();
        const alerts = await getAlerts(env);
        const a = {
          id: body.id || (await sha1(Date.now() + Math.random().toString())),
          origin: String(body.origin || '').toUpperCase(),
          destination: String(body.destination || '').toUpperCase(),
          months: Array.isArray(body.months) ? body.months : [],
          maxPrice: parseInt(body.maxPrice, 10) || 0,
          roundTrip: body.roundTrip !== false,
          enabled: body.enabled !== false,
          created: Date.now(),
        };
        if (!a.origin || !a.destination || !a.maxPrice) return err(env, '缺 origin / destination / maxPrice');
        const idx = alerts.findIndex(x => x.id === a.id);
        if (idx >= 0) alerts[idx] = Object.assign(alerts[idx], a); else alerts.push(a);
        await kvPutJSON(env, 'alerts', alerts);
        return json(env, { ok: true, alerts });
      }
      if (request.method === 'DELETE') {
        const id = q.get('id');
        const alerts = (await getAlerts(env)).filter(x => x.id !== id);
        await kvPutJSON(env, 'alerts', alerts);
        return json(env, { ok: true, alerts });
      }
    }

    if (path === '/api/run-alerts') {
      // 手動觸發 Cron 邏輯（測試用）
      return json(env, { ok: true, report: await runFlightAlerts(env) });
    }

    if (path === '/api/line-test') {
      return json(env, { ok: await linePush(env, '✈️ flight-deals LINE 測試訊息') });
    }

    return null; // 沒對到路由
  } catch (e) {
    return err(env, String(e.message || e), 500);
  }
}

// 供 arcar 掛載：路徑不符時回 null
export async function mountFlightDeals(request, env, prefix) {
  const url = new URL(request.url);
  if (prefix && !url.pathname.startsWith(prefix)) return null;
  return handle(request, env, prefix || '');
}

export { runFlightAlerts };

export default {
  async fetch(request, env) {
    const res = await handle(request, env, '');
    return res || err(env, 'not found', 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFlightAlerts(env));
  },
};
