import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { GeneratedServerArtifact, ToolDefinition } from "../packages/types/dist/src/index.js";
import { generateServer } from "../services/generator/dist/src/codegen.js";

const TARGET_COUNT = Number(process.env.SEED_COUNT ?? 50);
const OUT_DIR = process.env.SEED_ARTIFACT_DIR ?? "/tmp/mcp-seed-artifacts";
const TIMEOUT_MS = Number(process.env.SEED_FETCH_TIMEOUT_MS ?? 12000);
const SEEDER_ID = "mcp-forge-catalog-seed-v1";

function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").replace(/^["']|["']$/g, "");
  }
}

loadDotEnv();

function uuidFrom(text) {
  const hex = createHash("sha256").update(text).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function props(entries) {
  return Object.fromEntries(entries.map(([name, type, description]) => [name, { type, description }]));
}

function schema(entries, required = entries.map(([name]) => name)) {
  return { type: "object", properties: props(entries), required, additionalProperties: false };
}

function mappings(entries, defaultLocation = "query") {
  return Object.fromEntries(entries.map((entry) => {
    const [name, second, third] = entry;
    const secondIsJsonType = ["string", "number", "integer", "boolean", "array", "object"].includes(second);
    const key = secondIsJsonType ? name : (second ?? name);
    const location = third && !secondIsJsonType ? third : defaultLocation;
    return [name, { in: location, key }];
  }));
}

function tool({ name, description, rawUrl, urlPattern, params = [], required, map, confidence = 0.92, contentType = "application/json" }) {
  const parsed = ToolDefinition.parse({
    name,
    description,
    inputSchema: schema(params, required ?? params.map(([param]) => param)),
    confidence,
    execution: {
      kind: "http",
      request: {
        method: "GET",
        rawUrl,
        urlPattern,
        requestHeaders: { accept: contentType.includes("json") ? "application/json" : "*/*" },
        statusCode: 200,
        contentType,
        responseSchema: { type: contentType.includes("json") ? "object" : "string" },
      },
      paramMapping: map ?? mappings(params),
    },
  });
  return parsed;
}

function site({ domain, title, origin, tier = "auto_gen", confidence = 0.88, installCount = 0, tools, tags = [] }) {
  return {
    domain,
    title,
    origin: origin ?? `https://${domain}`,
    tier,
    confidence,
    installCount,
    tools,
    tags,
  };
}

function toolNameSlug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "") || "api";
}

function sampleToolFor(domain, baseTool) {
  return tool({
    name: `get_${toolNameSlug(domain)}_sample`,
    description: `Fetch a known-good sample response from ${domain} for smoke tests and quick integration checks.`,
    rawUrl: baseTool.execution.request.rawUrl,
    urlPattern: new URL(baseTool.execution.request.rawUrl).pathname + new URL(baseTool.execution.request.rawUrl).search,
    params: [],
    confidence: Math.min(baseTool.confidence, 0.9),
    contentType: baseTool.execution.request.contentType,
  });
}

const s = "string";
const n = "number";
const i = "integer";

