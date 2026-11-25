# Medaltus Brand Scanner

Finds beauty, skincare, haircare, makeup, nail, and wellness brands, enriches them from their own
websites, and captures their DTC product catalog and UPCs into Google Sheets.

## Files

| File | What it does | Schedule |
|---|---|---|
| `api/setup-sheet.js` | Creates tabs, adds missing headers, seeds starter Sources. Safe to re-run. | Manual, once |
| `api/discover-brands.js` | Runs up to 2 due sources (not run in 7 days), logs sightings, dedupes into Brands | Daily 11:00 UTC |
| `api/enrich-brands.js` | Finds the site if missing, reads homepage: category, socials, logo, platform, signals | Hourly (:20), 12 brands |
| `api/scan-products.js` | Pulls the product catalog + UPCs into Products, writes product_count and upc_coverage | Hourly (:40), 4 brands |
| `medaltus_brands_index.html` | Internal dashboard: Current Brands, Retired Brands, Future Prospects (served at `/`) | — |
| `api/dashboard-data.js`, `api/brand-products.js`, `api/dashboard-update.js` | Dashboard read/write endpoints (password protected) | — |
| `api/import-crm.js` | One-time import of the old CRM export from the CRM Import tab | Manual |
| `api/audit-scan.js`, `api/audit-data.js`, `api/audit-update.js`, `audit_template.js` | Gap audit builder (see below) | Manual, from the dashboard |
| `api/sync-hubspot.js` | One-way HubSpot -> sheet sync: contacts, outreach stage, owner, last activity, won deals | Hourly (:05) |
| `api/find-contacts.js` | Free contact finding: brand About/Team/Press/Contact pages + one web search; ranks people by title into the Contacts tab | Hourly (:30), 5 brands |
| `api/match-linkedin.js` | Matches LinkedIn connections exports (tabs named "LinkedIn - <Name>") to prospects for warm intros | Daily 12:15 UTC |
| `api/find-emails.js` | Hunter.io email finder + verifier for top contacts (manual or dashboard button; not scheduled) | Manual |
| `api/amazon-check.js` | Looks up UPCs + brand name on Amazon (SP-API), pulls offers/Buy Box, classifies each brand | Hourly (:50), 5 brands |
| `api/_lib/*` | Shared helpers (Sheets client, Claude, site parsing, product/UPC extraction, schema) | — |

## Environment variables (Vercel → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `BRAND_SCANNER_SHEET_ID` | The ID in the Sheet URL, between `/d/` and `/edit` |
| `GOOGLE_CLIENT_EMAIL` | `client_email` from the service account JSON key |
| `GOOGLE_PRIVATE_KEY` | `private_key` from the JSON key, pasted as-is (literal `\n` is fine) |
| `ANTHROPIC_API_KEY` | Anthropic Console → API Keys |
| `CRON_SECRET` | Any long random string (e.g. `openssl rand -hex 32`). Vercel cron sends it automatically. |
| `ANTHROPIC_MODEL` | Optional. Defaults to `claude-sonnet-5-5`. |
| `SP_CLIENT_ID` | SP-API app LWA client ID (same as the brand dashboard projects) |
| `SP_CLIENT_SECRET` | SP-API app LWA client secret |
| `SP_REFRESH_TOKEN` | Refresh token for any authorized Medaltus seller account |
| `SP_SELLER_ID` | Optional. That account's seller ID; flags brands a Medaltus account already sells |
| `SP_MARKETPLACE_ID` | Optional. Defaults to `ATVPDKIKX0DER` (US) |
| `AUDIT_MODEL` | Optional. Model for audit research and copy; defaults to `claude-opus-5-5` |
| `HUBSPOT_TOKEN` | HubSpot private app (or service key) access token, read scopes for companies, contacts, deals, owners |
| `HUNTER_API_KEY` | Hunter.io API key (email finder/verifier). Optional `HUNTER_PER_BRAND` (default 1), `HUNTER_MAX_PER_RUN` (default 5) |
| `DASHBOARD_PASSWORD` | Optional. Leave unset for an open dashboard; set it to require a sign-in password |

No leading or trailing spaces. Redeploy after adding or changing any variable.

## Setting up a new Google Sheets writer (service account)

1. Go to console.cloud.google.com and pick a project from the project picker (or click **New Project**).
2. **APIs & Services → Library** → search **Google Sheets API** → **Enable**.
3. **IAM & Admin → Service Accounts → + Create service account**.
   Name it (e.g. `brand-scanner-writer`) → **Create and continue** → skip the role step → **Done**.
