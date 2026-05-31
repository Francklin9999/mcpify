import { HeuristicInferenceClient, inferTools } from "../dist/src/index.js";

const scraperBase = process.env.SCRAPER_URL || "http://127.0.0.1:8000";
const urls = process.argv.slice(2);

if (urls.length === 0) {
  console.error("usage: node services/generator/scripts/live-site-probe.mjs <url> [url...]");
  process.exit(1);
}

for (const url of urls) {
  const res = await fetch(`${scraperBase}/capture`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, legalMode: "safe" }),
  });
  if (!res.ok) {
    console.log(JSON.stringify({ url, error: `scraper ${res.status}: ${await res.text()}` }, null, 2));
    continue;
  }
  const bundle = await res.json();
  const { result, droppedCount } = await inferTools(bundle, new HeuristicInferenceClient());
  console.log(
    JSON.stringify(
      {
        url,
        title: bundle.meta?.title,
        renderedWithJs: bundle.meta?.renderedWithJs,
        networkCount: bundle.network?.length ?? 0,
        selectorCount: bundle.dom?.selectorsOfInterest?.length ?? 0,
        toolNames: result.tools.map((tool) => tool.name),
        droppedCount,
      },
      null,
      2,
    ),
  );
}
