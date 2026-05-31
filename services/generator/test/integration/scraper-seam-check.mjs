// Cross-process Node->Python seam: the real HttpScraper adapter calls the real uvicorn scraper over HTTP,
// and the response must pass Node's CaptureBundle.parse() (validation lives inside HttpScraper.capture).
import { HttpScraper } from "../../dist/src/index.js";

const scraper = new HttpScraper(process.env.SCRAPER_URL);
const bundle = await scraper.capture(process.env.PAGE_URL, "safe");

if (bundle.source !== "scraper") {
  console.error("FAIL: unexpected source", bundle.source);
  process.exit(1);
}
if (typeof bundle.dom.html !== "string" || !bundle.dom.domHash) {
  console.error("FAIL: bundle missing dom");
  process.exit(1);
}
console.log(`SEAM OK: Node parsed a real Python CaptureBundle (tier=${bundle.tier}, htmlLen=${bundle.dom.html.length})`);
