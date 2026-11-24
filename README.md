# Medaltus Brand Scanner

Finds beauty, skincare, haircare, makeup, nail, and wellness brands, enriches them from their own
websites, and captures their DTC product catalog and UPCs into Google Sheets.

## Files

| File | What it does | Schedule |
|---|---|---|
| `api/setup-sheet.js` | Creates tabs, adds missing headers, seeds starter Sources. Safe to re-run. | Manual, once |
| `api/discover-brands.js` | Runs up to 2 due sources (not run in 7 days), logs sightings, dedupes into Brands | Daily 11:00 UTC |
| `api/enrich-brands.js` | Finds the site if missing, reads homepage: category, socials, logo, platform, signals | Every 2 hrs (:20) |
| `api/scan-products.js` | Pulls the product catalog + UPCs into Products, writes product_count and upc_coverage | Every 2 hrs (:40) |
| `api/amazon-check.js` | Looks up UPCs + brand name on Amazon (SP-API), pulls offers/Buy Box, classifies each brand | Every 2 hrs (:50) |
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