4. Click the new service account → **Keys** tab → **Add key → Create new key → JSON → Create**.
   A `.json` file downloads.
5. Open the JSON file:
   - `client_email` → `GOOGLE_CLIENT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (everything inside the quotes, from `-----BEGIN PRIVATE KEY-----` through `-----END PRIVATE KEY-----\n`)
6. Open the Google Sheet → **Share** → paste the `client_email` → **Editor** → uncheck "Notify people" → **Share**.
7. Store the JSON file somewhere safe (password manager / secure drive). Never commit it to GitHub.

If step 4 says key creation is disabled, a Google Workspace admin needs to allow service account keys
for that project (org policy `iam.disableServiceAccountKeyCreation`).

## First run (replace SECRET with your CRON_SECRET)

1. `https://<deployment>/api/setup-sheet?key=SECRET`
2. `https://<deployment>/api/discover-brands?key=SECRET&source=Credo%20Beauty` (test one source)
3. `https://<deployment>/api/enrich-brands?key=SECRET`
4. `https://<deployment>/api/scan-products?key=SECRET`

Single brand: add `&brand_id=<id>` to enrich-brands or scan-products.

## How things work

**Sources tab.** `source_type` is one of:
- `search` — Claude web search using the instruction in `source_value`
- `url` — fetches the page in `source_value` and extracts brands (falls back to search if the page blocks bots)
- `paste` — brand names pasted into `paste_text`, one per line (for Sephora/Ulta-type sites that block bots)

Set `enabled` to N to pause a source. Clear `last_run` to force a re-run on the next cron.

**Exclusions tab.** Any brand matching a `domain` or `brand_name` here is never added to Brands.
Put current Medaltus brands, competitor-agency clients, and already-contacted brands here.

**Overrides are safe.** Enrichment only fills blank cells, so anything you type into Brands stays.

**Brand statuses (discovery_status):** New → Enriched → Products Scanned. Other outcomes:
Needs URL, URL Not Found, Site Unreachable, Duplicate, Not a Fit, Products Partial, No Products Found.

**UPC sources (upc_source in Products):**
`products.json` / `product.json` (Shopify feeds), `json-ld` (structured data on product pages),
`page-script` (theme product JSON in the page), `sku` (brand uses its UPC as the SKU; check digit verified).
Every UPC is check-digit validated; fake/placeholder barcodes are dropped.

**Rescanning a brand's products:** delete its rows in Products, set `discovery_status` back to `Enriched`.

**Limits:** 300 variants and 300 product pages per brand; 3 concurrent requests with a short pause
between product pages. Brands that hit the time limit are marked `Products Partial`.

## Amazon check

For each brand with scanned products: looks up its UPCs (plus any `hero_upcs`), runs a brand-name
catalog search (uses `amazon_brand_name` if filled), pulls offers for up to 40 ASINs, and writes:

