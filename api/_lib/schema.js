/**
 * api/_lib/schema.js
 *
 * Single source of truth for tab names, column headers, statuses, and starter sources.
 * All reads/writes go by header NAME, so column order in the sheet doesn't matter.
 */
export const TABS = {
  SOURCES: 'Sources',
  RAW: 'Raw Discoveries',
  BRANDS: 'Brands',
  PRODUCTS: 'Products',
  EXCLUSIONS: 'Exclusions',
  RUN_LOG: 'Run Log',
  PARTNERS: 'Partner Brands',
  CRM_IMPORT: 'CRM Import',
  AUDIT_DATA: 'Audit Data',
  AUDIT_FINDINGS: 'Audit Findings',
  AUDIT_BUILDS: 'Audit Builds',
  HUBSPOT_MAP: 'HubSpot Stage Map',
  CONTACTS: 'Contacts',
  INBOUND: 'Inbound Log',
  SETTINGS: 'Settings',
  RANKS: 'Rank Snapshots',
  CASES: 'Case Studies',
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
    // Amazon check (written by amazon-check.js)
    'amazon_status', 'amazon_asin_count', 'amazon_upc_matches', 'amazon_max_sellers',
    'amazon_price_gap', 'amazon_checked_at', 'amazon_notes',
    // The brand's own Amazon seller ID(s), comma-separated. Everyone else on its listings is a reseller.
    'amazon_seller_id', 'amazon_brand_buybox',
    // HubSpot link (written by sync-hubspot.js). Linked brands' outreach fields are managed in HubSpot.
    'hubspot_company_id', 'hubspot_url', 'hubspot_owner', 'hubspot_stage', 'hubspot_synced_at',
    // Contact finding (find-contacts.js, match-linkedin.js)
    'role_emails', 'warm_intros', 'contacts_checked_at',
    // Outreach (written by the dashboard)
    'outreach_status', 'outreach_owner', 'outreach_updated', 'next_step', 'outreach_notes',
    // System (dashboard)
    'logo_url', 'scan_status', 'scan_requested_at', 'scan_completed_at', 'snapshot_count',
    'audit_status', 'pdf_url',
    // Inbound (website form). inbound_step tracks the fast-track scan; audit_sent_at starts the follow-up clock.
    'inbound_at', 'inbound_step', 'inbound_updated', 'inbound_attempts', 'inbound_note', 'inbound_answers',
    'audit_sent_at', 'audit_due', 'followup_case',
  ],
  [TABS.PRODUCTS]: [
    'brand_id', 'brand_name', 'product_title', 'variant_title', 'sku', 'upc', 'upc_source',
    'price', 'compare_at_price', 'available', 'product_type', 'product_url', 'image_url',
    'last_scraped',
    // Filled by the Amazon check
    'asin', 'match_method', 'amazon_title', 'amazon_brand', 'sales_rank', 'buy_box_price',
    'buy_box_fba', 'offer_count', 'seller_count', 'price_gap', 'last_amazon_check', 'buy_box_seller',
  ],
  [TABS.EXCLUSIONS]: ['brand_name', 'domain', 'reason'],
  [TABS.RUN_LOG]: ['timestamp', 'job', 'processed', 'added', 'updated', 'errors', 'notes'],
  // One row per brand Medaltus has partnered with. status = Current or Retired
  // (a filled end_date also counts as Retired).
  [TABS.PARTNERS]: [
    'brand_name', 'website_url', 'sign_date', 'end_date', 'partnership_model', 'brand_manager',
    'channels', 'dashboard_url', 'retired_reason', 'notes',
    'status', 'category', 'where_met', 'primary_contact', 'contact_email', 'last_correspondence',
    'pricing', 'agreement_files',
    'hubspot_company_id', 'hubspot_url', 'hubspot_owner', 'hubspot_synced_at',
  ],
  // HubSpot stage -> dashboard outreach stage. sync-hubspot adds new HubSpot values with a suggestion.
  [TABS.HUBSPOT_MAP]: ['hubspot_field', 'hubspot_value', 'dashboard_stage', 'notes'],
  // Every person found for a prospect, ranked (1 = founder/CEO ... 5 = manager). One row per person per brand.
  [TABS.CONTACTS]: [
    'brand_id', 'brand_name', 'name', 'title', 'rank', 'email', 'email_source', 'linkedin_url',
    'source', 'source_url', 'evidence', 'found_at',
    // Hunter.io lookups (find-emails.js)
    'email_status', 'email_score', 'email_checked_at',
  ],
  // Every website form submission, kept as received (one row each), with what the scanner did with it.
  // Helium 10 Cerebro keyword ranks per hero product: baseline at audit, re-scans before follow-ups
  [TABS.RANKS]: [
    'taken_at', 'brand_id', 'scan_id', 'kind', 'asin', 'period', 'phrase', 'branded', 'search_volume',
    'organic_rank', 'sponsored_rank', 'sponsored_ads', 'amazon_choice',
  ],
  // Case study library for follow-up emails. Edit freely; only status "Ready" rows are offered.
  // topics: comma list from CASE_TOPICS, used to match a case study to a lead's audit findings.
  [TABS.CASES]: [
    'case_id', 'status', 'title', 'category', 'brand_size', 'channels', 'topics', 'headline',
    'email_summary', 'full_story_url', 'updated_at',
  ],
  // Scanner-managed secrets and connection state (values encrypted). Don't edit by hand.
  [TABS.SETTINGS]: ['key', 'value', 'updated_at'],
  [TABS.INBOUND]: [
    'received_at', 'submission_id', 'form_name', 'page', 'name', 'email', 'brand_text', 'requests',
    'website_guess', 'brand_id', 'outcome', 'raw',
  ],
  // Paste or import the CRM export here, then run /api/import-crm
  [TABS.CRM_IMPORT]: [
    'brand_name', 'category', 'stage', 'services', 'date_signed', 'where_met', 'notes',
    'primary_contact', 'contact_email', 'last_correspondence', 'pricing', 'agreement_files',
  ],
  // Gap audit: one row per data point per scan. The builder reads the latest scan_id for a brand.
  [TABS.AUDIT_DATA]: [
    'brand_id', 'scan_id', 'section', 'field', 'label', 'value', 'source', 'source_url',
    'method', 'confidence', 'verified', 'verified_by', 'captured_at', 'notes',
  ],
  // One row per finding that fired in a scan, already ranked.
  [TABS.AUDIT_FINDINGS]: [
    'brand_id', 'scan_id', 'finding_id', 'category', 'rank', 'score', 'big_number', 'claim',
    'detail', 'fix', 'next_step', 'model_fit', 'data_refs', 'copy_source', 'fired_at',
  ],
  // One row per brand: what the builder chose for the PDF.
  [TABS.AUDIT_BUILDS]: [
    'brand_id', 'scan_id', 'updated_at', 'status', 'selections', 'logo_data', 'exported_at', 'export_count',
  ],
};

