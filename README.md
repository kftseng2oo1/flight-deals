# 飛日韓 · 特價機票

## 檔案
- `flight-deals.html` — 單檔 PWA（ES5，iOS WebView 可用），丟到 GitHub Pages
- `flight-deals-worker.js` — Cloudflare Worker：三來源查價 + 通知條件 + Cron → LINE
- `wrangler.toml` — 獨立部署用

## 資料來源（2026-09 現況）
| 來源 | 用途 | 取得方式 |
|---|---|---|
| Travelpayouts Data API | 月曆每日最低價、路線最便宜清單、通知比價 | travelpayouts.com 免費註冊拿 token |
| Duffel | 即時真實含稅報價 | duffel.com，test token 免費（模擬資料），live 需申請 |
| 航空促銷頁 + Claude | 各家促銷活動整理 | 用你現有的 ANTHROPIC_API_KEY |

Amadeus Self-Service 已於 2026-07-17 關閉、Kiwi Tequila 只限受邀合作夥伴，所以沒放進來。

## 部署
### A. 獨立 Worker
```
wrangler kv namespace create DEALS      # 把 id 填進 wrangler.toml
wrangler secret put TP_TOKEN
wrangler secret put DUFFEL_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put LINE_CHANNEL_TOKEN
wrangler secret put LINE_USER_ID
wrangler deploy
```
前端「設定」填 `https://flight-deals.kftseng2oo1.workers.dev`



### B. 掛進 arcar
```js
import { mountFlightDeals, runFlightAlerts } from './flight-deals-worker.js';

// fetch() 開頭
const fd = await mountFlightDeals(request, env, '/flights');
if (fd) return fd;

// scheduled()
ctx.waitUntil(runFlightAlerts(env));
```
arcar 要多綁一個 KV `DEALS` 與上面的 secrets。前端「設定」填 `https://arcar.kftseng2oo1.workers.dev/flights`

## API
- `GET /api/health`
- `GET /api/agg?o=TPE&d=TYO&m=2026-10&rt=1`
- `GET /api/calendar?o=TPE&d=TYO&m=2026-10&rt=1`
- `GET /api/live?o=TPE&d=NRT&dep=2026-10-15&ret=2026-10-19`
- `GET /api/promos[?refresh=1]`
- `GET/POST/DELETE /api/alerts`
- `GET /api/run-alerts`（手動跑 Cron）
- `GET /api/line-test`

## 促銷頁清單
`DEFAULT_PROMO_SOURCES` 裡的網址是各家促銷頁的常見路徑，第一次跑完看 `/api/promos` 回傳的 `errors`，
把抓不到（JS 渲染）的那幾家改成它們的 RSS / 靜態活動頁，或在 KV 放 `promo_sources` 覆蓋。
