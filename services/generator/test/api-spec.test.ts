import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolDefinition } from "@mcp/types";
import { parseOpenApi, openApiToTools, discoverApiSpecTools, graphqlPassthroughTool } from "../src/api-spec.js";
import type { FetchText } from "../src/sitemap-discovery.js";

/**
 * API-contract ingestion: OpenAPI v2/v3 -> ToolDefinition[], GraphQL passthrough, and the GET-only,
 * fail-soft discovery probe. Pure + offline (an injected FetchText stands in for the network).
 */

const OPENAPI_V3 = {
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0" },
  servers: [{ url: "https://api.example.com/v2" }],
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { name: { type: "string" }, tag: { type: "string" } }, required: ["name"] } } } },
      },
    },
    "/pets/{petId}": {
      get: { operationId: "getPet", parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }] },
      delete: { operationId: "deletePet", parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }] },
    },
  },
};

const SWAGGER_V2 = {
  swagger: "2.0",
  host: "api.swagger.test",
  basePath: "/api",
  schemes: ["https"],
  paths: {
    "/things": {
      get: { operationId: "listThings", parameters: [{ name: "q", in: "query", type: "string" }] },
    },
  },
};

test("parseOpenApi accepts real specs and rejects everything else", () => {
  assert.ok(parseOpenApi(JSON.stringify(OPENAPI_V3)), "valid v3 spec");
  assert.ok(parseOpenApi(JSON.stringify(SWAGGER_V2)), "valid v2 spec");
  assert.equal(parseOpenApi(JSON.stringify({ foo: 1 })), null, "non-spec JSON");
  assert.equal(parseOpenApi("<html>not json</html>"), null, "html");
  assert.equal(parseOpenApi(""), null, "empty");
  assert.equal(parseOpenApi(null), null, "null");
});

test("openApiToTools converts v3 operations with correct names, methods, params and base-path prefix", () => {
  const tools = openApiToTools(parseOpenApi(JSON.stringify(OPENAPI_V3))!, "https://api.example.com");
  const byName = new Map(tools.map((t) => [t.name, t]));

  // Every emitted tool is a valid ToolDefinition.
  for (const t of tools) assert.ok(ToolDefinition.safeParse(t).success, `invalid tool ${t.name}`);

  const list = byName.get("list_pets");
  assert.ok(list, "list_pets");
  assert.equal(list!.execution.kind, "http");
  if (list!.execution.kind === "http") {
    assert.equal(list!.execution.request.method, "GET");
    assert.equal(list!.execution.request.urlPattern, "/v2/pets", "server base-path is folded into urlPattern");
    assert.equal(list!.execution.request.rawUrl, "https://api.example.com/v2/pets");
    assert.deepEqual(list!.execution.paramMapping["limit"], { in: "query", key: "limit" });
  }

  const get = byName.get("get_pet");
  assert.ok(get, "get_pet");
  if (get!.execution.kind === "http") {
    assert.equal(get!.execution.request.urlPattern, "/v2/pets/{petId}", "path placeholder preserved");
    assert.equal(get!.execution.request.rawUrl, "https://api.example.com/v2/pets/{petId}");
    assert.deepEqual(get!.execution.paramMapping["petId"], { in: "path", key: "petId" });
    assert.ok((get!.inputSchema as any).required.includes("petId"), "path param is required");
  }

  // POST body props are lifted to top-level body args, required honored.
  const create = byName.get("create_pet");
  assert.ok(create, "create_pet");
  if (create!.execution.kind === "http") {
    assert.equal(create!.execution.request.method, "POST");
    assert.deepEqual(create!.execution.paramMapping["name"], { in: "body", key: "name" });
    assert.deepEqual(create!.execution.paramMapping["tag"], { in: "body", key: "tag" });
    assert.ok((create!.inputSchema as any).required.includes("name"));
  }

  assert.ok(byName.has("delete_pet"), "delete_pet present");
  assert.ok(tools.every((t) => t.confidence >= 0.8), "published-spec tools are high confidence");
});

test("openApiToTools handles v2 host/basePath/schemes", () => {
  const tools = openApiToTools(parseOpenApi(JSON.stringify(SWAGGER_V2))!, "https://fallback.example.com");
  const list = tools.find((t) => t.name === "list_things");
  assert.ok(list, "list_things");
  if (list!.execution.kind === "http") {
    assert.equal(list!.execution.request.rawUrl, "https://api.swagger.test/api/things");
    assert.equal(list!.execution.request.urlPattern, "/api/things");
  }
});

test("discoverApiSpecTools serves tools from the first reachable OpenAPI doc; none otherwise", async () => {
  const serveSpec: FetchText = async (url) => (url === "https://api.example.com/openapi.json" ? JSON.stringify(OPENAPI_V3) : null);
  const tools = await discoverApiSpecTools("https://api.example.com/some/page", serveSpec);
  assert.ok(tools.length >= 4, "all operations discovered");
  assert.ok(tools.some((t) => t.name === "get_pet"));

  const serveNothing: FetchText = async () => null;
  assert.deepEqual(await discoverApiSpecTools("https://api.example.com/", serveNothing), [], "no spec -> no tools");
});

test("discoverApiSpecTools emits a GraphQL passthrough when an endpoint is detected", async () => {
  const serveGraphql: FetchText = async (url) =>
    url.endsWith("/graphql") ? "<html><title>GraphiQL</title><body>GraphQL Playground</body></html>" : null;
  const tools = await discoverApiSpecTools("https://gql.example.com/", serveGraphql);
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool.name, "graphql_query");
  if (tool.execution.kind === "http") {
    assert.equal(tool.execution.request.method, "POST");
    assert.equal(tool.execution.request.rawUrl, "https://gql.example.com/graphql");
    assert.deepEqual(tool.execution.paramMapping["query"], { in: "body", key: "query" });
  }
});

test("graphqlPassthroughTool builds a valid ToolDefinition", () => {
  const tool = graphqlPassthroughTool("https://x.example.com/api/graphql");
  assert.ok(tool && ToolDefinition.safeParse(tool).success);
  if (tool && tool.execution.kind === "http") assert.equal(tool.execution.request.urlPattern, "/api/graphql");
});