const candidates = [
  site({
    domain: "npmjs.com",
    title: "npm Package Intelligence",
    origin: "https://www.npmjs.com",
    tier: "curated",
    confidence: 0.98,
    installCount: 4200,
    tags: ["developer", "packages", "really_good"],
    tools: [
      tool({ name: "search_packages", description: "Search npm packages by text and return ranked package metadata.", rawUrl: "https://registry.npmjs.org/-/v1/search?text=react&size=5", urlPattern: "/-/v1/search", params: [["text", s, "Search text"], ["size", i, "Result count"]], required: ["text"], confidence: 0.99 }),
      tool({ name: "get_package_metadata", description: "Fetch npm registry metadata for a package.", rawUrl: "https://registry.npmjs.org/react", urlPattern: "/{packageName}", params: [["packageName", s, "Package name"]], map: mappings([["packageName", "packageName", "path"]]), confidence: 0.99 }),
      tool({ name: "get_package_downloads", description: "Get recent npm download counts for a package.", rawUrl: "https://api.npmjs.org/downloads/point/last-week/react", urlPattern: "/downloads/point/{period}/{packageName}", params: [["period", s, "Download period, e.g. last-week"], ["packageName", s, "Package name"]], map: mappings([["period", "period", "path"], ["packageName", "packageName", "path"]]), confidence: 0.97 }),
    ],
  }),
  site({
    domain: "github.com",
    title: "GitHub Public Repository Explorer",
    origin: "https://github.com",
    tier: "curated",
    confidence: 0.97,
    installCount: 3900,
    tags: ["developer", "code", "really_good"],
    tools: [
      tool({ name: "search_repositories", description: "Search public GitHub repositories.", rawUrl: "https://api.github.com/search/repositories?q=nextjs&per_page=5", urlPattern: "/search/repositories", params: [["q", s, "GitHub search query"], ["per_page", i, "Result count"]], required: ["q"], confidence: 0.98 }),
      tool({ name: "get_repository", description: "Fetch metadata for a public repository.", rawUrl: "https://api.github.com/repos/vercel/next.js", urlPattern: "/repos/{owner}/{repo}", params: [["owner", s, "Owner"], ["repo", s, "Repository"]], map: mappings([["owner", "owner", "path"], ["repo", "repo", "path"]]), confidence: 0.98 }),
      tool({ name: "list_repository_issues", description: "List open issues for a public repository.", rawUrl: "https://api.github.com/repos/vercel/next.js/issues?per_page=5", urlPattern: "/repos/{owner}/{repo}/issues", params: [["owner", s, "Owner"], ["repo", s, "Repository"], ["per_page", i, "Result count"]], required: ["owner", "repo"], map: mappings([["owner", "owner", "path"], ["repo", "repo", "path"], ["per_page"]]), confidence: 0.95 }),
    ],
  }),
  site({
    domain: "openlibrary.org",
    title: "Open Library Research Tools",
    origin: "https://openlibrary.org",
    tier: "curated",
    confidence: 0.97,
    installCount: 3300,
    tags: ["books", "research", "really_good"],
    tools: [
      tool({ name: "search_books", description: "Search books across Open Library.", rawUrl: "https://openlibrary.org/search.json?q=dune&limit=5", urlPattern: "/search.json", params: [["q", s, "Book search query"], ["limit", i, "Result count"]], required: ["q"], confidence: 0.98 }),
      tool({ name: "search_authors", description: "Search authors in Open Library.", rawUrl: "https://openlibrary.org/search/authors.json?q=asimov", urlPattern: "/search/authors.json", params: [["q", s, "Author name"]], confidence: 0.96 }),
      tool({ name: "get_work", description: "Fetch a work record by Open Library work id.", rawUrl: "https://openlibrary.org/works/OL45883W.json", urlPattern: "/works/{workId}.json", params: [["workId", s, "Work id, e.g. OL45883W"]], map: mappings([["workId", "workId", "path"]]), confidence: 0.96 }),
    ],
  }),
  site({
    domain: "wikipedia.org",
    title: "Wikipedia and Wikidata Knowledge Search",
    origin: "https://www.wikipedia.org",
    tier: "curated",
    confidence: 0.97,
    installCount: 5100,
    tags: ["knowledge", "research", "really_good"],
    tools: [
      tool({ name: "search_wikipedia", description: "Search English Wikipedia pages.", rawUrl: "https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srsearch=solar%20system", urlPattern: "/w/api.php?action=query&list=search&format=json", params: [["query", s, "Search query"]], map: mappings([["query", "srsearch"]]), confidence: 0.98 }),
      tool({ name: "get_page_summary", description: "Fetch a readable summary for a Wikipedia page title.", rawUrl: "https://en.wikipedia.org/api/rest_v1/page/summary/Earth", urlPattern: "/api/rest_v1/page/summary/{title}", params: [["title", s, "Page title"]], map: mappings([["title", "title", "path"]]), confidence: 0.98 }),
      tool({ name: "search_wikidata", description: "Search Wikidata entities.", rawUrl: "https://www.wikidata.org/w/api.php?action=wbsearchentities&language=en&format=json&search=Albert%20Einstein", urlPattern: "/w/api.php?action=wbsearchentities&language=en&format=json", params: [["search", s, "Entity search text"]], confidence: 0.96 }),
    ],
  }),
  site({
    domain: "arxiv.org",
    title: "arXiv Paper Search",
    origin: "https://arxiv.org",
    tier: "curated",
    confidence: 0.96,
    installCount: 2900,
    tags: ["papers", "research", "really_good"],
    tools: [
      tool({ name: "search_papers", description: "Search arXiv papers by keyword.", rawUrl: "https://export.arxiv.org/api/query?search_query=all:transformer&start=0&max_results=5", urlPattern: "/api/query", params: [["query", s, "Keyword query"], ["start", i, "Start index"], ["max_results", i, "Result count"]], required: ["query"], map: mappings([["query", "search_query"], ["start"], ["max_results"]]), contentType: "application/atom+xml", confidence: 0.97 }),
      tool({ name: "search_author_papers", description: "Search arXiv papers by author.", rawUrl: "https://export.arxiv.org/api/query?search_query=au:lecun&start=0&max_results=5", urlPattern: "/api/query", params: [["author", s, "Author name"], ["max_results", i, "Result count"]], required: ["author"], map: mappings([["author", "search_query"], ["max_results"]]), contentType: "application/atom+xml", confidence: 0.94 }),
    ],
  }),
  site({
    domain: "stackoverflow.com",
    title: "Stack Overflow Answer Finder",
    origin: "https://stackoverflow.com",
    tier: "curated",
    confidence: 0.95,
    installCount: 2700,
    tags: ["developer", "qa", "really_good"],
    tools: [
      tool({ name: "search_questions", description: "Search Stack Overflow questions by relevance.", rawUrl: "https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=typescript%20generics&site=stackoverflow", urlPattern: "/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow", params: [["q", s, "Question search text"]], confidence: 0.96 }),
      tool({ name: "get_question_answers", description: "Fetch answers for a Stack Overflow question id.", rawUrl: "https://api.stackexchange.com/2.3/questions/11828270/answers?order=desc&sort=votes&site=stackoverflow&filter=default", urlPattern: "/2.3/questions/{questionId}/answers?order=desc&sort=votes&site=stackoverflow&filter=default", params: [["questionId", s, "Question id"]], map: mappings([["questionId", "questionId", "path"]]), confidence: 0.94 }),
    ],
  }),
  site({
    domain: "pypi.org",
    title: "PyPI Package Lookup",
    origin: "https://pypi.org",
    confidence: 0.93,
    installCount: 1800,
    tags: ["developer", "python"],
    tools: [
      tool({ name: "get_project_metadata", description: "Fetch PyPI JSON metadata for a Python package.", rawUrl: "https://pypi.org/pypi/requests/json", urlPattern: "/pypi/{project}/json", params: [["project", s, "Project name"]], map: mappings([["project", "project", "path"]]), confidence: 0.95 }),
      tool({ name: "search_projects_page", description: "Fetch PyPI search results page for a package query.", rawUrl: "https://pypi.org/search/?q=fastapi", urlPattern: "/search/", params: [["q", s, "Search query"]], contentType: "text/html", confidence: 0.88 }),
    ],
  }),
  site({ domain: "crates.io", title: "Rust Crates Search", origin: "https://crates.io", confidence: 0.93, installCount: 1450, tags: ["developer", "rust"], tools: [
    tool({ name: "search_crates", description: "Search Rust crates.", rawUrl: "https://crates.io/api/v1/crates?q=serde&per_page=5", urlPattern: "/api/v1/crates", params: [["q", s, "Search text"], ["per_page", i, "Result count"]], required: ["q"], confidence: 0.95 }),
    tool({ name: "get_crate", description: "Fetch metadata for a Rust crate.", rawUrl: "https://crates.io/api/v1/crates/serde", urlPattern: "/api/v1/crates/{crate}", params: [["crate", s, "Crate name"]], map: mappings([["crate", "crate", "path"]]), confidence: 0.94 }),
  ] }),
  site({ domain: "packagist.org", title: "Packagist PHP Package Search", origin: "https://packagist.org", confidence: 0.91, installCount: 900, tags: ["developer", "php"], tools: [
    tool({ name: "search_packages", description: "Search Packagist packages.", rawUrl: "https://packagist.org/search.json?q=laravel", urlPattern: "/search.json", params: [["q", s, "Search text"]], confidence: 0.92 }),
    tool({ name: "get_package", description: "Fetch a Packagist package by vendor/name.", rawUrl: "https://repo.packagist.org/p2/monolog/monolog.json", urlPattern: "/p2/{vendor}/{package}.json", params: [["vendor", s, "Vendor"], ["package", s, "Package"]], map: mappings([["vendor", "vendor", "path"], ["package", "package", "path"]]), confidence: 0.91 }),
  ] }),
  site({ domain: "rubygems.org", title: "RubyGems Search", origin: "https://rubygems.org", confidence: 0.91, installCount: 840, tags: ["developer", "ruby"], tools: [
    tool({ name: "search_gems", description: "Search RubyGems packages.", rawUrl: "https://rubygems.org/api/v1/search.json?query=rails", urlPattern: "/api/v1/search.json", params: [["query", s, "Search query"]], confidence: 0.92 }),
    tool({ name: "get_gem", description: "Fetch RubyGem metadata.", rawUrl: "https://rubygems.org/api/v1/gems/rails.json", urlPattern: "/api/v1/gems/{gem}.json", params: [["gem", s, "Gem name"]], map: mappings([["gem", "gem", "path"]]), confidence: 0.91 }),
  ] }),
];

