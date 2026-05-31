import { z } from "zod";
import { JsonSchema, IsoDateTime } from "./common.js";
import { LegalMode, isSecretHeader, isSecretField } from "./legal.js";

/** Scrapling adaptive-tracking handle: an element addressed by role with selector fallbacks (`01 S1`). */
export const ElementRef = z.object({
  role: z.string(),
  selector: z.string(),
  fallbackSelectors: z.array(z.string()).optional(),
});
export type ElementRef = z.infer<typeof ElementRef>;

export const PageField = z.object({
  name: z.string(),
  type: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  required: z.boolean(),
  selector: z.string().optional(),
});
export type PageField = z.infer<typeof PageField>;

export const PageForm = z.object({
  selector: z.string(),
  method: z.enum(["GET", "POST"]),
  action: z.string().url().optional(),
  purpose: z.enum(["search", "auth", "form", "filter"]),
  submitLabel: z.string().optional(),
  submitSelector: z.string().optional(),
  fields: z.array(PageField),
});
export type PageForm = z.infer<typeof PageForm>;

export const PageAction = z.object({
  kind: z.enum(["link", "button", "input", "select", "menuitem"]),
  label: z.string(),
  selector: z.string(),
  href: z.string().url().optional(),
});
export type PageAction = z.infer<typeof PageAction>;

export const AppStateSummary = z.object({
  source: z.string(),
  keys: z.array(z.string()).optional(),
  schema: JsonSchema.optional(),
  types: z.array(z.string()).optional(),
});
export type AppStateSummary = z.infer<typeof AppStateSummary>;

export const PageSnapshot = z.object({
  visibleText: z.string().optional(),
  headings: z.array(z.string()).optional(),
  actions: z.array(PageAction).optional(),
  forms: z.array(PageForm).optional(),
  appState: z.array(AppStateSummary).optional(),
});
export type PageSnapshot = z.infer<typeof PageSnapshot>;

/**
 * One observed XHR/fetch call. The highest-signal generation input. `requestHeaders` MUST already be
 * scrubbed (`04`); body/response are inferred SCHEMAS, never raw values.
 */
export const NetworkCapture = z
  .object({
    method: z.string(),
    urlPattern: z.string(),
    rawUrl: z.string().url(),
    requestHeaders: z.record(z.string(), z.string()),
    requestBodySchema: JsonSchema.optional(),
    responseSchema: JsonSchema.optional(),
    statusCode: z.number().int(),
    contentType: z.string(),
  })
  // FAIL-CLOSED legal backstop (`04`): the contract REJECTS any un-scrubbed secret-list header. Producers
  // must call `scrubHeaders` before constructing this - if they forget, parse() throws instead of leaking.
  .superRefine((cap, ctx) => {
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

/**
 * CaptureBundle - THE keystone shape (`01 S1`). Produced by BOTH the scraper (`source:'scraper'`) and the
 * extension net-intercept (`source:'extension'`); the generator must not distinguish between them.
 */
export const CaptureBundle = z.object({
  bundleId: z.string().uuid(),
  source: z.enum(["scraper", "extension"]),
  url: z.string().url(),
  capturedAt: IsoDateTime,
  legalMode: LegalMode,
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  dom: z.object({
    html: z.string(),
    domHash: z.string(),
    selectorsOfInterest: z.array(ElementRef).optional(),
  }),
  network: z.array(NetworkCapture),
  page: PageSnapshot.optional(),
  meta: z.object({
    title: z.string().optional(),
    robotsAllowed: z.boolean().optional(),
    renderedWithJs: z.boolean(),
  }),
});
export type CaptureBundle = z.infer<typeof CaptureBundle>;
