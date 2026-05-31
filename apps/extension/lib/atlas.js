export const ATLAS_STORAGE_KEYS = {
  endpoint: "atlasEndpoint",
  apiKey: "atlasApiKey",
  dataSource: "atlasDataSource",
  database: "atlasDatabase",
  collection: "atlasCollection",
};

export const ATLAS_DEFAULTS = {
  dataSource: "Cluster0",
  database: "mcp_forge",
  collection: "tools",
};

function trim(v) {
  return String(v ?? "").trim();
}

function parseErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error || parsed?.message || text;
  } catch {
    return text;
  }
}

export function normalizeAtlasSettings(stored = {}) {
  return {
    endpoint: trim(stored[ATLAS_STORAGE_KEYS.endpoint]),
    apiKey: trim(stored[ATLAS_STORAGE_KEYS.apiKey]),
    dataSource: trim(stored[ATLAS_STORAGE_KEYS.dataSource]) || ATLAS_DEFAULTS.dataSource,
    database: trim(stored[ATLAS_STORAGE_KEYS.database]) || ATLAS_DEFAULTS.database,
    collection: trim(stored[ATLAS_STORAGE_KEYS.collection]) || ATLAS_DEFAULTS.collection,
  };
}

export async function getAtlasSettings() {
  const stored = await chrome.storage.local.get(Object.values(ATLAS_STORAGE_KEYS)).catch(() => ({}));
  return normalizeAtlasSettings(stored);
}

export async function setAtlasSettings(settings) {
  await chrome.storage.local.set({
    [ATLAS_STORAGE_KEYS.endpoint]: trim(settings.endpoint),
    [ATLAS_STORAGE_KEYS.apiKey]: trim(settings.apiKey),
    [ATLAS_STORAGE_KEYS.dataSource]: trim(settings.dataSource) || ATLAS_DEFAULTS.dataSource,
    [ATLAS_STORAGE_KEYS.database]: trim(settings.database) || ATLAS_DEFAULTS.database,
    [ATLAS_STORAGE_KEYS.collection]: trim(settings.collection) || ATLAS_DEFAULTS.collection,
  });
}

function isReady(settings) {
  return Boolean(settings?.endpoint && settings?.apiKey);
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

async function atlasAction(action, body, settings) {
  const base = settings.endpoint.replace(/\/$/, "");
  const res = await fetch(`${base}/action/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": settings.apiKey,
    },
    body: JSON.stringify({
      dataSource: settings.dataSource,
      database: settings.database,
      collection: settings.collection,
      ...body,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Atlas ${action} failed (${res.status}): ${parseErrorBody(text) || "unknown error"}`);
  }
  return res.json();
}

// Returns the stored document for this domain, or null if not found / not configured.
export async function fetchToolsFromAtlas(url, settings) {
  if (!isReady(settings)) return null;
  const domain = domainOf(url);
  if (!domain) return null;
  const data = await atlasAction("findOne", {
    filter: { domain },
    projection: { _id: 0 },
  }, settings);
  return data?.document || null;
}

// Upserts a tool record for this domain. `record` should contain { serverId, tools, version, title }.
export async function saveToolsToAtlas(url, record, settings) {
  if (!isReady(settings)) return;
  const domain = domainOf(url);
  if (!domain) return;
  await atlasAction("updateOne", {
    filter: { domain },
    update: {
      $set: {
        domain,
        origin: (() => { try { return new URL(url).origin; } catch { return url; } })(),
        ...record,
        updatedAt: new Date().toISOString(),
      },
    },
    upsert: true,
  }, settings);
}