export const AUDIT_STAGES = ['amazon', 'web', 'findings'];

// Inbound fast-track scan, in order. Each step runs in its own function call.
export const INBOUND_STEPS = ['enrich', 'products', 'amazon', 'contacts', 'audit_amazon', 'audit_web', 'audit_findings'];
// Where a lead ends up: review = audit scanned and waiting for Jaclyn; sent = audit sent (follow-up clock running).
export const INBOUND_DONE = { REVIEW: 'review', SENT: 'sent', NEEDS_WEBSITE: 'needs_website', NOT_A_FIT: 'not_a_fit', FAILED: 'failed' };

export const OUTREACH_STAGES = [
  'Not Contacted', 'Researching', 'Audit Ready', 'Contacted', 'In Conversation', 'Proposal Sent', 'Signed',
];
export const OUTREACH_CLOSED = ['Not Interested', 'Disqualified'];

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

export const AMAZON_STATUS = {
  NOT_ON_AMAZON: 'Not on Amazon',
  NO_OFFERS: 'Listed, no active offers',
  // Seller ID unknown: classified by seller count only
  ONE: 'On Amazon: one seller',
  MULTIPLE: 'On Amazon: multiple sellers',
  // Brand's seller ID entered: we know exactly who is who
  BRAND_ONLY: 'Brand only',
  BRAND_RESELLERS: 'Brand + resellers',
  RESELLERS_ONLY: 'Resellers only',
};

export const CATEGORIES = ['skincare', 'haircare', 'makeup', 'nail', 'wellness', 'other'];

