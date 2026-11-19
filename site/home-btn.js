// Dealer pages also shrink photos before upload (see upload-compress.js).
if (/admin|appraisal/.test(location.pathname) && !document.querySelector('script[src="/upload-compress.js"]')) {
  const s = document.createElement('script'); s.src = '/upload-compress.js'; document.head.appendChild(s);
}
(function () {
  'use strict';
  if (document.getElementById('as360Home')) return;
  const isAdmin = /admin/.test(location.pathname);
  const fromAdmin = /[/]admin/.test(document.referrer || '');
  const target = isAdmin || fromAdmin ? '/admin.html' : '/';

  const css = document.createElement('style');
  css.textContent = `
.home-fab{position:fixed;z-index:150;left:max(14px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));
  display:flex;align-items:center;gap:8px;min-height:46px;padding:0 18px 0 14px;border-radius:999px;
  border:1px solid rgba(255,255,255,.12);background:rgba(16,18,22,.78);color:#f4f2ee;font:600 14px var(--font-body,system-ui),-apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.01em;
  text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,.5),0 1px 0 rgba(255,255,255,.06) inset;-webkit-backdrop-filter:saturate(1.4) blur(16px);backdrop-filter:saturate(1.4) blur(16px);
  -webkit-tap-highlight-color:transparent;touch-action:manipulation;cursor:pointer;transition:transform .18s,border-color .2s,background .2s}
.home-fab:hover{border-color:rgba(255,255,255,.28);background:rgba(28,31,36,.9)}
.home-fab svg{width:19px;height:19px;flex:none;color:var(--accent,#f2b705)}
.home-fab:active{transform:scale(.96)}
body:has(.gc-overlay) .home-fab{display:none}
@media (max-width:720px){.home-fab{width:50px;min-height:50px;padding:0;justify-content:center;opacity:.92}.home-fab span{display:none}}
.overlay{padding-bottom:calc(84px + env(safe-area-inset-bottom))!important}
.wrap{padding-bottom:calc(84px + env(safe-area-inset-bottom))}`;
  document.head.appendChild(css);

  const a = document.createElement('a');
  a.id = 'as360Home'; a.className = 'home-fab'; a.href = target;
  a.setAttribute('aria-label', 'Back to the home screen');
  a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg><span>Home</span>';
  a.addEventListener('click', e => {
    if (!isAdmin) return;                       // normal link everywhere else
    // dealer admin: close any open window and show the vehicle list again
    const open = document.querySelectorAll('.overlay');
    if (!open.length && /admin[.]html$|admin$|admin[/]$/.test(location.pathname) && !location.search && !location.hash) {
      e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); return;
    }
    if (open.length) {
      e.preventDefault();
      open.forEach(o => o.remove());
      document.documentElement.style.overflow = '';
      window.scrollTo(0, 0);
      if (typeof window.loadList === 'function') { try { window.loadList(); } catch (err) {} }
    }
  });
  const add = () => document.body.appendChild(a);
  if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
})();