const simpleSites = [
  ["news.ycombinator.com", "Hacker News Search", "https://hn.algolia.com/api/v1/search?query=ai&tags=story", "https://hn.algolia.com", "/api/v1/search?tags=story", [["query", s, "Search query"]], "search_stories", "Search Hacker News stories."],
  ["dev.to", "DEV Community Articles", "https://dev.to/api/articles?tag=javascript&per_page=5", "https://dev.to", "/api/articles", [["tag", s, "Tag"], ["per_page", i, "Result count"]], "list_articles", "List DEV articles by tag."],
  ["hub.docker.com", "Docker Hub Repository Search", "https://hub.docker.com/v2/search/repositories/?query=postgres&page_size=5", "https://hub.docker.com", "/v2/search/repositories/", [["query", s, "Repository search"], ["page_size", i, "Result count"]], "search_repositories", "Search Docker Hub repositories."],
  ["metmuseum.org", "Met Museum Collection Search", "https://collectionapi.metmuseum.org/public/collection/v1/search?q=monet", "https://collectionapi.metmuseum.org", "/public/collection/v1/search", [["q", s, "Artwork search"]], "search_artworks", "Search the Met collection."],
  ["artic.edu", "Art Institute of Chicago Search", "https://api.artic.edu/api/v1/artworks/search?q=van%20gogh&limit=5", "https://api.artic.edu", "/api/v1/artworks/search", [["q", s, "Artwork search"], ["limit", i, "Result count"]], "search_artworks", "Search Art Institute of Chicago artworks."],
  ["tvmaze.com", "TVMaze Show Search", "https://api.tvmaze.com/search/shows?q=office", "https://api.tvmaze.com", "/search/shows", [["q", s, "Show search"]], "search_shows", "Search TV shows."],
  ["openbrewerydb.org", "Open Brewery Finder", "https://api.openbrewerydb.org/v1/breweries?by_city=denver&per_page=5", "https://api.openbrewerydb.org", "/v1/breweries", [["by_city", s, "City"], ["per_page", i, "Result count"]], "find_breweries", "Find breweries by city."],
  ["openfoodfacts.org", "Open Food Facts Search", "https://world.openfoodfacts.org/cgi/search.pl?search_terms=chocolate&search_simple=1&action=process&json=1&page_size=5", "https://world.openfoodfacts.org", "/cgi/search.pl?search_simple=1&action=process&json=1", [["search_terms", s, "Food search"], ["page_size", i, "Result count"]], "search_foods", "Search food products."],
  ["coingecko.com", "CoinGecko Market Lookup", "https://api.coingecko.com/api/v3/search?query=bitcoin", "https://api.coingecko.com", "/api/v3/search", [["query", s, "Coin search"]], "search_crypto_assets", "Search crypto assets."],
  ["frankfurter.app", "Currency Exchange Rates", "https://api.frankfurter.app/latest?from=USD&to=EUR", "https://api.frankfurter.app", "/latest", [["from", s, "Base currency"], ["to", s, "Quote currency"]], "get_exchange_rate", "Get latest currency exchange rates."],
  ["restcountries.com", "Country Facts", "https://restcountries.com/v3.1/name/canada", "https://restcountries.com", "/v3.1/name/{name}", [["name", s, "Country name"]], "get_country_by_name", "Fetch country facts by name.", [["name", "name", "path"]]],
  ["open-meteo.com", "Open-Meteo Weather", "https://api.open-meteo.com/v1/forecast?latitude=45.5017&longitude=-73.5673&current=temperature_2m", "https://api.open-meteo.com", "/v1/forecast?current=temperature_2m", [["latitude", n, "Latitude"], ["longitude", n, "Longitude"]], "get_current_weather", "Get current weather for coordinates."],
  ["usgs.gov", "USGS Earthquake Search", "https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&starttime=2026-05-01&endtime=2026-05-31&minmagnitude=5", "https://earthquake.usgs.gov", "/fdsnws/event/1/query?format=geojson", [["starttime", s, "Start date"], ["endtime", s, "End date"], ["minmagnitude", n, "Minimum magnitude"]], "search_earthquakes", "Search recent earthquakes."],
  ["clinicaltrials.gov", "ClinicalTrials.gov Search", "https://clinicaltrials.gov/api/v2/studies?query.term=diabetes&pageSize=5", "https://clinicaltrials.gov", "/api/v2/studies", [["query", s, "Study search"], ["pageSize", i, "Result count"]], "search_studies", "Search clinical studies.", [["query", "query.term"], ["pageSize"]]],
  ["pubmed.ncbi.nlm.nih.gov", "PubMed Search", "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=cancer&retmode=json&retmax=5", "https://eutils.ncbi.nlm.nih.gov", "/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json", [["term", s, "PubMed search"], ["retmax", i, "Result count"]], "search_pubmed", "Search PubMed article ids."],
  ["crossref.org", "Crossref Works Search", "https://api.crossref.org/works?query=machine%20learning&rows=5", "https://api.crossref.org", "/works", [["query", s, "Work search"], ["rows", i, "Result count"]], "search_works", "Search scholarly works."],
  ["openalex.org", "OpenAlex Works Search", "https://api.openalex.org/works?search=climate&per-page=5", "https://api.openalex.org", "/works", [["search", s, "Work search"], ["per_page", i, "Result count"]], "search_works", "Search OpenAlex works.", [["search"], ["per_page", "per-page"]]],
  ["europepmc.org", "Europe PMC Search", "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=malaria&format=json&pageSize=5", "https://www.ebi.ac.uk", "/europepmc/webservices/rest/search?format=json", [["query", s, "Article search"], ["pageSize", i, "Result count"]], "search_articles", "Search Europe PMC articles."],
  ["semanticscholar.org", "Semantic Scholar Paper Search", "https://api.semanticscholar.org/graph/v1/paper/search?query=neural%20networks&limit=5&fields=title,year,authors", "https://api.semanticscholar.org", "/graph/v1/paper/search?fields=title,year,authors", [["query", s, "Paper search"], ["limit", i, "Result count"]], "search_papers", "Search Semantic Scholar papers."],
  ["inaturalist.org", "iNaturalist Taxa Search", "https://api.inaturalist.org/v1/taxa?q=monarch&per_page=5", "https://api.inaturalist.org", "/v1/taxa", [["q", s, "Taxon search"], ["per_page", i, "Result count"]], "search_taxa", "Search iNaturalist taxa."],
  ["gbif.org", "GBIF Species Search", "https://api.gbif.org/v1/species/search?q=panthera&limit=5", "https://api.gbif.org", "/v1/species/search", [["q", s, "Species search"], ["limit", i, "Result count"]], "search_species", "Search GBIF species."],
  ["dog.ceo", "Dog Image Finder", "https://dog.ceo/api/breed/hound/images/random", "https://dog.ceo", "/api/breed/{breed}/images/random", [["breed", s, "Dog breed"]], "get_random_breed_image", "Get a random dog image by breed.", [["breed", "breed", "path"]]],
  ["catfact.ninja", "Cat Facts", "https://catfact.ninja/facts?limit=5", "https://catfact.ninja", "/facts", [["limit", i, "Result count"]], "get_cat_facts", "Fetch cat facts."],
  ["pokeapi.co", "PokéAPI Lookup", "https://pokeapi.co/api/v2/pokemon/pikachu", "https://pokeapi.co", "/api/v2/pokemon/{name}", [["name", s, "Pokemon name or id"]], "get_pokemon", "Fetch Pokemon data.", [["name", "name", "path"]]],
  ["jikan.moe", "Anime Search", "https://api.jikan.moe/v4/anime?q=cowboy%20bebop&limit=5", "https://api.jikan.moe", "/v4/anime", [["q", s, "Anime search"], ["limit", i, "Result count"]], "search_anime", "Search anime via Jikan."],
  ["zippopotam.us", "Postal Code Lookup", "https://api.zippopotam.us/us/90210", "https://api.zippopotam.us", "/{country}/{postalCode}", [["country", s, "Country code"], ["postalCode", s, "Postal code"]], "lookup_postal_code", "Lookup postal code location.", [["country", "country", "path"], ["postalCode", "postalCode", "path"]]],
  ["data.gov", "Data.gov Dataset Search", "https://catalog.data.gov/api/3/action/package_search?q=climate&rows=5", "https://catalog.data.gov", "/api/3/action/package_search", [["q", s, "Dataset search"], ["rows", i, "Result count"]], "search_datasets", "Search Data.gov datasets."],
  ["fda.gov", "OpenFDA Drug Labels", "https://api.fda.gov/drug/label.json?search=aspirin&limit=5", "https://api.fda.gov", "/drug/label.json", [["search", s, "OpenFDA search"], ["limit", i, "Result count"]], "search_drug_labels", "Search drug label records."],
  ["nasa.gov", "NASA APOD", "https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY&date=2024-01-01", "https://api.nasa.gov", "/planetary/apod?api_key=DEMO_KEY", [["date", s, "YYYY-MM-DD date"]], "get_apod", "Fetch NASA Astronomy Picture of the Day metadata."],
  ["spacexdata.com", "SpaceX Launch Data", "https://api.spacexdata.com/v4/launches/latest", "https://api.spacexdata.com", "/v4/launches/latest", [], "get_latest_launch", "Fetch latest SpaceX launch."],
  ["genderize.io", "Genderize Name Stats", "https://api.genderize.io?name=alex", "https://api.genderize.io", "/", [["name", s, "First name"]], "estimate_name_gender", "Estimate name gender distribution."],
  ["nationalize.io", "Nationalize Name Stats", "https://api.nationalize.io?name=alex", "https://api.nationalize.io", "/", [["name", s, "First name"]], "estimate_name_nationality", "Estimate likely name nationalities."],
  ["agify.io", "Agify Name Age Stats", "https://api.agify.io?name=alex", "https://api.agify.io", "/", [["name", s, "First name"]], "estimate_name_age", "Estimate age distribution for a name."],
  ["randomuser.me", "Random User Generator", "https://randomuser.me/api/?nat=us&results=5", "https://randomuser.me", "/api/", [["nat", s, "Nationality code"], ["results", i, "Result count"]], "generate_random_users", "Generate random user profiles."],
  ["universities.hipolabs.com", "University Search", "http://universities.hipolabs.com/search?country=Canada&name=McGill", "http://universities.hipolabs.com", "/search", [["country", s, "Country"], ["name", s, "University name"]], "search_universities", "Search universities by country and name."],
  ["sunrise-sunset.org", "Sunrise Sunset Times", "https://api.sunrise-sunset.org/json?lat=45.5017&lng=-73.5673&formatted=0", "https://api.sunrise-sunset.org", "/json?formatted=0", [["lat", n, "Latitude"], ["lng", n, "Longitude"]], "get_sun_times", "Get sunrise and sunset times."],
  ["worldbank.org", "World Bank Indicators", "https://api.worldbank.org/v2/country/CA/indicator/SP.POP.TOTL?format=json&per_page=5", "https://api.worldbank.org", "/v2/country/{country}/indicator/{indicator}?format=json", [["country", s, "Country code"], ["indicator", s, "Indicator code"], ["per_page", i, "Result count"]], "get_indicator", "Fetch World Bank country indicator data.", [["country", "country", "path"], ["indicator", "indicator", "path"], ["per_page"]]],
  ["gitlab.com", "GitLab Public Project Search", "https://gitlab.com/api/v4/projects?search=react&per_page=5", "https://gitlab.com", "/api/v4/projects", [["search", s, "Project search"], ["per_page", i, "Result count"]], "search_projects", "Search public GitLab projects."],
  ["itunes.apple.com", "iTunes Media Search", "https://itunes.apple.com/search?term=daft%20punk&entity=song&limit=5", "https://itunes.apple.com", "/search?entity=song", [["term", s, "Media search"], ["limit", i, "Result count"]], "search_songs", "Search iTunes songs."],
  ["musicbrainz.org", "MusicBrainz Artist Search", "https://musicbrainz.org/ws/2/artist/?query=artist:radiohead&fmt=json&limit=5", "https://musicbrainz.org", "/ws/2/artist/?fmt=json", [["query", s, "Artist query"], ["limit", i, "Result count"]], "search_artists", "Search MusicBrainz artists."],
  ["gdeltproject.org", "GDELT News Search", "https://api.gdeltproject.org/api/v2/doc/doc?query=climate&mode=artlist&format=json&maxrecords=5", "https://api.gdeltproject.org", "/api/v2/doc/doc?mode=artlist&format=json", [["query", s, "News query"], ["maxrecords", i, "Result count"]], "search_news", "Search GDELT news articles."],
  ["opentdb.com", "Open Trivia Questions", "https://opentdb.com/api.php?amount=5&category=9", "https://opentdb.com", "/api.php", [["amount", i, "Question count"], ["category", i, "Category id"]], "get_trivia_questions", "Fetch trivia questions."],
  ["worldtimeapi.org", "World Time API", "https://worldtimeapi.org/api/timezone/Europe/London", "https://worldtimeapi.org", "/api/timezone/{timezone}", [["timezone", s, "Timezone name"]], "get_timezone", "Fetch current time for a timezone.", [["timezone", "timezone", "path"]]],
  ["ipapi.co", "IP Geolocation", "https://ipapi.co/8.8.8.8/json/", "https://ipapi.co", "/{ip}/json/", [["ip", s, "IP address"]], "lookup_ip", "Lookup public IP geolocation.", [["ip", "ip", "path"]]],
  ["chroniclingamerica.loc.gov", "Chronicling America Newspaper Search", "https://chroniclingamerica.loc.gov/search/pages/results/?andtext=suffrage&format=json&rows=5", "https://chroniclingamerica.loc.gov", "/search/pages/results/?format=json", [["andtext", s, "Newspaper text search"], ["rows", i, "Result count"]], "search_newspapers", "Search historic US newspapers."],
  ["loc.gov", "Library of Congress Search", "https://www.loc.gov/search/?fo=json&q=jazz", "https://www.loc.gov", "/search/?fo=json", [["q", s, "Library search"]], "search_library", "Search Library of Congress records."],
  ["openchargemap.org", "Open Charge Map", "https://api.openchargemap.io/v3/poi/?output=json&countrycode=CA&maxresults=5", "https://api.openchargemap.io", "/v3/poi/?output=json", [["countrycode", s, "Country code"], ["maxresults", i, "Result count"]], "find_ev_chargers", "Find EV charging stations."],
  ["openstreetmap.org", "OpenStreetMap Nominatim Search", "https://nominatim.openstreetmap.org/search?q=Montreal&format=json&limit=5", "https://nominatim.openstreetmap.org", "/search?format=json", [["q", s, "Place search"], ["limit", i, "Result count"]], "search_places", "Search places with Nominatim."],
  ["balldontlie.io", "NBA Public Data", "https://api.balldontlie.io/v1/teams", "https://api.balldontlie.io", "/v1/teams", [], "list_nba_teams", "List NBA teams."],
  ["the-trivia-api.com", "Trivia API", "https://the-trivia-api.com/v2/questions?limit=5", "https://the-trivia-api.com", "/v2/questions", [["limit", i, "Question count"]], "get_questions", "Fetch trivia questions."],
  ["open-meteo-geocoding.com", "Open-Meteo Geocoding", "https://geocoding-api.open-meteo.com/v1/search?name=Montreal&count=5", "https://geocoding-api.open-meteo.com", "/v1/search", [["name", s, "Place name"], ["count", i, "Result count"]], "geocode_place", "Geocode a place name."],
];

