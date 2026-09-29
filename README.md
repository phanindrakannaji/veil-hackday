# Veil Hack Day Demo

**Veil** = policy / rights layer for cameras.

> Optional Fabric one-liner: this scaffold is a standalone hack-day slice of the broader Veil / Fabric camera-rights narrative — no multi-repo wiring required.

Keep it simple. One Node server on the MacBook. iPhone + iPad open LAN URLs.

---

## Devices → URLs

| Device | Role | URL |
|--------|------|-----|
| **MacBook Pro** | Capture station (Internal + Public) | `http://<LAN-IP>:8787/camera` |
| **iPhone 16 Pro** | Attendee Veil Pass (QR + toggles) | `http://<LAN-IP>:8787/pass` |
| **iPad Pro** | Organizer console | `http://<LAN-IP>:8787/console` |

All devices on the **same Wi‑Fi**. MacBook hosts the server.

---

## How to run (5 min)

```bash
cd veil-hackday
npm install
npm run dev
```

Server prints LAN URL, e.g.:

```
Local:   http://localhost:8787
LAN:     http://192.168.1.42:8787
```

Open those paths on each device.

### Camera permissions

- `getUserMedia` needs a **secure context**: `https://` or `http://localhost`.
- On **LAN HTTP** from iPhone/iPad/Mac to the MacBook IP, Chrome/Safari may block the camera.
- **Hack-day options:**
  1. Open Camera page on the MacBook via `http://localhost:8787/camera` (camera works).
  2. Or click **Use sample still** (built-in backup) — demo still works without a webcam.
  3. Optional: tunnel with something like `npx localtunnel` / ngrok if you need phone→camera (not required for this script).

---

## Demo script (~60s)

1. **MacBook** → `/camera` → Start camera *or* Use sample still → you already have an **Unknown** person track → **Public** pane shows **blur**.
2. **iPhone** → `/pass` → big QR (token). Tap **Allow** for public livestream.
3. **MacBook** → paste `token_id` from Console (or from Pass meta / issue on iPad) → **Bind scanned Pass** → Public pane flips to **live / allow** within ~1.5s.
4. **MacBook** → **Capture clip stub**.
5. **iPad** → `/console` → deny promo (or leave promo off) → **Try export** → **blocked** or **transformed** + receipt appears. Toggle **Allow promo** → export **allowed**. Show **Media Rights Graph**.

Narrative covered:

1. Enter frame → unknown / opt-out → blurred on Public  
2. Present ephemeral credential → scoped policy flips Public live  
3. Change policy after capture → export blocked/transformed + decision receipt  

---

## What works live vs stub

| Piece | Status |
|-------|--------|
| Policy tokens (HMAC-signed JSON) | **Live** |
| decide(token, audience) → allow/blur/deny/export | **Live** (+ unit tests) |
| Pass QR + Allow/Blur/Deny + Revoke | **Live** |
| Camera dual panes + manual person tracks | **Live** (manual boxes, not CV) |
| getUserMedia | **Live on localhost**; LAN HTTP may need backup still |
| Sample still backup | **Live** |
| Bind token → re-decide on poll | **Live** |
| Clip stubs + post-capture export | **Live** (no real video file) |
| Receipts → memory + `data/receipts.jsonl` | **Live** |
| Media Rights Graph | **Live** (JSON list view) |
| Face detection / re-ID / SAM2 / C2PA | **Skipped** (by design) |

---

## Scripts

```bash
npm run dev       # start server (tsx watch)
npm test          # policy unit tests
npm run build     # typecheck (tsc --noEmit)
npm start         # start without watch
```

Default port: **8787** (`PORT` / `HOST` env overrides). HMAC secret: `VEIL_HMAC_SECRET` (demo default is fine for LAN).

---

## Layout

```
veil-hackday/
  README.md
  package.json
  server/          # Express: policy, credentials, tracks/receipts, rights graph
  web/             # /camera /pass /console
  data/            # receipts.jsonl (gitignored contents)
  tests/           # policy decision tests
```

---

## API (quick)

- `POST /api/pass/issue` — create Pass  
- `POST /api/pass/:id/public` `{ mode: allow|blur|deny }`  
- `POST /api/pass/:id/revoke`  
- `PATCH /api/pass/:id` — permissions / treatment  
- `POST /api/decide` `{ token_id?, track_id, audience }`  
- `POST /api/clips` · `POST /api/clips/:id/export`  
- `GET /api/receipts` · `GET /api/rights-graph`  

---

## Explicitly out of scope

SAM2, real re-ID, C2PA, smart glasses, cloud auth, microservices, blockchain, Fabric multi-repo, BLE, legal automation.
