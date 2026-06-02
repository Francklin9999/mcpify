import { test } from "node:test";
import assert from "node:assert/strict";
import { stripNonRenderedMarkup, resolveBaseHref } from "../src/html-sanitize.js";

test("strips <script> contents (markup written as a JS string is not live DOM)", () => {
  const out = stripNonRenderedMarkup(`<a href="/real">x</a><script>var t='<a href="/trap">t</a>';</script>`);
  assert.ok(out.includes("/real"), "live link kept");
  assert.ok(!out.includes("/trap"), "script-string link removed");
  assert.ok(!out.includes("var t"), "script body removed");
});

test("strips <style>, <template>, <svg>, <math> contents", () => {
  const out = stripNonRenderedMarkup(
    `<style>.x::after{content:"<a href='/STYLE'>"}</style>` +
      `<template><a href="/TPL">t</a></template>` +
      `<svg><a xlink:href="/SVG">s</a></svg>` +
      `<math><a href="/MATH">m</a></math>` +
      `<a href="/REAL">r</a>`,
  );
  for (const trap of ["/STYLE", "/TPL", "/SVG", "/MATH"]) assert.ok(!out.includes(trap), `${trap} removed`);
  assert.ok(out.includes("/REAL"), "live link kept");
});

test("strips HTML comments, including a commented-out <form>", () => {
  const out = stripNonRenderedMarkup(`<!-- <form action="/trap"><input name="x"></form> --><form action="/real"></form>`);
  assert.ok(!out.includes("/trap"), "commented form removed");
  assert.ok(out.includes("/real"), "live form kept");
});

test("comments are stripped before tag blocks (commented-out <script> leaves no dangling open tag)", () => {
  // If the block pass ran first, the open <script> inside the comment could pair with the later </script>
  // and swallow the live link. Comment-first ordering prevents that.
  const out = stripNonRenderedMarkup(`<!-- <script> --><a href="/real">x</a><script>evil()</script>`);
  assert.ok(out.includes("/real"), "live link survives a commented-out <script> open tag");
  assert.ok(!out.includes("evil()"), "real script body still removed");
});

test("KEEPS <noscript> (its fallback links/forms are legitimate server-side markup)", () => {
  const out = stripNonRenderedMarkup(`<noscript><a href="/fallback">f</a></noscript>`);
  assert.ok(out.includes("/fallback"), "noscript fallback link kept");
});

test("close tag match is case-insensitive (<SCRIPT>…</SCRIPT>)", () => {
  const out = stripNonRenderedMarkup(`<SCRIPT>var t='<a href="/trap">';</SCRIPT><a href="/real">r</a>`);
  assert.ok(!out.includes("/trap"), "uppercase script stripped");
  assert.ok(out.includes("/real"));
});

test("an UNTERMINATED block is left intact rather than swallowing the rest of the page", () => {
  const out = stripNonRenderedMarkup(`<script>oops no close<a href="/after">a</a>`);
  // No closing </script>: we keep the text rather than dropping everything after the open tag.
  assert.ok(out.includes("/after"), "content after an unterminated <script> is preserved");
});

test("never throws on empty / non-string-ish / huge input", () => {
  assert.equal(stripNonRenderedMarkup(""), "");
  assert.doesNotThrow(() => stripNonRenderedMarkup("<a href=".repeat(100000)));
  assert.doesNotThrow(() => stripNonRenderedMarkup("<<<>>><script><<<"));
});

test("resolveBaseHref: relative <base href> resolves against the page URL", () => {
  const base = resolveBaseHref(`<base href="/shop/">`, "https://site.example/listing/page-2");
  assert.equal(base, "https://site.example/shop/");
});

test("resolveBaseHref: absolute cross-origin <base href> is honored", () => {
  const base = resolveBaseHref(`<base href="https://cdn.example.net/app/">`, "https://site.example/x");
  assert.equal(base, "https://cdn.example.net/app/");
});

test("resolveBaseHref: missing/empty/non-http base falls back to the page URL", () => {
  const page = "https://site.example/x";
  assert.equal(resolveBaseHref(`<html></html>`, page), page, "no <base>");
  assert.equal(resolveBaseHref(`<base target="_blank">`, page), page, "<base> without href");
  assert.equal(resolveBaseHref(`<base href="javascript:void(0)">`, page), page, "non-http base");
  assert.equal(resolveBaseHref(``, page), page, "empty html");
});

test("resolveBaseHref: a <base> mentioned inside a comment does NOT shadow the real one", () => {
  const html = `<!-- the <base> tag below points at the CDN -->\n<base href="https://cdn.example.net/app/">`;
  assert.equal(resolveBaseHref(html, "https://site.example/x"), "https://cdn.example.net/app/");
});

test("resolveBaseHref: first <base href> wins (browsers honor only the first)", () => {
  const base = resolveBaseHref(`<base href="https://a.example/"><base href="https://b.example/">`, "https://p.example/");
  assert.equal(base, "https://a.example/");
});
