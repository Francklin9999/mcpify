export const metadata = {
  title: "MCP Forge — turn any website into an MCP server",
  description: "Paste a URL. Get a runnable MCP server an LLM can act with. Generated locally, kept alive automatically.",
};

export default function Landing() {
  return (
    <main className="mk-main">
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <span className="hero-badge">◆ Website in, living toolset out</span>
            <h1>
              Turn any website into an <span className="hl">MCP server</span>.
            </h1>
            <p className="lead">
              MCP Forge watches real traffic, rendered content, and live page structure, then condenses
              it into a runnable server an LLM can use immediately. No SDK, no glue code, no fake demo path.
            </p>
            <div className="hero-cta">
              <a className="primary-btn" href="/generate">Generate a server</a>
              <a className="quiet-btn" href="/library">Browse the library</a>
            </div>
            <p className="hero-note">Local-first runtime · confidence-scored servers · self-healing when sites drift</p>
            <div className="hero-trust" aria-label="Key product traits">
              <span>Skyline-grade glass UI</span>
              <span>Traffic-to-tool inference</span>
              <span>Bright health monitoring</span>
            </div>
          </div>

          <div className="hero-scene" aria-hidden="true">
            <div className="scene-cloud scene-cloud-a" />
            <div className="scene-cloud scene-cloud-b" />
            <div className="scene-cloud scene-cloud-c" />
            <div className="scene-sun" />
            <div className="scene-orbit orbit-a" />
            <div className="scene-orbit orbit-b" />
            <div className="scene-wave" />
            <div className="scene-hill" />
            <div className="scene-bubble bubble-a" />
            <div className="scene-bubble bubble-b" />
            <div className="scene-bubble bubble-c" />
            <div className="aero-orb aero-orb-main">
              <div className="orb-shine" />
              <div className="orb-city">
                <span />
                <span />
                <span />
              </div>
              <div className="orb-core">
                <span className="orb-kicker">Live traffic</span>
                <strong>GET /search</strong>
                <p>Request signatures become typed tools.</p>
              </div>
            </div>
            <div className="aero-orb aero-orb-mini">
              <div className="orb-shine" />
              <div className="orb-core">
                <span className="orb-kicker">Health</span>
                <strong>86%</strong>
                <p>strong</p>
              </div>
            </div>
          </div>
        </div>

        <div className="hero-preview" aria-hidden="true">
          <div className="preview-bar">
            <span className="pdot" /><span className="pdot" /><span className="pdot" />
            <span className="purl">fr.wikipedia.org/wiki/Cristiano_Ronaldo</span>
          </div>
          <div className="preview-body">
            <div className="preview-tools">
              <div className="ptool">
                <span className="pk">GET</span>
                <span className="pn">fetch_page_content</span>
                <span className="pd">read the article</span>
              </div>
              <div className="ptool">
                <span className="pk">GET</span>
                <span className="pn">search_articles</span>
                <span className="pd">query the wiki</span>
              </div>
              <div className="ptool">
                <span className="pk">GET</span>
                <span className="pn">get_revisions</span>
                <span className="pd">history by title</span>
              </div>
            </div>
            <div className="preview-side">
              <div className="band" style={{ background: "var(--c-strong)" }}>
                <span className="pct">86%</span>
                <span className="label">STRONG</span>
              </div>
              <div className="preview-metric">
                <span>3 tools inferred</span>
                <strong>12s</strong>
                <p>from paste to artifact</p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="how">
        <p className="eyebrow">How it works</p>
        <h2>From a link to a working server in one step.</h2>
        <p className="sub">
          A three-tier scraper handles static pages, JavaScript apps, and bot walls. Inference turns the
          captured traffic into typed tools. Codegen emits a server you can run immediately.
        </p>
        <div className="steps">
          <div className="step">
            <span className="num">01</span>
            <h3>Capture</h3>
            <p>We fetch the page the way a browser does, recording the API calls it makes and the content it renders.</p>
          </div>
          <div className="step lined">
            <span className="num">02</span>
            <h3>Infer</h3>
            <p>Each real request becomes a typed, action-capable tool. Even a plain content page gets a useful one.</p>
          </div>
          <div className="step lined">
            <span className="num">03</span>
            <h3>Run</h3>
            <p>Download a server plus a config snippet, drop it into your MCP client, and the LLM can act on the site.</p>
          </div>
        </div>
      </section>

      <section className="section" id="confidence">
        <p className="eyebrow">Confidence, not guesswork</p>
        <h2>Every server wears its health on its sleeve.</h2>
        <p className="sub">
          A monitor re-checks each server against its source and scores it. Color is health: a high score
          means the tools still work. When a site changes, self-healing rewrites just the broken tool.
        </p>
        <div className="bands">
          <div className="bandcard" style={{ background: "var(--c-verified)" }}>
            <span className="bp">97%</span><span className="bl">VERIFIED</span>
            <span className="bx">Hand-checked, curated</span>
          </div>
          <div className="bandcard" style={{ background: "var(--c-strong)" }}>
            <span className="bp">86%</span><span className="bl">STRONG</span>
            <span className="bx">Healthy, auto-generated</span>
          </div>
          <div className="bandcard" style={{ background: "var(--c-fair)" }}>
            <span className="bp">68%</span><span className="bl">FAIR</span>
            <span className="bx">Usable, watch it</span>
          </div>
          <div className="bandcard" style={{ background: "var(--c-low)" }}>
            <span className="bp">41%</span><span className="bl">NEEDS HEALING</span>
            <span className="bx">Queued to self-heal</span>
          </div>
        </div>
      </section>

      <section className="section" style={{ borderTop: "none", paddingTop: "20px" }}>
        <div className="cta-band">
          <h2>Give your LLM a new website to work with.</h2>
          <p>Paste a URL and watch it become a server. It takes seconds, and it runs entirely on your machine.</p>
          <a className="btn-light" href="/generate">Generate your first server</a>
        </div>
      </section>
    </main>
  );
}
