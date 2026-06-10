import { ToolDefinition } from "@mcp/types";
import type { FetchText } from "./sitemap-discovery.js";

type JsonObject = Record<string, unknown>;

/**
 * API-contract ingestion: probe a site's well-known OpenAPI/Swagger/GraphQL locations and convert them to
 * ToolDefinition[]. Pure conversion core; network is injected via FetchText (GET-only, bounded, fail-soft).
 */

// Probed in order; first usable doc wins.
const OPENAPI_CANDIDATES = [
  "/openapi.json",
  "/swagger.json",
  "/swagger/v1/swagger.json",
  "/v3/api-docs",
  "/api-docs",
  "/api-docs.json",
  "/api/openapi.json",
  "/api/swagger.json",
  "/v1/openapi.json",
  "/openapi/v1.json",
  "/.well-known/openapi.json",
  "/docs/openapi.json",
];

// Conventional GraphQL endpoints. A GET usually returns the GraphiQL/Playground HTML (detected below).
const GRAPHQL_CANDIDATES = ["/graphql", "/api/graphql", "/v1/graphql", "/query", "/gql"];

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
const JSON_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

export interface ApiSpecDiscoveryOptions {
  /** Max OpenAPI doc locations to probe. */
  maxProbes?: number;
  /** Max tools to emit from a spec (cost/quality bound). */
  maxTools?: number;
  /** Probe for a GraphQL endpoint and emit a passthrough tool when one is found. Default true. */
  graphql?: boolean;
}

/** Parse text as an OpenAPI/Swagger document; null if it isn't valid JSON or isn't recognizably a spec. */
export function parseOpenApi(text: string | null | undefined): JsonObject | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // YAML specs are not handled in v1 (no parser dependency); only application/json docs.
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as JsonObject;
  const isSpec =
    (typeof obj["openapi"] === "string" || typeof obj["swagger"] === "string") &&
    obj["paths"] != null &&
    typeof obj["paths"] === "object";
  return isSpec ? obj : null;
}

function sanitizeName(value: string): string {
  const cleaned = String(value || "")
    // camelCase / PascalCase -> snake_case (so "listPets" -> "list_pets", and the write-classifier sees
    // "create"/"delete" as whole tokens). Split lower|digit -> Upper boundaries before normalizing.
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, 64);
  if (!cleaned) return "";
  return /^[a-z]/.test(cleaned) ? cleaned : `op_${cleaned}`.slice(0, 64);
}

/** Property name for an input arg: a valid identifier (the original key is kept in paramMapping). */
function sanitizeParam(name: string): string {
  const cleaned = String(name || "").replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || "arg";
}

