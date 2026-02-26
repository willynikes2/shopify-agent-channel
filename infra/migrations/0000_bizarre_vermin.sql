CREATE TABLE "manifests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"capabilities_json" jsonb NOT NULL,
	"tools_json" jsonb NOT NULL,
	"agents_json" jsonb NOT NULL,
	"generated_at" timestamp DEFAULT now(),
	"is_active" boolean DEFAULT true
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"shopify_product_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"product_type" text,
	"vendor" text,
	"tags" text[],
	"status" text DEFAULT 'active',
	"variants_json" jsonb NOT NULL,
	"images_json" jsonb,
	"shopify_updated_at" timestamp,
	"synced_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "shops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_domain" text NOT NULL,
	"shopify_access_token_encrypted" text NOT NULL,
	"shopify_scopes" text NOT NULL,
	"shop_name" text,
	"shop_currency" text DEFAULT 'USD',
	"plan" text DEFAULT 'starter' NOT NULL,
	"agent_hostname" text,
	"agent_enabled" boolean DEFAULT true,
	"installed_at" timestamp DEFAULT now(),
	"uninstalled_at" timestamp,
	"last_synced_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "shops_shop_domain_unique" UNIQUE("shop_domain"),
	CONSTRAINT "shops_agent_hostname_unique" UNIQUE("agent_hostname")
);
--> statement-breakpoint
CREATE TABLE "success_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"window_days" integer DEFAULT 7 NOT NULL,
	"success_rate" real NOT NULL,
	"p50_latency_ms" integer,
	"p95_latency_ms" integer,
	"total_runs" integer NOT NULL,
	"failure_modes_json" jsonb,
	"last_verified_at" timestamp,
	"computed_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "tool_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"shop_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"inputs_json" jsonb,
	"exec_method" text DEFAULT 'adapter' NOT NULL,
	"status" text NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"trace_ref" text,
	"agent_id" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "manifests" ADD CONSTRAINT "manifests_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "success_scores" ADD CONSTRAINT "success_scores_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_runs" ADD CONSTRAINT "tool_runs_shop_id_shops_id_fk" FOREIGN KEY ("shop_id") REFERENCES "public"."shops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_shop_shopify_product_unique" ON "products" USING btree ("shop_id","shopify_product_id");--> statement-breakpoint
CREATE INDEX "products_shop_status_idx" ON "products" USING btree ("shop_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "success_scores_shop_tool_window_unique" ON "success_scores" USING btree ("shop_id","tool_name","window_days");--> statement-breakpoint
CREATE INDEX "success_scores_shop_tool_idx" ON "success_scores" USING btree ("shop_id","tool_name");--> statement-breakpoint
CREATE INDEX "tool_runs_shop_tool_time_idx" ON "tool_runs" USING btree ("shop_id","tool_name","created_at");