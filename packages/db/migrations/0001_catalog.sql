CREATE TABLE "catalog" (
	"domain" text PRIMARY KEY NOT NULL,
	"server_id" uuid,
	"origin" text NOT NULL,
	"title" text NOT NULL,
	"tier" text DEFAULT 'auto_gen' NOT NULL,
	"confidence" real DEFAULT 0 NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"tool_count" integer DEFAULT 0 NOT NULL,
	"local_test_passed" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"artifact" jsonb,
	"seeded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "catalog_listing_idx" ON "catalog" ("status","confidence");
