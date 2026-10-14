// MACHINE ONLY. This app's production address, from Task & Tool (the
// bridge's `addresses`), for a proposal's link: the team works on dev, and
// customers open proposals in production. Read with the machine's own token
// from the environment, else ~/.env, as the machine's scripts read it.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Production = { url: string | null; deployed: boolean };

function machineEnv(): { url: string; token: string } | null {
  const found: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(homedir(), ".env"), "utf8").split("\n")) {
      const m = /^(?:export )?(PHOENIX_URL|MACHINE_TOKEN)=(.*)$/.exec(line.trim());
      if (m) found[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {}
  const url = process.env.PHOENIX_URL || found.PHOENIX_URL;
  const token = process.env.MACHINE_TOKEN || found.MACHINE_TOKEN;
  return url && token ? { url, token } : null;
}

/** Production's address and whether it was ever deployed; null off a Task & Tool machine or when it does not answer. */
export async function production(): Promise<Production | null> {
  const env = machineEnv();
  if (!env) return null;
  try {
    const res = await fetch(`${env.url}/api/machine/serving`, { headers: { authorization: `Bearer ${env.token}` }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { production_url?: string | null; deployed_at?: string | null };
    return { url: body.production_url ?? null, deployed: !!body.deployed_at };
  } catch {
    return null;
  }
}