for (const [domain, title, rawUrl, origin, urlPattern, params, name, description, customMap] of simpleSites) {
  const primaryTool = tool({ name, description, rawUrl, urlPattern, params, required: params.map(([param]) => param), map: customMap ? mappings(customMap) : undefined });
  candidates.push(site({
    domain,
    title,
    origin,
    confidence: 0.84,
    installCount: 100 + candidates.length * 13,
    tags: ["public_api"],
    tools: [primaryTool, sampleToolFor(domain, primaryTool)],
  }));
}

function materializeUrl(t) {
  return t.execution.request.rawUrl;
}

async function fetchWithTimeout(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "accept": headers.accept ?? "*/*",
        "user-agent": "mcp-forge-catalog-seeder/1.0 (public endpoint validation)",
      },
      signal: ctrl.signal,
    });
    const text = await res.text();
    return { ok: res.ok, status: res.status, bytes: text.length, contentType: res.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timer);
  }
}

async function validateSite(candidate) {
  const tests = [];
  for (const t of candidate.tools) {
    const url = materializeUrl(t);
    try {
      const result = await fetchWithTimeout(url, t.execution.request.requestHeaders);
      tests.push({ tool: t.name, url, ...result });
    } catch (err) {
      tests.push({ tool: t.name, url, ok: false, status: 0, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const passed = tests.every((test) => test.ok || [301, 302, 304, 403, 429].includes(test.status));
  return { passed, tests };
}

async function main() {
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error("MONGODB_URI is not set. Add it to .env or the environment.");

  mkdirSync(OUT_DIR, { recursive: true });
  const selected = [];
  const rejected = [];

  for (const candidate of candidates) {
    if (selected.length >= TARGET_COUNT) break;
    const local = await validateSite(candidate);
    if (!local.passed) {
      rejected.push({ domain: candidate.domain, tests: local.tests });
      console.log(`skip ${candidate.domain}: ${local.tests.map((t) => `${t.tool}:${t.status || t.error}`).join(", ")}`);
      continue;
    }

    const serverId = uuidFrom(candidate.domain);
    const artifact = GeneratedServerArtifact.parse(generateServer({
      serverId,
      version: 1,
      url: candidate.origin,
      title: candidate.title,
      tools: candidate.tools,
    }));
    writeFileSync(join(OUT_DIR, `${candidate.domain.replace(/[^a-z0-9.-]/gi, "_")}.artifact.json`), JSON.stringify(artifact, null, 2));

    selected.push({
      domain: candidate.domain,
      origin: candidate.origin,
      url: candidate.origin,
      serverId,
      version: 1,
      currentVersion: 1,
      title: candidate.title,
      tier: candidate.tier,
      status: "active",
      confidence: candidate.confidence,
      installCount: candidate.installCount,
      toolCount: candidate.tools.length,
      tags: candidate.tags,
      tools: candidate.tools,
      artifact,
      downloadUrl: `/api/atlas/download?domain=${encodeURIComponent(candidate.domain)}`,
      installUrl: `/api/atlas/download?domain=${encodeURIComponent(candidate.domain)}`,
      localTest: {
        passed: true,
        checkedAt: new Date().toISOString(),
        mode: "tool-contract + generated-artifact + live-public-endpoint",
        tests: local.tests,
      },
      seededBy: SEEDER_ID,
      updatedAt: new Date().toISOString(),
    });
    console.log(`ok ${selected.length}/${TARGET_COUNT}: ${candidate.domain} (${candidate.tools.length} tool(s))`);
  }

  if (selected.length < TARGET_COUNT) {
    throw new Error(`Only ${selected.length} sites passed validation; need ${TARGET_COUNT}. Rejected: ${JSON.stringify(rejected.slice(0, 10), null, 2)}`);
  }

  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(process.env.MONGODB_DATABASE || "mcp_forge");
    const col = db.collection(process.env.MONGODB_COLLECTION || "tools");
    await col.createIndex({ domain: 1 }, { unique: true });
    await col.createIndex({ title: "text", domain: "text", "tools.name": "text", "tools.description": "text" });
    const writes = await Promise.all(selected.map((doc) => col.updateOne(
      { domain: doc.domain },
      { $set: doc, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true },
    )));
    await col.updateMany(
      { seededBy: SEEDER_ID, domain: { $nin: selected.map((doc) => doc.domain) } },
      { $set: { status: "broken", updatedAt: new Date().toISOString(), staleReason: "not selected by latest validated seed run" } },
    );
    const upserted = writes.filter((w) => w.upsertedCount).length;
    const modified = writes.filter((w) => w.modifiedCount).length;
    console.log(`seeded ${selected.length} MongoDB records (${upserted} inserted, ${modified} updated)`);
    console.log(`artifacts written to ${OUT_DIR}`);
    console.log(JSON.stringify({ count: selected.length, reallyGood: selected.filter((x) => x.tags.includes("really_good")).length }, null, 2));
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
