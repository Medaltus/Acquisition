/**
 * audit_template.js
 *
 * Two-page Marketplace Gap Audit template (preview + PDF export).
 */
/* Medaltus Marketplace Gap Audit: two-page letter-size template.
   renderAuditHtml(model) returns a complete HTML document. The dashboard shows it in an iframe for preview
   and prints the same document to PDF, so what you approve is exactly what gets exported. */
(function (root) {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => {
    const v = Number(n);
    if (!Number.isFinite(v)) return '';
    return v >= 1e6 ? `$${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${Math.round(v)}`;
  };
  const bigSize = (s, sizes) => { const n = String(s || '').length; return n <= 3 ? sizes[0] : n <= 5 ? sizes[1] : n <= 8 ? sizes[2] : sizes[3]; };

  const CAT = {
    control: { label: 'Control & pricing', color: '#8A4B1F' },
    growth: { label: 'Growth channel', color: '#16714B' },
    conversion: { label: 'Conversion', color: '#4F5F86' },
    visibility: { label: 'Search visibility', color: '#4F5F86' },
  };
  const PILL = {
    'Brand-run': 'pill-run', 'Sold by others': 'pill-others', 'Listed, not selling': 'pill-others', Absent: 'pill-absent',
  };
  const BAR_COLORS = { Amazon: '#001F60', 'TikTok Shop': '#24E9A3', Walmart: '#6B7BA2', 'Target+': '#C87D2F' };
  const NUMS = ['One', 'Two', 'Three'];

  function css(base) {
    const f = name => `url("${base}/${encodeURIComponent(name)}")`;
    return `
@font-face{font-family:'GTW';src:${f('GT Walsheim Pro Light.ttf')} format('truetype');font-weight:300;}
@font-face{font-family:'GTW';src:${f('GT Walsheim Pro Medium.ttf')} format('truetype');font-weight:500;}
@font-face{font-family:'GTW';src:${f('GT Walsheim Pro Bold.ttf')} format('truetype');font-weight:700;}
@font-face{font-family:'Plantin';src:${f('Monotype - PlantinMTPro-Italic.otf')} format('opentype');font-style:italic;}
@page{size:letter;margin:0;}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{background:#E9E6E2;}
body{font-family:'GTW','DM Sans',system-ui,sans-serif;font-weight:300;color:#001F60;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.page > *{flex-shrink:0;}
.page{width:8.5in;height:11in;background:#FAF6F2;position:relative;overflow:hidden;padding:.56in .6in .5in;display:flex;flex-direction:column;margin:0 auto 24px;}
@media print{html,body{background:#FAF6F2;}.page{margin:0;page-break-after:always;break-after:page;}.page:last-child{page-break-after:auto;break-after:auto;}}
.serif{font-family:'Plantin',Georgia,'Times New Roman',serif;font-style:italic;font-weight:400;}
.hd{display:flex;justify-content:space-between;align-items:center;}
.logo{font-weight:700;font-size:21px;letter-spacing:-.4px;color:#001F60;}
.logo span{color:#6B7BA2;}
.eyebrow{font-size:10px;font-weight:500;letter-spacing:.17em;text-transform:uppercase;color:#4F5F86;}
.prep{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;margin-top:.58in;}
.prospect-logo{height:44px;max-width:150px;object-fit:contain;object-position:right center;}
h1{font-weight:500;font-size:52px;line-height:1.02;letter-spacing:-1.4px;margin-top:12px;max-width:6.2in;}
h1 .serif{font-size:1.04em;letter-spacing:-.5px;}
.lede{font-size:15.5px;line-height:1.55;color:#33467A;margin-top:18px;max-width:5.6in;}
.headline{position:relative;overflow:hidden;background:#001F60;border-radius:20px;color:#fff;margin-top:.42in;padding:34px 40px 34px 44px;display:flex;gap:30px;align-items:center;min-height:2.2in;}
.headline::after{content:'';position:absolute;right:-70px;top:-80px;width:240px;height:240px;border-radius:50%;background:rgba(36,233,163,.09);}
.headline .big{color:#24E9A3;line-height:.9;flex-shrink:0;min-width:78px;text-align:center;}
.headline .eyebrow{color:rgba(255,255,255,.62);}
.headline .line{font-weight:500;font-size:25px;line-height:1.22;margin-top:8px;letter-spacing:-.3px;}
.headline .sub{font-size:14px;line-height:1.5;color:rgba(255,255,255,.82);margin-top:12px;max-width:4.9in;}
.fp-hd{display:flex;justify-content:space-between;align-items:baseline;margin-top:.4in;margin-bottom:12px;}
.fp-hd h2{font-weight:500;font-size:22px;letter-spacing:-.3px;}
.legend{display:flex;gap:16px;font-size:11px;color:#33467A;align-items:center;}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:0;}
.fp{background:#fff;border:1px solid #EDE5DD;border-radius:16px;overflow:hidden;}
.fp-row{display:grid;grid-template-columns:1.55in 1.6in 1fr;align-items:center;padding:15px 26px;border-top:1px solid #F1EAE3;font-size:13px;}
.fp-row:first-child{border-top:none;}
.fp-row .ch{font-weight:500;font-size:14px;}
.fp-row .det{color:#33467A;line-height:1.4;}
.pill{display:inline-block;font-size:11px;font-weight:500;padding:4px 12px;border-radius:999px;}
.pill-run{background:#DDF8EE;color:#127A55;}
.pill-others{background:#F4DFD0;color:#8A4B1F;}
.pill-absent{background:#fff;color:#001F60;border:1px solid #001F60;padding:3px 11px;}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#4F5F86;padding-top:16px;}
.foot .rule{display:inline-block;width:34px;height:2px;background:#24E9A3;vertical-align:middle;margin-right:12px;}
.foot .serif{font-size:13px;color:#001F60;}
h2.p2{font-weight:500;font-size:40px;letter-spacing:-1px;margin-top:.3in;}
h2.p2 .serif{font-size:1.06em;letter-spacing:-.3px;}
.cards{display:grid;gap:14px;margin-top:.24in;}
.card{background:#fff;border:1px solid #EDE5DD;border-radius:16px;padding:20px 20px 18px;display:flex;flex-direction:column;}
.card .big{line-height:1;margin-top:10px;}
.card .claim{font-weight:500;font-size:15px;line-height:1.32;margin-top:12px;}
.card .det{font-size:13px;line-height:1.5;color:#33467A;margin-top:10px;}
.card .fix{margin-top:auto;padding-top:12px;border-top:1px solid #EDE5DD;font-size:12.5px;line-height:1.45;}
.card .fix-wrap{margin-top:14px;flex:1;display:flex;flex-direction:column;justify-content:flex-end;}
.card .fix b{font-weight:500;}
.row2{display:grid;gap:14px;margin-top:14px;}
.callout{background:#F4DFD0;border-radius:16px;padding:20px 24px;}
.callout .eyebrow{color:#8A4B1F;}
.callout .t{font-weight:500;font-size:19px;line-height:1.3;margin-top:10px;}
.callout .t .serif{font-size:1.18em;}
.callout .s{font-size:13px;line-height:1.5;color:#4A3A30;margin-top:10px;}
.opp{background:#fff;border:1px solid #EDE5DD;border-radius:16px;padding:20px 24px;}
.opp-hd{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;}
.opp-hd .est{font-size:11px;color:#4F5F86;}
.bar{display:grid;grid-template-columns:1.05in 1fr .95in;align-items:center;gap:12px;padding:6px 0;font-size:13px;}
.bar .n{font-weight:500;}
.bar .track{height:8px;background:#EEF0F5;border-radius:4px;position:relative;}
.bar .fill{position:absolute;top:0;bottom:0;border-radius:4px;}
.bar .v{text-align:right;color:#33467A;}
.partner{position:relative;overflow:hidden;background:#001F60;color:#fff;border-radius:20px;margin-top:14px;padding:24px 32px;display:grid;gap:32px;}
.partner::before{content:'';position:absolute;left:-60px;bottom:-110px;width:230px;height:230px;border-radius:50%;background:rgba(255,255,255,.06);}
.partner > *{position:relative;}
.partner .eyebrow{color:#24E9A3;}
.partner .ln{font-weight:500;font-size:22px;line-height:1.25;margin-top:8px;letter-spacing:-.3px;}
.partner .ln .serif{font-size:1.08em;}
.partner .sb{font-size:13px;color:rgba(255,255,255,.78);margin-top:10px;}
.partner .steps-hd{color:rgba(255,255,255,.62);}
.partner ol{list-style:none;margin-top:6px;}
.partner li{display:flex;gap:14px;align-items:baseline;font-size:13.5px;line-height:1.4;padding:5px 0;}
.partner li .serif{color:#24E9A3;font-size:22px;width:14px;flex-shrink:0;}
.cta{display:flex;justify-content:space-between;align-items:center;margin-top:16px;}
.cta .q{font-weight:500;font-size:16px;}
.cta a{background:#24E9A3;color:#001F60;text-decoration:none;font-weight:500;font-size:14px;padding:12px 26px;border-radius:999px;}
`;
  }

  function renderAuditHtml(m) {
    const base = m.assetBase || '';
    const big = (s, sizes) => `<div class="big serif" style="font-size:${bigSize(s, sizes)}px">${esc(s)}</div>`;

    const page1 = `
<section class="page">
  <div class="hd"><div class="logo">medalt<span>us.</span></div><div class="eyebrow">Marketplace gap audit &middot; ${esc(m.dateLabel)}</div></div>
  <div class="prep">
    <div>
      <div class="eyebrow">Prepared for ${esc(m.preparedFor)}</div>
      <h1>Where ${esc(m.brandName)} stands on <span class="serif">every shelf.</span></h1>
    </div>
    ${m.logoSrc ? `<img class="prospect-logo" src="${esc(m.logoSrc)}" alt="${esc(m.brandName)} logo">` : ''}
  </div>
  <p class="lede">A snapshot of how your brand shows up across ${esc(m.channelList || 'Amazon, Walmart, TikTok Shop, Target+, and your own site')}, and where the biggest gaps are.</p>
  ${m.headline ? `<div class="headline">
    ${big(m.headline.big, [120, 92, 64, 46])}
    <div><div class="eyebrow">The headline</div><div class="line">${esc(m.headline.line)}</div>${m.headline.sub ? `<div class="sub">${esc(m.headline.sub)}</div>` : ''}</div>
  </div>` : ''}
  <div class="fp-hd"><h2>Your channel footprint</h2>
    <div class="legend"><span><i class="dot" style="background:#24E9A3"></i>Brand-run</span><span><i class="dot" style="background:#C88A5E"></i>Sold by others</span><span><i class="dot" style="border:1px solid #6B7BA2"></i>Absent</span></div>
  </div>
  <div class="fp">${(m.channels || []).map(c => `
    <div class="fp-row"><div class="ch">${esc(c.name)}</div><div><span class="pill ${PILL[c.status] || 'pill-absent'}">${esc(c.status)}</span></div><div class="det">${esc(c.detail)}</div></div>`).join('')}
  </div>
  <div class="foot"><div><span class="rule"></span>A <span class="serif">trusted</span> partner for your brand &middot; Est. 1997</div><div>1 / 2</div></div>
</section>`;

    const cards = m.cards || [];
    const cardHtml = cards.map(c => {
      const cat = CAT[c.category] || CAT.conversion;
      const [n, d] = String(c.big).split('/');
      const bigNum = d && /^\d+$/.test(n) && /^\d+$/.test(d)
        ? `<div class="big serif" style="font-size:58px">${esc(n)}<span style="font-size:28px;color:#6B7BA2">/${esc(d)}</span></div>`
        : big(c.big, [58, 52, 40, 30]);
      return `<div class="card"><div class="eyebrow" style="color:${cat.color}">${esc(cat.label)}</div>${bigNum}
        <div class="claim">${esc(c.claim)}</div><div class="det">${esc(c.detail)}</div>
        <div class="fix-wrap"><div class="fix"><b>What we’d do:</b> ${esc(c.fix)}</div></div></div>`;
    }).join('');

    const opp = m.opportunity && m.opportunity.rows && m.opportunity.rows.length ? m.opportunity : null;
    const maxHigh = opp ? Math.max(...opp.rows.map(r => Number(r.high) || 0), 1) : 1;
    const oppHtml = opp ? `<div class="opp"><div class="opp-hd"><div class="eyebrow">Opportunity, per month</div><div class="est">Estimates</div></div>
      ${opp.rows.map(r => {
        const lo = Number(r.low) || 0, hi = Number(r.high) || 0;
        const left = Math.max(0, Math.min(94, lo / maxHigh * 100)), width = Math.max(6, (hi - lo) / maxHigh * 100);
        return `<div class="bar"><div class="n">${esc(r.channel)}</div><div class="track"><div class="fill" style="left:${left}%;width:${Math.min(width, 100 - left)}%;background:${BAR_COLORS[r.channel] || '#C88A5E'}"></div></div><div class="v">${money(lo)}–${money(hi)}</div></div>`;
      }).join('')}</div>` : '';

    const calloutHtml = m.callout ? `<div class="callout"><div class="eyebrow">Competitor callout</div>
      <div class="t">${m.callout.amount ? `${esc(m.callout.name)} sells an estimated <span class="serif">${esc(money(m.callout.amount))} a month</span> on Amazon.` : esc(m.callout.title)}</div>
      ${m.callout.sub ? `<div class="s">${esc(m.callout.sub)}</div>` : ''}</div>` : '';

    const row2 = [calloutHtml, oppHtml].filter(Boolean);
    const steps = (m.steps || []).filter(Boolean);
    const partner = m.partnership || steps.length ? `<div class="partner" style="grid-template-columns:${m.partnership && steps.length ? '1.1fr 1fr' : '1fr'}">
      ${m.partnership ? `<div><div class="eyebrow">Recommended partnership</div>
        <div class="ln">${esc(m.partnership.line)} <span class="serif">${esc(m.partnership.italic)}</span></div>
        <div class="sb">${esc(m.partnership.sub)}</div></div>` : ''}
      ${steps.length ? `<div><div class="eyebrow steps-hd">Next steps</div><ol>${steps.map((s, i) => `<li><span class="serif">${i + 1}</span><span>${esc(s)}</span></li>`).join('')}</ol></div>` : ''}
    </div>` : '';

    const page2 = `
<section class="page">
  <div class="hd"><div class="logo">medalt<span>us.</span></div><div class="eyebrow">${esc(m.brandName)} &middot; Gap audit</div></div>
  <h2 class="p2">${NUMS[cards.length - 1] || 'Three'} thing${cards.length === 1 ? '' : 's'} <span class="serif">worth fixing.</span></h2>
  <div class="cards" style="grid-template-columns:repeat(${Math.max(cards.length, 1)},minmax(0,1fr))">${cardHtml}</div>
  ${row2.length ? `<div class="row2" style="grid-template-columns:${row2.length === 2 ? '1fr 1fr' : '1fr'}">${row2.join('')}</div>` : ''}
  ${partner}
  ${m.cta ? `<div class="cta"><div class="q">${esc(m.cta.text)}</div>${m.cta.url ? `<a href="${esc(m.cta.url)}">${esc(m.cta.button)}</a>` : `<a>${esc(m.cta.button)}</a>`}</div>` : ''}
  <div class="foot"><div>${esc(m.footnote || '')}</div><div>${esc(m.contactEmail || 'hello@medaltus.com')} &middot; 2 / 2</div></div>
</section>`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(m.brandName)} · Medaltus Gap Audit</title>
<style>${css(base)}</style></head><body>${page1}${page2}</body></html>`;
  }

  root.renderAuditHtml = renderAuditHtml;
})(typeof window !== 'undefined' ? window : globalThis);
