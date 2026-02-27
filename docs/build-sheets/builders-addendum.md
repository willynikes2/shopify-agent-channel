Phase 9.5–11 Addendum — Embedded App + Billing
Purpose

Extend the existing Phase 1–9 architecture (engine, ingestion, manifest, MCP, execution, reliability) with:

Shopify Embedded Admin App

Shopify Billing Integration

Plan enforcement + feature gating

Merchant lifecycle management

The core engine remains in packages/.
The embedded app is a control surface and billing interface.

1️⃣ Architecture Addition

Add a new workspace:

apps/shopify-embedded/

Stack:

Shopify CLI scaffold

Remix

Embedded in Shopify Admin

Uses App Bridge

Uses Shopify session token auth

The embedded app:

Handles OAuth

Displays metrics

Manages billing

Toggles agent channel

Does NOT duplicate execution logic

2️⃣ Data Model Changes

Extend shops table:

Add:

plan: 'free' | 'pro' | 'enterprise'
billing_status: 'inactive' | 'active' | 'cancelled' | 'trialing'
billing_subscription_id: string | null
trial_ends_at: timestamp | null
agent_enabled: boolean
directory_opt_in: boolean

Add plan_limits logic in code (not DB).

3️⃣ Plan Structure

Start simple.

Free Plan

Agent channel enabled

Max 200 agent tool calls/month

No directory boost

Basic metrics only

Pro Plan ($49/month)

Unlimited agent calls

Performance dashboard

Directory eligibility

Priority ranking weight

Enterprise (manual)

SLA

Custom scoring

Volume pricing

You can adjust pricing later — structure is what matters.

4️⃣ Billing Implementation (Shopify Billing API)

Inside embedded app:

When merchant clicks "Upgrade to Pro":

Call backend endpoint:

POST /admin/shops/:id/billing/create

Backend:

Calls Shopify Billing API

Creates recurring application charge

Returns confirmation URL

Merchant approves inside Shopify.

Shopify redirects to:

/billing/confirm

Backend verifies charge:

Activate subscription

Update billing_status = active

Set plan = pro

Enable Pro features immediately.

5️⃣ Billing Endpoints to Implement

Add new admin routes:

POST   /admin/shops/:id/billing/create
GET    /admin/shops/:id/billing/status
POST   /admin/shops/:id/billing/cancel
POST   /webhooks/shopify/app/uninstalled

Webhook handling:

On app uninstall:

Mark shop inactive

Disable agent endpoints

Cancel billing

6️⃣ Plan Enforcement Layer

Add middleware in your execution router:

Before tool execution:

if plan == 'free' and monthly_usage > limit:
    return 402-like response:
        { error: "Plan limit exceeded" }

Track usage per shop per month in DB.

7️⃣ Embedded Admin UI Pages

Add:

Dashboard (/)

Show:

Plan

Billing status

Agent enabled toggle

Monthly usage

Upgrade button (if free)

Cancel subscription (if pro)

Billing Page (/billing)

Show:

Current plan

Trial status

Renewal date

Upgrade / Downgrade buttons

Performance Page (/performance)

Display:

7-day success rate

p50 / p95 latency

Tool breakdown

Failure reasons

8️⃣ Directory Preparation (Future AEO Layer)

Add:

directory_opt_in boolean toggle.

Free plan:

opt-in allowed but low ranking weight.

Pro:

higher ranking weight multiplier.

Do NOT implement paid boosts yet.
Just structure the data model.

9️⃣ Security Requirements

All admin routes require valid Shopify session token

Validate shop domain matches session

Never expose access tokens to frontend

Encrypt stored tokens

🔟 What This Achieves

After Phase 11 completes with this addendum:

You will have:

✔ Deterministic Shopify adapter
✔ Agent endpoints (MCP + HTTP)
✔ Manifest generation
✔ Success scoring
✔ Embedded Shopify admin app
✔ Billing system
✔ Plan enforcement
✔ Merchant lifecycle management

That is a real SaaS product.

Not a prototype.

🚀 After Phase 11

Then you move to:

Phase 12:

Agent directory

Cross-merchant search demo

Consumer orchestration client

But not before monetization is wired.

Strategic Note

You are not building:

“Ads for bots.”

You are building:

Agent Performance Infrastructure.

Billing validates value.
Metrics create leverage.
Directory creates distribution.
Optimization creates moat.