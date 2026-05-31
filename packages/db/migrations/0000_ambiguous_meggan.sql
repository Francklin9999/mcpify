CREATE TYPE "public"."contribution_status" AS ENUM('pending', 'accepted', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."execution_kind" AS ENUM('http', 'browser');--> statement-breakpoint
CREATE TYPE "public"."health_result" AS ENUM('pass', 'fail');--> statement-breakpoint
CREATE TYPE "public"."server_status" AS ENUM('active', 'degraded', 'broken', 'regenerating');--> statement-breakpoint
CREATE TYPE "public"."server_tier" AS ENUM('curated', 'auto_gen');--> statement-breakpoint
CREATE TABLE "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid,
	"bundle_ref" text NOT NULL,
	"contributed_by" text NOT NULL,
	"status" "contribution_status" DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "health_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text,
	"result" "health_result" NOT NULL,
	"error_class" text,
	"dom_hash" text,
	"content_length" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_jobs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_versions" (
	"server_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"artifact_url" text NOT NULL,
	"tool_count" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_versions_server_id_version_pk" PRIMARY KEY("server_id","version")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"server_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"tier" "server_tier" NOT NULL,
	"confidence" real NOT NULL,
	"install_count" integer DEFAULT 0 NOT NULL,
	"status" "server_status" NOT NULL,
	"current_version" integer,
	"last_parsed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "servers_url_unique" UNIQUE("url")
);
--> statement-breakpoint
CREATE TABLE "tools" (
	"server_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"confidence" real NOT NULL,
	"execution_kind" "execution_kind" NOT NULL,
	"definition" jsonb NOT NULL,
	CONSTRAINT "tools_server_id_version_name_pk" PRIMARY KEY("server_id","version","name")
);
--> statement-breakpoint
ALTER TABLE "contributions" ADD CONSTRAINT "contributions_server_id_servers_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("server_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_events" ADD CONSTRAINT "health_events_server_id_servers_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_versions" ADD CONSTRAINT "server_versions_server_id_servers_server_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("server_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tools" ADD CONSTRAINT "tools_server_id_version_server_versions_server_id_version_fk" FOREIGN KEY ("server_id","version") REFERENCES "public"."server_versions"("server_id","version") ON DELETE cascade ON UPDATE no action;