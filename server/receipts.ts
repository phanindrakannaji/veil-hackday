/**
 * Decision receipts — memory + JSON file under data/.
 */

import { appendFileSync, mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface Receipt {
  token_id: string;
  track_id: string;
  audience: string;
  action: string;
  reason?: string;
  ts: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const RECEIPTS_FILE = join(DATA_DIR, "receipts.jsonl");

const memory: Receipt[] = [];

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export function writeReceipt(r: Omit<Receipt, "ts"> & { ts?: string }): Receipt {
  const receipt: Receipt = {
    ...r,
    ts: r.ts ?? new Date().toISOString(),
  };
  memory.push(receipt);
  ensureDataDir();
  appendFileSync(RECEIPTS_FILE, JSON.stringify(receipt) + "\n", "utf8");
  return receipt;
}

export function listReceipts(): Receipt[] {
  return [...memory];
}

export function clearReceipts(): void {
  memory.length = 0;
  ensureDataDir();
  writeFileSync(RECEIPTS_FILE, "", "utf8");
}

export function loadReceiptsFromDisk(): Receipt[] {
  ensureDataDir();
  if (!existsSync(RECEIPTS_FILE)) return [];
  const lines = readFileSync(RECEIPTS_FILE, "utf8").split("\n").filter(Boolean);
  const loaded: Receipt[] = [];
  for (const line of lines) {
    try {
      loaded.push(JSON.parse(line) as Receipt);
    } catch {
      /* skip bad lines */
    }
  }
  // hydrate memory if empty
  if (memory.length === 0) memory.push(...loaded);
  return loaded;
}
