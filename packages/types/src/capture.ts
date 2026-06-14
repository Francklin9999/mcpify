import { z } from "zod";
import { JsonSchema, IsoDateTime, LIMITS } from "./common.js";
import { LegalMode, isSecretHeader, isSecretField } from "./legal.js";

/** Scrapling adaptive-tracking handle: an element addressed by role with selector fallbacks (`01 S1`). */
export const ElementRef = z.object({
  role: z.string().max(128),
  selector: z.string().max(2_000),
  fallbackSelectors: z.array(z.string().max(2_000)).max(10).optional(),
});
export type ElementRef = z.infer<typeof ElementRef>;

export const PageField = z.object({
  name: z.string().max(256),
  type: z.string().max(64),
  label: z.string().max(512).optional(),
  placeholder: z.string().max(512).optional(),
  required: z.boolean(),
  selector: z.string().max(2_000).optional(),
});
export type PageField = z.infer<typeof PageField>;

export const PageForm = z.object({
  selector: z.string().max(2_000),
  method: z.enum(["GET", "POST"]),
  action: z.string().url().optional(),
  purpose: z.enum(["search", "auth", "form", "filter"]),
  submitLabel: z.string().max(512).optional(),
  submitSelector: z.string().max(2_000).optional(),
  fields: z.array(PageField).max(100),
});
export type PageForm = z.infer<typeof PageForm>;

export const PageAction = z.object({
  kind: z.enum(["link", "button", "input", "select", "menuitem"]),
  label: z.string().max(512),
  selector: z.string().max(2_000),
  href: z.string().url().optional(),
});
export type PageAction = z.infer<typeof PageAction>;

export const AppStateSummary = z.object({
  source: z.string().max(512),
  keys: z.array(z.string().max(256)).max(200).optional(),
  schema: JsonSchema.optional(),
  types: z.array(z.string().max(256)).max(100).optional(),
});
export type AppStateSummary = z.infer<typeof AppStateSummary>;

export const PageSnapshot = z.object({
  visibleText: z.string().max(12_000).optional(),
  headings: z.array(z.string().max(512)).max(100).optional(),
  actions: z.array(PageAction).max(300).optional(),
  forms: z.array(PageForm).max(50).optional(),
  appState: z.array(AppStateSummary).max(50).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;

/** One observed XHR/fetch call - the highest-signal generation input. requestHeaders must already be scrubbed. */
export const NetworkCapture = z
  .object({
    method: z.string().max(16),
    urlPattern: z.string().max(4_000),
    rawUrl: z.string().url().max(4_000),
    requestHeaders: z.record(z.string().max(256), z.string().max(LIMITS.maxHeaderValue)),
    requestBodySchema: JsonSchema.optional(),
    // The raw request body (JSON), gunzipped + secret-scrubbed + bounded, so a POST/PUT API can be REPLAYED with
    // its fixed boilerplate (e.g. an InnerTube/GraphQL `context`) intact while only the variable fields are
    // substituted from tool params. Optional + backward-compatible: absent for GETs and pre-existing bundles.
    requestBody: z.string().max(LIMITS.maxRequestBody).optional(),
    responseSchema: JsonSchema.optional(),
    statusCode: z.number().int(),
    contentType: z.string(),
  })
  // Fail-closed: the contract rejects any un-scrubbed secret-list header (producers must scrubHeaders first).
  .superRefine((cap, ctx) => {
    if (Object.keys(cap.requestHeaders).length > LIMITS.maxHeaders) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requestHeaders"],
        message: `too many request headers; max ${LIMITS.maxHeaders}`,
      });
    }
    for (const key of Object.keys(cap.requestHeaders)) {
      if (isSecretHeader(key) || isSecretField(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requestHeaders", key],
          message: `secret-list header must be scrubbed before persistence/transmission (04): ${key}`,
        });
      }
    }
  });
export type NetworkCapture = z.infer<typeof NetworkCapture>;

/** CaptureBundle - the keystone shape, produced by both the scraper and the extension net-intercept. */
export const CaptureBundle = z.object({
  bundleId: z.string().uuid(),
  source: z.enum(["scraper", "extension"]),
  url: z.string().url(),
  capturedAt: IsoDateTime,
  legalMode: LegalMode,
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  dom: z.object({
    html: z.string().max(LIMITS.maxHtml),
    domHash: z.string().max(128),
    selectorsOfInterest: z.array(ElementRef).max(200).optional(),
  }),
  network: z.array(NetworkCapture).max(LIMITS.maxNetworkCalls),
  page: PageSnapshot.optional(),
  meta: z.object({
    title: z.string().optional(),
    robotsAllowed: z.boolean().optional(),
    renderedWithJs: z.boolean(),
  }),
});
export type CaptureBundle = z.infer<typeof CaptureBundle>;
