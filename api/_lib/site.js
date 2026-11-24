// Deterministic homepage parsing: platform, social handles, logo, marketplace links.

export function detectPlatform(html) {
  const h = String(html || '').toLowerCase();
  if (h.includes('cdn.shopify.com') || h.includes('shopify.theme') || h.includes('myshopify.com')) return 'Shopify';
  if (h.includes('woocommerce')) return 'WooCommerce';
  if (h.includes('bigcommerce')) return 'BigCommerce';
  if (h.includes('demandware') || h.includes('/on/demandware.store')) return 'Salesforce Commerce';
  if (h.includes('magento') || h.includes('mage/cookies')) return 'Magento';
  if (h.includes('static.wixstatic.com')) return 'Wix';
  if (h.includes('squarespace')) return 'Squarespace';
  return 'Other';
}

const IG_SKIP = new Set(['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct', 'sharer']);

export function findSocials(html) {
  const h = String(html || '');
  let instagram = '', tiktok = '';
  for (const m of h.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
    if (!IG_SKIP.has(m[1].toLowerCase())) { instagram = '@' + m[1].replace(/\.$/, ''); break; }
  }
  const t = h.match(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/i);
  if (t) tiktok = '@' + t[1].replace(/\.$/, '');
  return { instagram, tiktok };
}

export function extractJsonLd(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1].trim())); } catch { /* some sites ship invalid JSON-LD */ }
  }
  const flat = [];
  const walk = node => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== 'object') return;
    flat.push(node);
    if (node['@graph']) walk(node['@graph']);
  };
  walk(out);
  return flat;
}

const typeIs = (node, t) => [].concat(node?.['@type'] || []).map(String).includes(t);

function absolute(url, base) {
  try { return new URL(url, base).href; } catch { return ''; }
}

export function findLogo(html, baseUrl) {
  for (const node of extractJsonLd(html)) {
    if (typeIs(node, 'Organization') || typeIs(node, 'Brand')) {
      const logo = typeof node.logo === 'string' ? node.logo : node.logo?.url;
      if (logo) return absolute(logo, baseUrl);
    }
  }
  const icon = String(html).match(/<link[^>]+rel=["']apple-touch-icon["'][^>]*href=["']([^"']+)["']/i)
            || String(html).match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["']apple-touch-icon["']/i);
  if (icon) return absolute(icon[1], baseUrl);
  const og = String(html).match(/<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  return og ? absolute(og[1], baseUrl) : '';
}

export function marketplaceSignals(html) {
  const h = String(html || '').toLowerCase();
  const signals = [];
  if (/amazon\.com\/(dp|stores|s\?|shops)|amzn\.to\//.test(h)) signals.push('Links to Amazon from site');
  if (h.includes('walmart.com/')) signals.push('Links to Walmart from site');
  if (h.includes('target.com/')) signals.push('Links to Target from site');
  if (h.includes('faire.com/')) signals.push('Wholesales on Faire');
  return signals;
}

export function pageTitleAndDescription(html) {
  const title = (String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const desc = String(html).match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] || '';
  return { title, desc };
}

export { typeIs };
