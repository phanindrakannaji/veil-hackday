/**
 * Neo4j connection for Media Rights Graph.
 * Tries to connect on boot; if unavailable, disables once and falls back to memory.
 */

import neo4j, { type Driver } from "neo4j-driver";

const URI = process.env.NEO4J_URI || "bolt://127.0.0.1:7687";
const USER = process.env.NEO4J_USER || "neo4j";
const PASSWORD = process.env.NEO4J_PASSWORD || "veil-hackday";

/** Explicit disable via NEO4J_ENABLED=0|false|off */
function envWantsNeo4j(): boolean {
  const v = (process.env.NEO4J_ENABLED || "").toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

let driver: Driver | null = null;
let ready = false;
let disabledLogged = false;
let initPromise: Promise<boolean> | null = null;

function logDisableOnce(reason: string) {
  if (disabledLogged) return;
  disabledLogged = true;
  console.warn(`[neo4j] disabled — using in-memory rights graph (${reason})`);
}

export function isNeo4jReady(): boolean {
  return ready && driver !== null;
}

export function getDriver(): Driver | null {
  return isNeo4jReady() ? driver : null;
}

export function getNeo4jUri(): string {
  return URI;
}

/** Best-effort connect. Safe to call multiple times; returns whether ready. */
export async function initNeo4j(): Promise<boolean> {
  if (!envWantsNeo4j()) {
    logDisableOnce("NEO4J_ENABLED off");
    return false;
  }
  if (ready && driver) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      const d = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD), {
        connectionTimeout: 3_000,
        maxConnectionPoolSize: 8,
      });
      await d.verifyConnectivity();
      driver = d;
      ready = true;
      console.log(`[neo4j] connected · ${URI}`);
      try {
        await ensureSchema();
      } catch (err) {
        console.warn("[neo4j] ensureSchema soft-fail:", (err as Error).message);
      }
      return true;
    } catch (err) {
      ready = false;
      if (driver) {
        try {
          await driver.close();
        } catch {
          /* ignore */
        }
      }
      driver = null;
      logDisableOnce((err as Error).message || "connect failed");
      return false;
    } finally {
      initPromise = null;
    }
  })();

  return initPromise;
}

export async function ensureSchema(): Promise<void> {
  const d = getDriver();
  if (!d) return;
  const session = d.session();
  try {
    // Optional uniqueness — CREATE IF NOT EXISTS is Neo4j 5+
    await session.run(
      `CREATE CONSTRAINT veil_clip_id IF NOT EXISTS FOR (c:Clip) REQUIRE c.clip_id IS UNIQUE`
    );
    await session.run(
      `CREATE CONSTRAINT veil_pass_token IF NOT EXISTS FOR (p:Pass) REQUIRE p.token_id IS UNIQUE`
    );
  } finally {
    await session.close();
  }
}

export async function closeNeo4j(): Promise<void> {
  ready = false;
  if (driver) {
    try {
      await driver.close();
    } catch {
      /* ignore */
    }
    driver = null;
  }
}

/** Count Veil demo nodes / relationships for status enrichment. */
export async function countVeilGraph(): Promise<{ nodes: number; relationships: number } | null> {
  const d = getDriver();
  if (!d) return null;
  const session = d.session();
  try {
    const nodesRes = await session.run(
      `MATCH (n) WHERE n:Person OR n:Pass OR n:Clip RETURN count(n) AS n`
    );
    const relsRes = await session.run(
      `MATCH ()-[r]->() WHERE type(r) IN ['HOLDS','CAPTURED','EXPORTED'] RETURN count(r) AS r`
    );
    const nodes = Number(nodesRes.records[0]?.get("n") ?? 0);
    const relationships = Number(relsRes.records[0]?.get("r") ?? 0);
    return { nodes, relationships };
  } catch {
    return null;
  } finally {
    await session.close();
  }
}
