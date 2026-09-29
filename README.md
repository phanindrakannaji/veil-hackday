# Veil Hack Day Demo

**Veil** = policy / rights layer for cameras. One Node server. MacBook + iPhone + iPad on the same LAN.

| Device | Role | URL |
|--------|------|-----|
| **MacBook** | Camera (Internal + Public) | `http://localhost:8787/camera` |
| **iPhone** | Veil Pass | `http://<LAN-IP>:8787/pass` |
| **iPad** | Console | `http://<LAN-IP>:8787/console` |

```bash
cd veil-hackday && npm install && npm run dev
```

Server prints Local + LAN URLs. Default port **8787**.

---

## 60s script (Consent Station flow)

1. **MacBook** `/camera` — camera or sample still; **Unknown** track; **PUBLIC** shows **blur**.
2. **iPhone** `/pass` — Pass issues itself (token + Copy + QR). Tap **Allow**.
3. **MacBook** → **Consent Station ON** → hold Pass QR to camera (scans and binds to best unbound face). OR **Bind latest Pass** (or open QR URL `…/camera?bind=<token_id>`). **PUBLIC** flips to **allow** within ~1s. Pass shows **"Linked to Camera"** chip.
4. **MacBook** → **Capture clip**.
5. **iPad** `/console` → **Latest clip** → **Deny promo → re-export** (blocked/transformed + receipt) → **Allow promo → re-export** (allowed). Optional: Pass **Revoke** → PUBLIC goes **deny** on next tick.

Console **Issue Pass** sets the current bindable token. **Demo reset** clears tokens/clips/receipts/bindings; Camera re-seeds one Unknown.

### Consent Station mode

Camera page now includes **Consent Station** toggle. When ON:
- Scans live video for Pass QR codes (BarcodeDetector preferred; jsQR CDN fallback)
- Parses `/camera?bind=<token_id>`, URL with `bind=`, or bare token_id
- Binds valid active Pass to best unbound face (largest near center)
- Debounces same token ~3s to avoid duplicate scans
- Pass page polls `GET /api/pass/:id/binding` every ~2s and shows **"Linked to Camera"** vs **"Not linked"** chip
- Station enrollment flow for crowds: each person scans their own Pass QR
- Identity = Pass bind, NOT face biometrics (MediaPipe = geometry only; unbound faces → public blur)

---

## If X breaks → Y

| Problem | Fix |
|---------|-----|
| Camera blocked / blank | Banner + sample still auto-loads. Or click **Use sample still**. Prefer `localhost` on Mac for getUserMedia. |
| Wrong Wi‑Fi / can’t reach Pass/Console | Same LAN as Mac. Use the printed `LAN: http://…:8787` URL, not another machine’s IP. |
| Stale / wrong token on bind | Console **Issue Pass** or Pass **Get new Pass**, then Camera **Scan / bind latest Pass**. Or **Demo reset** and re-run script. |
| PUBLIC stuck on blur after Allow | Wait ≤1s (800ms poll). Confirm Pass shows Allow badge, then bind again. |
| Clip / export not showing | Capture on Camera first; Console **Latest clip** refreshes every 2s. |
| Need clean slate mid-demo | Console **Demo reset** or `POST /api/demo/reset`. |

---

## Scripts

```bash
npm run dev    # tsx watch
npm test       # policy unit tests
npm run build  # tsc --noEmit
npm start
```

HMAC secret: `VEIL_HMAC_SECRET` (demo default OK on LAN).

---

## API (quick)

- `POST /api/pass/issue` · `GET /api/pass/latest` · `POST /api/pass/:id/public` · `POST /api/pass/:id/revoke`
- `POST /api/bind` · `GET /api/pass/:id/binding` (Consent Station registry)
- `POST /api/decide` · `POST /api/clips` · `POST /api/clips/:id/export` · `POST /api/clips/:id/policy-export`
- `GET /api/receipts` · `GET /api/rights-graph` · `GET /api/neo4j/status` · `GET /api/ai/status` · `GET /api/crusoe/status` · `GET /api/openrouter/status`
- `POST /api/ai/explain` · `POST /api/ai/consent-brief` · `POST /api/ai/revoke-impact` · `POST /api/ai/judge-panel` · `GET /api/ai/anomalies`
- `POST /api/demo/reset` · `GET /api/demo/epoch`


---

## AI layer (Crusoe → OpenRouter) + anomalies

Console chips: **AI · Crusoe** (primary) and **AI · OpenRouter** (fallback / judge panel).

| Feature | Endpoint | Backend |
|---------|----------|---------|
| Explain decision | `POST /api/ai/explain` | **Crusoe first**, OpenRouter on failure/timeout |
| Consent brief | `POST /api/ai/consent-brief` | Crusoe (auto fallback) — 3-sentence organizer brief |
| Revoke impact | `POST /api/ai/revoke-impact` `{ token_id }` | Neo4j blast radius → Crusoe narrative (memory fallback) |
| Judge panel | `POST /api/ai/judge-panel` | 2–3 OpenRouter models in parallel |
| Anomalies | `GET /api/ai/anomalies` | Pure heuristics (no LLM) |
| Status | `GET /api/ai/status` | `{ crusoe, openrouter, neo4j }` |

```bash
# in .env (never commit keys)
CRUSOE_API_KEY=...
CRUSOE_BASE_URL=https://api.inference.crusoecloud.com/v1
CRUSOE_MODEL=deepseek-ai/Deepseek-V4-Flash   # demo latency; override GLM-5.3-Flash / gpt-oss-120b
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=openai/gpt-4o-mini
OPENROUTER_PANEL_MODELS=openai/gpt-4o-mini,qwen/qwen-2.5-7b-instruct,mistralai/mistral-small-3.1-24b-instruct
```

Compat: `GET /api/crusoe/status` · `GET /api/openrouter/status` still work.

## Media Rights Graph (Neo4j)

Dual-write: in-memory for fast demo API; Neo4j MERGEs when Docker `veil-neo4j` is up.

```bash
docker run -d --name veil-neo4j -p 7474:7474 -p 7687:7687 -e NEO4J_AUTH=neo4j/veil-hackday neo4j:5
cp .env.example .env   # NEO4J_URI / USER / PASSWORD
```

Browser: http://localhost:7474 · `neo4j` / `veil-hackday` (demo only).  
`GET /api/neo4j/status` · `GET /api/rights-graph` includes `"backend": "neo4j"|"memory"`.

**Out of scope:** SAM2, CV re-ID, C2PA, blockchain, HTTPS tunnels for happy path, microservices.
