/**
 * Veil Hack Day — Express server.
 * Serves API + static web pages. Prints LAN URL on boot.
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { networkInterfaces } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { api } from "./routes.js";
import { loadReceiptsFromDisk } from "./receipts.js";
import { initNeo4j, closeNeo4j, isNeo4jReady, getNeo4jUri } from "./neo4j.js";
import { isOpenRouterReady, getOpenRouterModel } from "./openrouter.js";

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
app.get("/cue", (_req, res) => res.sendFile(join(webRoot, "cue.html")));

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

async function boot() {
  await initNeo4j();
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
    if (isNeo4jReady()) {
      console.log(`  Rights graph: Neo4j · ${getNeo4jUri()}`);
    } else {
      console.log("  Rights graph: in-memory (Neo4j unavailable)");
    }
    if (isOpenRouterReady()) {
      console.log(`  Explain: OpenRouter · ${getOpenRouterModel()}`);
    } else {
      console.log("  Explain: OpenRouter not configured");
    }
    console.log("");
    console.log("  Note: browsers require HTTPS (or localhost) for getUserMedia.");
    console.log("  On LAN HTTP, use Chrome flag or backup still/video if camera blocked.");
    console.log("");
  });
}

boot().catch((err) => {
  console.error("boot failed:", err);
  process.exit(1);
});

async function shutdown() {
  await closeNeo4j();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
