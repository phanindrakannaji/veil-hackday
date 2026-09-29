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

## 60s script (hardened bind)

1. **MacBook** `/camera` — camera or sample still; **Unknown** track; **PUBLIC** shows **blur**.
2. **iPhone** `/pass` — Pass issues itself (token + Copy + QR). Tap **Allow**.
3. **MacBook** → **Scan / bind latest Pass** (or open QR URL `…/camera?bind=<token_id>`). **PUBLIC** flips to **allow** within ~1s.
4. **MacBook** → **Capture clip**.
5. **iPad** `/console` → **Latest clip** → **Deny promo → re-export** (blocked/transformed + receipt) → **Allow promo → re-export** (allowed). Optional: Pass **Revoke** → PUBLIC goes **deny** on next tick.

Console **Issue Pass** sets the current bindable token. **Demo reset** clears tokens/clips/receipts; Camera re-seeds one Unknown.

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
- `POST /api/decide` · `POST /api/clips` · `POST /api/clips/:id/export` · `POST /api/clips/:id/policy-export`
- `GET /api/receipts` · `GET /api/rights-graph` · `POST /api/demo/reset` · `GET /api/demo/epoch`

**Out of scope:** SAM2, CV re-ID, C2PA, blockchain, HTTPS tunnels for happy path, microservices.
