"use client";

import { useEffect, useMemo, useState } from "react";
import type { GeneratedServerArtifact } from "@mcp/types";

type JobState = {
  status: "idle" | "queued" | "running" | "done" | "failed";
  jobId?: string;
  result?: GeneratedServerArtifact;
  error?: string;
};

export function GeneratePanel() {
  const [url, setUrl] = useState("");
  const [legalMode, setLegalMode] = useState<"safe" | "full_scrape">("safe");
  const [ack, setAck] = useState(false);
  const [job, setJob] = useState<JobState>({ status: "idle" });
  const [formError, setFormError] = useState<string | undefined>();

  const canSubmit = useMemo(() => {
    if (!url.trim()) return false;
    if (legalMode === "full_scrape" && !ack) return false;
    return job.status !== "queued" && job.status !== "running";
  }, [ack, job.status, legalMode, url]);

  useEffect(() => {
    if (!job.jobId || job.status === "done" || job.status === "failed") return;
    const interval = window.setInterval(async () => {
      const res = await fetch(`/api/jobs/${job.jobId}`);
      const next = await res.json();
      setJob((current) => ({
        ...current,
        status: next.status,
        result: next.result,
        error: next.error,
      }));
    }, 1200);
    return () => window.clearInterval(interval);
  }, [job.jobId, job.status]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(undefined);
    if (legalMode === "full_scrape" && !ack) {
      setFormError("Full scrape requires acknowledgement.");
      return;
    }

    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        legalMode,
        acknowledgedFullScrape: legalMode === "full_scrape" ? ack : undefined,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      setFormError("Generation request was rejected.");
      return;
    }
    setJob({ status: "queued", jobId: body.jobId });
  }

  return (
    <section className="workspace">
      <div className="section-head">
        <div>
          <p className="eyebrow">Generate</p>
          <h2>New MCP server</h2>
        </div>
      </div>

      <form className="tool-panel" onSubmit={submit}>
        <label>
          <span>URL</span>
          <input
            className="field"
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com"
            type="url"
            value={url}
          />
        </label>
        <label>
          <span>Mode</span>
          <select className="field" onChange={(event) => setLegalMode(event.target.value as "safe" | "full_scrape")} value={legalMode}>
            <option value="safe">Safe</option>
            <option value="full_scrape">Full scrape</option>
          </select>
        </label>
        {legalMode === "full_scrape" ? (
          <label className="check-row">
            <input checked={ack} onChange={(event) => setAck(event.target.checked)} type="checkbox" />
            <span>I acknowledge the public-page scraping risk.</span>
          </label>
        ) : null}
        {formError ? <p className="error">{formError}</p> : null}
        <button className="primary-btn" disabled={!canSubmit} type="submit">Generate</button>
      </form>

      <div className="info-grid">
        <article className="info-card">
          <p className="eyebrow">Capture</p>
          <h3>Watch the real page</h3>
          <p>Forge records rendered content and the network calls a browser actually makes instead of guessing from static HTML.</p>
        </article>
        <article className="info-card">
          <p className="eyebrow">Mode</p>
          <h3>Choose the legal posture</h3>
          <p>`safe` stays conservative. `full_scrape` is there when a tougher page needs a broader pass and you accept the risk.</p>
        </article>
        <article className="info-card">
          <p className="eyebrow">Output</p>
          <h3>Get a runnable artifact</h3>
          <p>The result includes a config snippet plus the generated server package, ready to drop into your MCP client.</p>
        </article>
      </div>

      {job.status !== "idle" ? (
        <div className="result-panel">
          <div className="job-line">
            <span className={`status-dot ${job.status === "failed" ? "broken" : "active"}`} />
            <strong>{job.status}</strong>
            {job.jobId ? <code>{job.jobId}</code> : null}
          </div>
          {job.error ? <p className="error">{job.error}</p> : null}
          {job.result ? (
            <div className="snippet">
              <div className="snippet-head">
                <span>claude_code_config.json</span>
                <a className="quiet-btn" href={job.result.artifactUrl}>Artifact</a>
              </div>
              <pre>{job.result.configSnippet}</pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