// source_type: "shopify_vendors" = retailer runs on Shopify; source_value is its domain. Reads every
//                                   product's vendor from /products.json (complete list, no AI cost)
//              "search" = Claude web search with the instruction in source_value
//              "url"    = fetch this directory/exhibitor page and extract brands
//              "paste"  = brand names pasted into paste_text, one per line (for sites that block bots)
/** Topics a case study can be tagged with (the dashboard maps audit findings onto these). */
export const CASE_TOPICS = ['pricing', 'sellers', 'listing health', 'compliance', 'listings', 'search', 'advertising',
  'reviews', 'new channels', 'catalog', 'fulfillment'];

/** Starter case studies: Jaclyn's compliance story plus the three results published on medaltus.com. */
export const SEED_CASES = [
  {
    case_id: 'compliance-black-friday', status: 'Ready',
    title: 'Protecting nearly $40,000 a month ahead of Black Friday',
    category: 'Beauty', brand_size: 'Longtime beauty partner, 250+ products', channels: 'Amazon',
    topics: 'compliance, listing health', headline: '45+ listings reinstated · nearly $40K a month protected · root cause fixed',
    email_summary: 'Just weeks before Black Friday, Amazon’s automated compliance screening confused an ingredient found in 98% of one of our beauty partners’ 250+ products with a restricted chemical under Washington State’s cosmetic safety law, a rule that doesn’t even take effect until 2027. Listings were blocked in Washington, new flags appeared almost every morning, and nearly $40,000 a month was at risk. We took it off their plate entirely. We researched the regulation down to the chemical identifiers, handled every appeal ourselves and, when standard support kept returning the same denials, escalated until Amazon corrected the screening itself. More than 45 listings were reinstated the day before their Black Friday promotions began, and their full catalog is now protected from the same issue.',
    full_story_url: '',
  },
  {
    case_id: 'buybox-three-hours', status: 'Ready',
    title: 'Buy Box back in under three hours',
    category: 'Nail care', brand_size: 'Nail care brand, 250+ products, 16 top-selling kits', channels: 'Amazon',
    topics: 'listing health, sellers, pricing', headline: 'Buy Box restored on 16 top sellers in under three hours',
    email_summary: 'Right after Prime Big Deal Days, 16 of one of our nail care partners’ top-selling kits lost the Buy Box on Amazon, with no lower-priced offer anywhere to explain it. We caught it during our post-event review, ruled out pricing conflicts and escalated through Seller Support and directly to our Amazon account manager. The Buy Box was back on all 16 listings in under three hours, protecting their best sellers heading into Black Friday.',
    full_story_url: '',
  },
  {
    case_id: 'skincare-581', status: 'Ready',
    title: 'Growing a skincare brand 581% across three channels',
    category: 'Skincare', brand_size: 'Skincare brand, partner since 2018', channels: 'Amazon, Shopify, TikTok Shop',
    topics: 'search, advertising, new channels, pricing', headline: '+581% revenue · advertising 2.2x more efficient',
    email_summary: 'We’ve grown alongside one of our skincare partners since 2018 across Amazon, Shopify and TikTok Shop. Over that time their revenue has grown 581%, and over the last few years we’ve made their advertising 2.2 times more efficient. What made the difference wasn’t one tactic. It was having one team responsible for every channel, so advertising, inventory and listings all moved toward the same goal.',
    full_story_url: '',
  },
  {
    case_id: 'nailcare-251', status: 'Ready',
    title: 'Scaling a nail care catalog to 192 products',
    category: 'Nail care', brand_size: 'Nail care brand, partner since 2018', channels: 'Amazon, Shopify',
    topics: 'catalog, listings, pricing, sellers', headline: '+251% revenue · catalog grown to 192 products',
    email_summary: 'We’ve partnered with one of our nail care brands since 2018 on Amazon and Shopify. Their revenue has grown 251% in that time, and together we expanded their catalog to 192 products without the operational growing pains that usually come with it.',
    full_story_url: '',
  },
  {
    case_id: 'wellness-410', status: 'Ready',
    title: 'Growing a supplement brand 410% on Amazon and Walmart',
    category: 'Supplements & wellness', brand_size: 'Supplement brand, partner since 2025', channels: 'Amazon, Walmart',
    topics: 'advertising, new channels, search', headline: '+410% revenue · 62% lower ad cost of sale',
    email_summary: 'Since one of our supplement partners began working with us on Amazon and Walmart in 2025, their revenue has grown 410% and their advertising cost of sale has come down 62%. Bringing both marketplaces under one team meant their advertising, inventory and listings could finally work together.',
    full_story_url: '',
  },
];

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
