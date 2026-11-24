// Single source of truth for tab names, column headers, statuses, and starter sources.
// All reads/writes go by header NAME, so column order in the sheet doesn't matter.

export const TABS = {
  SOURCES: 'Sources',
  RAW: 'Raw Discoveries',
  BRANDS: 'Brands',
  PRODUCTS: 'Products',
  EXCLUSIONS: 'Exclusions',
  RUN_LOG: 'Run Log',
};

export const HEADERS = {
  [TABS.SOURCES]: [
    'source_name', 'source_type', 'source_value', 'paste_text', 'signal_label',
    'enabled', 'last_run', 'brands_found', 'notes',
  ],
  [TABS.RAW]: [
    'found_at', 'brand_name', 'website_url', 'source_name', 'source_ref', 'signal',
  ],
  [TABS.BRANDS]: [
    // Required
    'brand_id', 'brand_name', 'website_url',
    // Recommended
    'category', 'amazon_brand_name', 'contact_name', 'contact_title', 'contact_email',
    'contact_linkedin', 'tiktok_handle', 'instagram_handle', 'lead_source', 'form_message',
    // Optional overrides
    'hero_products', 'hero_asins', 'hero_upcs', 'core_keywords', 'known_competitors',
    'est_revenue', 'dtc_share', 'team_size',
    // Discovery (written by this scanner)
    'first_seen', 'sources', 'source_count', 'signals', 'platform', 'product_count',
    'upc_coverage', 'discovery_status',
    // System (dashboard)
    'logo_url', 'scan_status', 'scan_requested_at', 'scan_completed_at', 'snapshot_count',
    'audit_status', 'pdf_url',
  ],
  [TABS.PRODUCTS]: [
    'brand_id', 'brand_name', 'product_title', 'variant_title', 'sku', 'upc', 'upc_source',
    'price', 'compare_at_price', 'available', 'product_type', 'product_url', 'image_url',
    'last_scraped',
    // Filled later by the Amazon scan
    'asin', 'match_method', 'amazon_title', 'buy_box_price', 'offer_count', 'last_amazon_check',
  ],
  [TABS.EXCLUSIONS]: ['brand_name', 'domain', 'reason'],
  [TABS.RUN_LOG]: ['timestamp', 'job', 'processed', 'added', 'updated', 'errors', 'notes'],
};

export const STATUS = {
  NEW: 'New',                       // has a website, waiting for enrichment
  NEEDS_URL: 'Needs URL',           // found by name only, enrichment will look up the site
  URL_NOT_FOUND: 'URL Not Found',
  UNREACHABLE: 'Site Unreachable',
  DUPLICATE: 'Duplicate',
  NOT_A_FIT: 'Not a Fit',
  ENRICHED: 'Enriched',             // waiting for product scan
  PRODUCTS_SCANNED: 'Products Scanned',
  PRODUCTS_PARTIAL: 'Products Partial',
  NO_PRODUCTS: 'No Products Found',
};

export const CATEGORIES = ['skincare', 'haircare', 'makeup', 'nail', 'wellness', 'other'];

// source_type: "shopify_vendors" = retailer runs on Shopify; source_value is its domain. Reads every
//                                   product's vendor from /products.json (complete list, no AI cost)
//              "search" = Claude web search with the instruction in source_value
//              "url"    = fetch this directory/exhibitor page and extract brands
//              "paste"  = brand names pasted into paste_text, one per line (for sites that block bots)
export const SEED_SOURCES = [
  { source_name: 'Credo Beauty', source_type: 'shopify_vendors', signal_label: 'Sold at Credo',
    source_value: 'credobeauty.com' },
  { source_name: 'The Detox Market', source_type: 'shopify_vendors', signal_label: 'Sold at The Detox Market',
    source_value: 'thedetoxmarket.com' },
  { source_name: 'Olive Young Global', source_type: 'search', signal_label: 'Sold at Olive Young Global',
    source_value: 'List Korean beauty brands sold on Olive Young Global (global.oliveyoung.com).' },
  { source_name: 'Soko Glam', source_type: 'shopify_vendors', signal_label: 'Sold at Soko Glam',
    source_value: 'sokoglam.com' },
  { source_name: 'Indie Beauty Expo', source_type: 'search', signal_label: 'IBE exhibitor',
    source_value: 'List exhibiting brands from the most recent Indie Beauty Expo exhibitor list.' },
  { source_name: 'Recent Funding', source_type: 'search', signal_label: 'Recently raised funding',
    source_value: 'Find beauty, skincare, haircare, makeup, nail, or wellness brands that announced a funding round in the last 90 days (sources like Beauty Independent, Glossy, WWD). Put the round and date in note.' },
  { source_name: 'Hiring Amazon Role', source_type: 'search', signal_label: 'Hiring for Amazon/marketplace role',
    source_value: 'Find beauty, skincare, haircare, or wellness brands with current job postings for an Amazon manager, marketplace manager, or Amazon-focused ecommerce role. Put the job title in note.' },
  { source_name: 'Faire Beauty Wholesale', source_type: 'search', signal_label: 'Wholesales on Faire',
    source_value: 'List independent beauty and skincare brands that sell wholesale on Faire (faire.com).' },
].map(s => ({ paste_text: '', enabled: 'Y', last_run: '', brands_found: '', notes: '', ...s }));

// Seed rows from the first version that should be upgraded in place by /api/setup-sheet
export const SOURCE_UPGRADES = SEED_SOURCES.filter(s => s.source_type === 'shopify_vendors');
