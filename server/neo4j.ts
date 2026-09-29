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

export type RevokeImpactClip = {
  clip_id: string;
  label?: string;
  export_status?: string;
  track_id?: string;
  captured_at?: string;
  exports: Array<{ action?: string; ts?: string; person?: string }>;
};

export type RevokeImpactGraph = {
  backend: "neo4j" | "memory";
  token_id: string;
  subject?: string;
  pass_found: boolean;
  clips: RevokeImpactClip[];
  clip_count: number;
  export_count: number;
};

/** Blast radius for a Pass token — Neo4j CAPTURED clips + EXPORTED edges. */
export async function queryRevokeImpact(
  tokenId: string
): Promise<RevokeImpactGraph | null> {
  const d = getDriver();
  if (!d) return null;
  const session = d.session();
  try {
    const res = await session.run(
      `
      OPTIONAL MATCH (pass:Pass {token_id: $id})
      OPTIONAL MATCH (pass)-[:CAPTURED]->(c:Clip)
      OPTIONAL MATCH (p:Person)-[e:EXPORTED]->(c)
      RETURN pass,
             pass.subject AS subject,
             c,
             collect(DISTINCT {
               action: e.action,
               ts: e.ts,
               person: p.name
             }) AS exports
      `,
      { id: tokenId }
    );

    if (!res.records.length) {
      return {
        backend: "neo4j",
        token_id: tokenId,
        pass_found: false,
        clips: [],
        clip_count: 0,
        export_count: 0,
      };
    }

    const first = res.records[0];
    const passNode = first.get("pass");
    const subject =
      (first.get("subject") as string | null) ||
      (passNode?.properties?.subject as string | undefined);

    const clips: RevokeImpactClip[] = [];
    let exportCount = 0;
    for (const rec of res.records) {
      const c = rec.get("c");
      if (!c) continue;
      const props = c.properties as Record<string, unknown>;
      const rawExports = (rec.get("exports") as Array<Record<string, unknown>>) || [];
      const exports = rawExports
        .filter((e) => e && (e.action != null || e.ts != null || e.person != null))
        .map((e) => ({
          action: e.action != null ? String(e.action) : undefined,
          ts: e.ts != null ? String(e.ts) : undefined,
          person: e.person != null ? String(e.person) : undefined,
        }));
      exportCount += exports.length;
      clips.push({
        clip_id: String(props.clip_id ?? ""),
        label: props.label != null ? String(props.label) : undefined,
        export_status:
          props.export_status != null ? String(props.export_status) : undefined,
        track_id: props.track_id != null ? String(props.track_id) : undefined,
        captured_at:
          props.captured_at != null ? String(props.captured_at) : undefined,
        exports,
      });
    }

    // Dedupe by clip_id (query can repeat if multiple export rows)
    const byId = new Map<string, RevokeImpactClip>();
    for (const clip of clips) {
      if (!clip.clip_id) continue;
      const prev = byId.get(clip.clip_id);
      if (!prev) {
        byId.set(clip.clip_id, clip);
      } else {
        const seen = new Set(prev.exports.map((e) => `${e.action}|${e.ts}|${e.person}`));
        for (const e of clip.exports) {
          const k = `${e.action}|${e.ts}|${e.person}`;
          if (!seen.has(k)) prev.exports.push(e);
        }
      }
    }
    const unique = Array.from(byId.values());
    exportCount = unique.reduce((n, c) => n + c.exports.length, 0);

    return {
      backend: "neo4j",
      token_id: tokenId,
      subject: subject || undefined,
      pass_found: Boolean(passNode),
      clips: unique,
      clip_count: unique.length,
      export_count: exportCount,
    };
  } catch (err) {
    console.warn("[neo4j] queryRevokeImpact failed:", (err as Error).message);
    return null;
  } finally {
    await session.close();
  }
}