- **Products:** asin, amazon_title, amazon_brand, sales_rank, buy_box_price, buy_box_fba, offer_count,
  seller_count, price_gap (Amazon Buy Box vs the brand's own site price)
- **Brands:** amazon_status, amazon_asin_count, amazon_upc_matches, amazon_max_sellers,
  amazon_price_gap (median), amazon_checked_at, amazon_notes; fills amazon_brand_name if Amazon
  lists the brand under a different name

**amazon_status values**
- `Not on Amazon`: no UPC matches and no brand-search results. Rechecked every 30 days; the first
  listing to appear is added to signals.
- `Listed, no active offers`: listings exist but nobody is selling (suppressed or out of stock)
- `On Amazon: reseller signals`: 3+ sellers on a listing, or Buy Box 10%+ below the brand's site price
- `On Amazon: single seller`: one seller per listing at normal pricing (brand-run or a single reseller)

SP-API can't name sellers, so reseller vs. brand-run is a heuristic; check amazon_notes.
The SP-API app needs the Product Listing (catalog) and Pricing roles.

## Dashboard

Open the site root (`https://<deployment>/`). It's open while `DASHBOARD_PASSWORD` is unset; set that env var to require a password.

- **Current Brands / Retired Brands** read the `Partner Brands` tab. A blank `end_date` means current;
  filling it (or using **Retire** on the dashboard) moves the brand to Retired. **Reinstate** clears it.
- **Future Prospects** reads the `Brands` tab. Outreach status, owner, contact, next step, and notes are
  saved back to Brands. Setting a prospect to **Signed** adds it to Partner Brands with today's sign date.
- Every brand in Partner Brands (current or retired) is automatically skipped by discover-brands.

Brand fonts and logo: copy these files from an existing brand dashboard repo into this repo's root:
`GT Walsheim Pro Bold.ttf`, `GT Walsheim Pro Medium.ttf`, `GT Walsheim Pro Light.ttf`,
`Monotype - PlantinMTPro-Italic.otf`, `Medaltus_Typeface Logo_dark bground_RGB.svg`.
Without them the dashboard falls back to DM Sans / Georgia and a text logo.

## Importing the old CRM (Airtable) export

1. Run `/api/setup-sheet` so the `CRM Import` tab and the new Partner Brands columns exist.
2. In the `CRM Import` tab: File → Import → Upload `crm_import.csv` → "Replace current sheet".
3. Run `/api/import-crm`. Customers go to Partner Brands (Current), Terminated to Partner Brands
   (Retired), and everyone else to Brands as prospects with their outreach status. Re-running is safe:
   existing rows are matched by name and only blank cells are filled.

## Gap audit builder

Open the dashboard → **Audit Builder** (or click **Build audit** on a prospect). Run `/api/setup-sheet` once
after deploying to create the three new tabs: **Audit Data**, **Audit Findings**, **Audit Builds**.

| File | What it does |
|---|---|
| `api/audit-scan.js` | Runs one brand's scan in three stages: `amazon` (SP-API: UPCs, sellers, Buy Box, images, bullets, prices), `web` (Claude + web search: Walmart, Target+, TikTok Shop, followers, ratings/reviews/video/A+, competitors, keywords), `findings` (ranks findings; Claude polishes wording, numbers checked against the data) |
| `api/audit-data.js` | Latest scan rows, findings, and saved build for one brand |
| `api/audit-update.js` | Verify / edit / exclude data rows, add data points, save build choices, log exports |
| `api/_lib/audit.js` | Price-comparison rules, 10-point listing rubric, findings library, model recommendation |
| `audit_template.js` | The two-page PDF template used by both the preview and the export |

**Model:** web research and copy use `AUDIT_MODEL` if set, otherwise `claude-opus-5-5`.

**Accuracy rules**
- A price comparison is excluded from findings if the UPC is shared by several site variants, the sizes differ by 15%+,
  or the product names don't match. Gift cards and merch are ignored.
- AI-written wording is only kept if every number in it appears in the source data.
- Export is blocked until every data point printed in the PDF is verified, no channel is Unknown, and findings have
  been recalculated after any data edits. Opportunity estimates require a written basis, printed in the footer.

**Filled in by hand (for now):** competitor monthly Amazon sales and keyword ranks (blank rows labeled for Helium 10),
and "Does the brand sell its own Amazon listings?" whenever Amazon blocks the seller-name lookup.

**Export:** Preview and export → Export PDF opens the print dialog. Save as PDF, Letter, margins None,
Background graphics on.

## HubSpot sync (one-way, HubSpot -> sheet)

`api/sync-hubspot.js` runs hourly. HubSpot companies are matched to Partner Brands, then Brands, by domain, then name.
Linked prospects get their outreach stage, owner, primary contact, next step, and last activity from HubSpot, and
those fields are read-only on the dashboard (notes stay editable). Pipeline companies not yet in the sheet are added
as prospects (source "HubSpot"). A won deal adds the brand to Partner Brands. Companies whose lifecycle stage is
"customer" but aren't in Partner Brands are listed in the Run Log instead of added, since they may not be brands.

Stage mapping lives in the **HubSpot Stage Map** tab. Each new deal stage, lead status, or lifecycle stage is added
with a suggested dashboard stage. Change `dashboard_stage` to remap it, or clear it to ignore that value.
Priority: deal stage, then lead status, then lifecycle stage.

## Contacts (free sources)

- `find-contacts` reads each prospect's About / Team / Story / Press / Contact / Wholesale pages and runs one web search
  for the founder and senior ecommerce/marketing/digital people. Everyone found goes to the **Contacts** tab, ranked
  1 Founder/CEO, 2 C-level, 3 VP/Head, 4 Director, 5 Manager. Emails are only saved if published; ones found only in
  research are labeled "verify before sending". Role emails (hello@, press@, wholesale@) go to the brand's role_emails.
  The top person fills the brand's primary contact if it's blank and the brand isn't managed in HubSpot.
- `match-linkedin`: import a LinkedIn Connections.csv into a tab named `LinkedIn - <Name>` (one tab per person).
  Connections whose company matches a prospect become warm intros on the dashboard and contacts with LinkedIn links.
