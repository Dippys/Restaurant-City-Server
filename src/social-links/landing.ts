import type { PublicSocialLink } from './service';

function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

export function renderSocialLanding(link: PublicSocialLink, canonicalOrigin: string, csrfToken = ''): string {
  const url = `${canonicalOrigin}/s/${encodeURIComponent(link.slug)}`;
  const image = `${canonicalOrigin}${link.imagePath}`;
  const actionable = link.availability === 'available' && link.loggedIn;
  const login = `/login?next=${encodeURIComponent(`/s/${link.slug}`)}`;
  const signup = `/signup?next=${encodeURIComponent(`/s/${link.slug}`)}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(link.title)} — Restaurant City Reborn</title>
<meta name="description" content="${esc(link.description)}">
<meta property="og:type" content="website"><meta property="og:site_name" content="Restaurant City Reborn">
<meta property="og:title" content="${esc(link.title)}"><meta property="og:description" content="${esc(link.description)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image"><link rel="canonical" href="${esc(url)}"><link rel="stylesheet" href="/theme.css">
<style>.social-wrap{max-width:680px;margin:0 auto;padding:44px 20px}.social-card{text-align:center}.social-art{width:min(260px,75vw);max-height:220px;object-fit:contain}.social-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:22px}.social-status{text-transform:capitalize;font-weight:800;color:var(--ink-soft)}.social-result{min-height:24px;margin-top:16px}</style></head>
<body><main class="social-wrap"><section class="rc-panel social-card"><a href="/" style="display:inline-block;text-decoration:none;color:var(--ink);font-size:clamp(25px,6vw,38px);font-weight:900;line-height:1.1">Restaurant City Reborn</a>
<img class="social-art" src="${esc(link.imagePath)}" alt=""><p class="social-status">${esc(link.availability)}</p><h1>${esc(link.title)}</h1><p>${esc(link.description)}</p>
${link.creatorName ? `<p>Shared by ${esc(link.creatorName)}</p>` : ''}<div class="social-actions">
<button class="rc-btn ghost" id="copy" type="button">Copy Link</button><button class="rc-btn ghost hidden" id="share" type="button">Share</button>
${actionable ? `<button class="rc-btn green" id="action" type="button">${esc(link.actionLabel)}</button>` : !link.loggedIn && link.availability === 'available' ? `<a class="rc-btn green" href="${esc(login)}">Log in to continue</a><a class="rc-btn gold" href="${esc(signup)}">Create account</a>` : ''}
${link.completedForViewer || link.playUrl ? `<a class="rc-btn" href="${esc(link.playUrl ?? '/game')}">Play</a>` : ''}</div><div class="social-result" id="result" aria-live="polite"></div></section></main>
<script>const url=${JSON.stringify(url)},csrf=${JSON.stringify(csrfToken)},slug=${JSON.stringify(link.slug)},action=${JSON.stringify(link.action)};
const result=document.querySelector('#result');document.querySelector('#copy').onclick=async()=>{try{await navigator.clipboard.writeText(url);result.textContent='Link copied.'}catch{prompt('Copy this link:',url)}};
if(navigator.share){const b=document.querySelector('#share');b.classList.remove('hidden');b.onclick=()=>navigator.share({title:${JSON.stringify(link.title)},text:${JSON.stringify(link.description)},url}).catch(()=>{})}
const actionButton=document.querySelector('#action');if(actionButton)actionButton.onclick=async()=>{actionButton.disabled=true;result.textContent='Working…';try{const r=await fetch('/__api/social-links/'+encodeURIComponent(slug)+'/actions',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({action})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.message||d.error||'Action failed');result.textContent=d.message;if(d.playUrl){const a=document.createElement('a');a.className='rc-btn';a.href=d.playUrl;a.textContent='Open game';document.querySelector('.social-actions').append(a)}}catch(e){result.textContent=e.message||String(e);actionButton.disabled=false}};</script></body></html>`;
}