/** The base URL the spec's operations are served from (v3 `servers`, v2 `host`/`basePath`/`schemes`, else origin). */
function baseUrlOf(spec: JsonObject, origin: string): string {
  const servers = spec["servers"];
  if (Array.isArray(servers) && servers.length) {
    const first = servers[0] as { url?: unknown } | undefined;
    if (first && typeof first.url === "string" && first.url) {
      try {
        return new URL(first.url, origin).toString().replace(/\/+$/, "");
      } catch {
        /* fall through */
      }
    }
  }
  const host = spec["host"];
  if (typeof host === "string" && host) {
    const schemes = spec["schemes"];
    const scheme =
      Array.isArray(schemes) && schemes.includes("https")
        ? "https"
        : Array.isArray(schemes) && typeof schemes[0] === "string"
          ? (schemes[0] as string)
          : "https";
    const basePath = typeof spec["basePath"] === "string" ? (spec["basePath"] as string) : "";
    return `${scheme}://${host}${basePath}`.replace(/\/+$/, "");
  }
  return origin.replace(/\/+$/, "");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathPrefixOf(baseUrl: string): string {
  try {
    const p = new URL(baseUrl).pathname.replace(/\/+$/, "");
    return p === "/" ? "" : p;
  } catch {
    return "";
  }
}

/** JSON-Schema-ish type for one parameter/property (best-effort; defaults to string). */
function schemaTypeOf(node: unknown): { type: string; description?: string } {
  const obj = (node ?? {}) as { type?: unknown; description?: unknown; schema?: unknown };
  // OpenAPI v3 puts the type under `schema`; v2 inlines it on the parameter.
  const inner = (obj.schema ?? obj) as { type?: unknown };
  const t = typeof inner.type === "string" && JSON_TYPES.has(inner.type) ? inner.type : "string";
  const out: { type: string; description?: string } = { type: t };
  if (typeof obj.description === "string" && obj.description.trim()) out.description = obj.description.slice(0, 300);
  return out;
}

interface OperationInputs {
  properties: Record<string, { type: string; description?: string }>;
  required: string[];
  paramMapping: Record<string, { in: "path" | "query" | "header" | "body"; key: string }>;
}

function uniqueKey(name: string, seen: Set<string>): string {
  const base = name || "arg";
  let candidate = base;
  let i = 2;
  while (seen.has(candidate)) candidate = `${base}_${i++}`;
  seen.add(candidate);
  return candidate;
}

function addBodyProps(
  schema: { properties?: Record<string, unknown>; required?: unknown } | undefined,
  inputs: OperationInputs,
  seen: Set<string>,
): void {
  const props = schema?.properties;
  if (!props || typeof props !== "object") return;
  const requiredKeys = new Set(Array.isArray(schema?.required) ? (schema!.required as unknown[]).map(String) : []);
  for (const [origKey, def] of Object.entries(props)) {
    const propName = uniqueKey(sanitizeParam(origKey), seen);
    inputs.properties[propName] = schemaTypeOf(def);
    inputs.paramMapping[propName] = { in: "body", key: origKey };
    if (requiredKeys.has(origKey)) inputs.required.push(propName);
  }
}

function collectInputs(pathParams: unknown[], op: JsonObject): OperationInputs {
  const inputs: OperationInputs = { properties: {}, required: [], paramMapping: {} };
  const seen = new Set<string>();

  const params = [...(Array.isArray(pathParams) ? pathParams : []), ...(Array.isArray(op["parameters"]) ? (op["parameters"] as unknown[]) : [])];
  for (const raw of params) {
    if (!raw || typeof raw !== "object" || "$ref" in (raw as object)) continue; // $ref resolution is out of scope for v1
    const p = raw as { name?: unknown; in?: unknown; required?: unknown; schema?: unknown; description?: unknown };
    const loc = String(p.in || "");
    const origKey = String(p.name || "");
    if (loc === "body") {
      addBodyProps(p.schema as { properties?: Record<string, unknown>; required?: unknown } | undefined, inputs, seen);
      continue;
    }
    if (!origKey) continue;
    if (loc !== "path" && loc !== "query" && loc !== "header") continue; // skip cookie/unknown
    const propName = uniqueKey(sanitizeParam(origKey), seen);
    inputs.properties[propName] = schemaTypeOf(p);
    inputs.paramMapping[propName] = { in: loc, key: origKey };
    if (p.required === true || loc === "path") inputs.required.push(propName);
  }

  // v3 requestBody (application/json) -> top-level body args.
  const rb = op["requestBody"] as { content?: Record<string, { schema?: { properties?: Record<string, unknown>; required?: unknown } }> } | undefined;
  const jsonSchema = rb?.content?.["application/json"]?.schema;
  if (jsonSchema) addBodyProps(jsonSchema, inputs, seen);

  return inputs;
}

/**
 * Convert an OpenAPI v2/v3 document into ToolDefinitions (one per operation). Pure and fail-soft: a malformed
 * operation is skipped, never thrown. Names come from operationId (deduped); path templates keep `{param}` so
 * codegen + the verifier treat them consistently. High confidence (0.85) - a published spec is strong signal.
 */
export function openApiToTools(spec: JsonObject, origin: string, maxTools = 80): ToolDefinition[] {
  const paths = spec["paths"];
  if (!paths || typeof paths !== "object") return [];
  const baseUrl = baseUrlOf(spec, origin);
  const base = originOf(baseUrl) ?? origin.replace(/\/+$/, "");
  const prefix = pathPrefixOf(baseUrl);
  const tools: ToolDefinition[] = [];
  const usedNames = new Set<string>();

  for (const [rawPath, pathItemRaw] of Object.entries(paths as Record<string, unknown>)) {
    if (tools.length >= maxTools) break;
    if (!rawPath.startsWith("/") || !pathItemRaw || typeof pathItemRaw !== "object") continue;
    const pathItem = pathItemRaw as JsonObject;
    const sharedParams = Array.isArray(pathItem["parameters"]) ? (pathItem["parameters"] as unknown[]) : [];
    for (const method of HTTP_METHODS) {
      if (tools.length >= maxTools) break;
      const opRaw = pathItem[method];
      if (!opRaw || typeof opRaw !== "object") continue;
      const op = opRaw as JsonObject;
      if (op["deprecated"] === true) continue;

      const urlPattern = `${prefix}${rawPath}`;
      const rawUrl = `${base}${urlPattern}`;
      try {
        new URL(rawUrl); // rawUrl carries `{param}` placeholders, which is a constructable URL.
      } catch {
        continue;
      }

      const opId = typeof op["operationId"] === "string" ? op["operationId"] : "";
      const slug = sanitizeName(opId) || sanitizeName(`${method}_${rawPath.replace(/\{[^}]+\}/g, "by")}`) || `${method}_endpoint`;
      const name = uniqueKey(slug, usedNames);

      const summary = typeof op["summary"] === "string" ? op["summary"] : "";
      const desc = typeof op["description"] === "string" ? op["description"] : "";
      const description = (summary || desc || `${method.toUpperCase()} ${rawPath}`).slice(0, 1000);

      const inputs = collectInputs(sharedParams, op);
      const inputSchema = inputs.required.length
        ? { type: "object", properties: inputs.properties, required: inputs.required }
        : { type: "object", properties: inputs.properties };

      const candidate = {
        name,
        description,
        inputSchema,
        execution: {
          kind: "http" as const,
          request: {
            method: method.toUpperCase(),
            urlPattern,
            rawUrl,
            requestHeaders: { accept: "application/json" },
            statusCode: 200,
            contentType: "application/json",
          },
          paramMapping: inputs.paramMapping,
        },
        confidence: 0.85,
      };
      const parsed = ToolDefinition.safeParse(candidate);
      if (parsed.success) tools.push(parsed.data);
    }
  }
  return tools;
}

/** A generic GraphQL passthrough tool: the model supplies the query/variables. confidence 0.7. */
export function graphqlPassthroughTool(endpointUrl: string): ToolDefinition | null {
  let urlPattern = "/graphql";
  try {
    urlPattern = new URL(endpointUrl).pathname || "/graphql";
  } catch {
    return null;
  }
  const candidate = {
    name: "graphql_query",
    description:
      `Run a GraphQL operation against ${endpointUrl}. Pass "query" (a GraphQL document) and optional "variables" (a JSON object). ` +
      `Use it for queries; mutations also go through here, so treat write operations with care.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The GraphQL query or mutation document." },
        variables: { type: "object", description: "Optional variables object for the query." },
      },
      required: ["query"],
    },
    execution: {
      kind: "http" as const,
      request: {
        method: "POST",
        urlPattern,
        rawUrl: endpointUrl,
        requestHeaders: { accept: "application/json", "content-type": "application/json" },
        statusCode: 200,
        contentType: "application/json",
      },
      paramMapping: {
        query: { in: "body" as const, key: "query" },
        variables: { in: "body" as const, key: "variables" },
      },
    },
    confidence: 0.7,
  };
  const parsed = ToolDefinition.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Heuristic: does a GET response to a candidate path look like a live GraphQL endpoint (playground/error)? */
function looksLikeGraphql(body: string | null): boolean {
  if (!body) return false;
  const hay = body.slice(0, 20000).toLowerCase();
  return (
    hay.includes("graphiql") ||
    hay.includes("graphql playground") ||
    (hay.includes('"data"') && hay.includes('"errors"')) ||
    /must provide query string|missing query|graphql/i.test(hay)
  );
}

/**
 * Discover API-contract tools for a site: probe the well-known OpenAPI/Swagger locations and (optionally) a
 * GraphQL endpoint, converting the first usable contract into ToolDefinitions. Bounded and fail-soft - any
 * fetch/parse failure simply yields fewer (or zero) tools, never an error.
 */
export async function discoverApiSpecTools(
  pageUrl: string,
  fetchText: FetchText,
  opts: ApiSpecDiscoveryOptions = {},
): Promise<ToolDefinition[]> {
  const maxProbes = opts.maxProbes ?? OPENAPI_CANDIDATES.length;
  const maxTools = opts.maxTools ?? 80;
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return [];
  }

  const tools: ToolDefinition[] = [];

  // 1) OpenAPI / Swagger: first parseable doc wins.
  let probed = 0;
  for (const candidate of OPENAPI_CANDIDATES) {
    if (probed >= maxProbes) break;
    probed++;
    const text = await fetchText(`${origin}${candidate}`);
    const spec = parseOpenApi(text);
    if (spec) {
      tools.push(...openApiToTools(spec, origin, maxTools));
      break;
    }
  }

  // 2) GraphQL: a passthrough tool when an endpoint is detected.
  if (opts.graphql !== false && tools.length < maxTools) {
    for (const candidate of GRAPHQL_CANDIDATES) {
      const endpoint = `${origin}${candidate}`;
      const body = await fetchText(endpoint);
      if (looksLikeGraphql(body)) {
        const tool = graphqlPassthroughTool(endpoint);
        if (tool && !tools.some((t) => t.name === tool.name)) tools.push(tool);
        break;
      }
    }
  }

  return tools.slice(0, maxTools);
}
