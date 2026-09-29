/**
 * Veil Hack Day — Express server.
 * Serves API + static web pages. Prints LAN URL on boot.
 */

import express from "express";
import cors from "cors";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes.js";
import { loadReceiptsFromDisk } from "./receipts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";

loadReceiptsFromDisk();

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api", api);

const webRoot = join(__dirname, "..", "web");
app.use(express.static(webRoot));

// Friendly SPA-ish routes
app.get("/camera", (_req, res) => res.sendFile(join(webRoot, "camera.html")));
app.get("/pass", (_req, res) => res.sendFile(join(webRoot, "pass.html")));
app.get("/console", (_req, res) => res.sendFile(join(webRoot, "console.html")));

function lanIPs(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

app.listen(PORT, HOST, () => {
  const ips = lanIPs();
  console.log("");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║         Veil Hack Day — server ready         ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  LAN:     http://${ip}:${PORT}`);
  }
  console.log("");
  console.log("  Devices:");
  console.log(`    MacBook  → /camera`);
  console.log(`    iPhone   → /pass`);
  console.log(`    iPad     → /console`);
  console.log("");
  console.log("  Note: browsers require HTTPS (or localhost) for getUserMedia.");
  console.log("  On LAN HTTP, use Chrome flag or backup still/video if camera blocked.");
  console.log("");
});
