// content.js — TikTok Repost Deleter
// TikTok hides card overlay buttons via CSS :hover. JS mouse events do NOT trigger CSS
// pseudo-classes, so we force-reveal buttons via inline styles before interacting.

const DELAY_MS     = 1500;
const NAV_WAIT_MS  = 3000;
const MENU_WAIT_MS = 1200;
const RETRY_LIMIT  = 3;
const MAX_REPOSTS  = 500;

// Stable data-e2e selectors — update these if TikTok changes their markup
const SELECTORS = {
  userAvatar: [
    '[data-e2e="nav-avatar"]',
    '[data-e2e="header-user-avatar"]',
    '[data-e2e="profile-icon"]',
    '[data-e2e="nav-upload"]',
    'header a[href^="/@"]',
  ],
  repostTab: [
    '[data-e2e="user-page-repost-tab"]',
    '[data-e2e="repost-tab"]',
    '[data-e2e="user-repost-tab"]',
  ],
  videoCard: [
    '[data-e2e="user-post-item"]',
    '[data-e2e="repost-item"]',
    '[data-e2e="user-repost-item"]',
  ],
  moreBtn: [
    '[data-e2e="video-card-more-btn"]',
    '[data-e2e="user-post-item-more"]',
    'button[aria-label*="more" i]',
    'button[aria-label*="option" i]',
  ],
  removeRepost: [
    '[data-e2e="remove-repost"]',
    '[data-e2e="unrepost"]',
  ],
  confirm: [
    '[data-e2e="confirm-button"]',
  ],
};

// ---------- Helpers ----------

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function sendMsg(msg) { try { chrome.runtime.sendMessage(msg); } catch (_) {} }

function firstMatch(list, root = document) {
  for (const sel of list) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// ---------- Login ----------

function isLoggedIn() {
  return SELECTORS.userAvatar.some((s) => document.querySelector(s));
}

// ---------- Repost tab ----------

function findRepostTab() {
  const byAttr = firstMatch(SELECTORS.repostTab);
  if (byAttr) return byAttr;
  for (const el of document.querySelectorAll('a, [role="tab"], button')) {
    const t = el.textContent.trim().toLowerCase();
    if (t === 'reposts' || t === 'repost') return el;
  }
  return document.querySelector('a[href*="/repost"]');
}

function isRepostTabActive() {
  const loc = window.location.pathname + window.location.search + window.location.hash;
  if (loc.toLowerCase().includes('repost')) return true;
  for (const el of document.querySelectorAll('a, [role="tab"]')) {
    const t = el.textContent.trim().toLowerCase();
    if ((t === 'reposts' || t === 'repost') &&
        (el.getAttribute('aria-selected') === 'true' ||
         el.classList.toString().toLowerCase().includes('active') ||
         el.classList.toString().toLowerCase().includes('current'))) return true;
  }
  return false;
}

// ---------- Video card detection ----------

function findVideoCards() {
  // Strategy 1: data-e2e
  for (const sel of SELECTORS.videoCard) {
    const items = [...document.querySelectorAll(sel)];
    if (items.length) return items;
  }

  // Strategy 2: containers of video links
  const links = [...document.querySelectorAll('a[href*="/video/"]')];
  if (links.length) {
    const set = new Set();
    for (const a of links) {
      let el = a.parentElement;
      while (el && el !== document.body) {
        const p = el.parentElement;
        if (p && p.childElementCount >= 2 && el.tagName === 'DIV') { set.add(el); break; }
        el = p;
      }
    }
    if (set.size) return [...set];
    return links; // fallback: use the links themselves as handles
  }

  // Strategy 3: CDN thumbnail images
  const imgs = [...document.querySelectorAll(
    'img[src*="tiktokcdn"], img[src*="p16-sign"], img[src*="p19-sign"]'
  )];
  if (imgs.length) {
    const set = new Set();
    for (const img of imgs) {
      let el = img.parentElement;
      while (el && el !== document.body) {
        const p = el.parentElement;
        if (p && p.childElementCount >= 2) { set.add(el); break; }
        el = p;
      }
    }
    if (set.size) return [...set];
  }

  return [];
}

async function waitForVideoCards(ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const c = findVideoCards();
    if (c.length) return c;
    await sleep(500);
  }
  return [];
}

// ---------- Force card overlay visible ----------
// TikTok hides the "..." button in a CSS-opacity overlay. JS mouseenter events do NOT
// trigger CSS :hover, so the button stays invisible. We override inline styles to reveal it.

function revealCardOverlay(card) {
  // Reveal overlay / mask wrapper elements
  const overlaySelectors = [
    '[class*="overlay" i]', '[class*="mask" i]', '[class*="Overlay"]',
    '[class*="Mask"]', '[class*="Cover"]', '[class*="cover" i]',
    '[class*="action" i]', '[class*="Action"]',
  ];
  for (const sel of overlaySelectors) {
    for (const el of card.querySelectorAll(sel)) {
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('visibility', 'visible', 'important');
    }
  }
  // Reveal every button inside the card
  for (const btn of card.querySelectorAll('button, [role="button"], a')) {
    btn.style.setProperty('opacity', '1', 'important');
    btn.style.setProperty('visibility', 'visible', 'important');
    btn.style.setProperty('pointer-events', 'auto', 'important');
    btn.style.setProperty('display', btn.style.display === 'none' ? 'block' : btn.style.display, 'important');
  }
}

// ---------- More button ----------

async function findMoreButton(card) {
  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  for (let attempt = 0; attempt < 4; attempt++) {
    // Fire realistic pointer events on each attempt
    const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
    card.dispatchEvent(new PointerEvent('pointerover', opts));
    card.dispatchEvent(new MouseEvent('mouseenter', opts));
    card.dispatchEvent(new MouseEvent('mousemove', opts));
    card.dispatchEvent(new MouseEvent('mouseover', opts));
    await sleep(300);

    // Force all overlay elements and buttons to be visible
    revealCardOverlay(card);
    await sleep(200);

    // 1. data-e2e attributes
    let btn = firstMatch(SELECTORS.moreBtn, card);
    if (btn) return btn;

    // 2. aria-label anywhere in card
    btn = card.querySelector('button[aria-label*="more" i], button[aria-label*="option" i]');
    if (btn) return btn;

    // 3. Icon-only buttons (SVG, no visible text) — TikTok ellipsis buttons are usually these
    for (const b of card.querySelectorAll('button, [role="button"]')) {
      if (b.querySelector('svg') && b.textContent.trim() === '') return b;
    }

    // 4. Look for buttons near the top-right corner of the card (where "..." typically lives)
    const allBtns = [...card.querySelectorAll('button, [role="button"]')];
    for (const b of allBtns) {
      const br = b.getBoundingClientRect();
      if (br.right > rect.right - rect.width * 0.3 &&
          br.top < rect.top + rect.height * 0.4) {
        return b;
      }
    }

    // 5. Document-level fallback
    btn = firstMatch(SELECTORS.moreBtn, document);
    if (btn) return btn;
  }
  return null;
}

// ---------- Remove-repost menu item ----------

function findRemoveRepostItem() {
  const byAttr = firstMatch(SELECTORS.removeRepost, document);
  if (byAttr) return byAttr;

  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], li, ' +
    '[class*="menu" i] button, [class*="Menu"] button, ' +
    '[class*="ActionSheet" i] button, [class*="BottomSheet" i] button, ' +
    '[class*="Sheet"] button, [class*="Drawer"] button, ' +
    '[class*="list" i] li, [class*="List"] li'
  );
  const keywords = ['remove repost', 'unrepost', 'remove from reposts', 'undo repost'];
  for (const el of candidates) {
    const t = el.textContent.trim().toLowerCase();
    if (keywords.some((k) => t.includes(k))) return el;
  }
  return null;
}

// ---------- Navigation ----------

async function navigateToReposts() {
  if (!isLoggedIn()) {
    await sleep(2000);
    if (!isLoggedIn()) { sendMsg({ type: 'notLoggedIn' }); return false; }
  }

  if (isRepostTabActive()) return true;

  if (!window.location.pathname.startsWith('/@')) {
    const profileLink = document.querySelector(
      'a[href^="/@"][data-e2e="nav-profile"], header a[href^="/@"]'
    );
    if (profileLink) { profileLink.click(); await sleep(NAV_WAIT_MS); }
  }

  let tab = findRepostTab();
  const deadline = Date.now() + 6000;
  while (!tab && Date.now() < deadline) { await sleep(500); tab = findRepostTab(); }

  if (!tab) { sendMsg({ type: 'none' }); return false; }

  tab.click();
  await sleep(NAV_WAIT_MS);
  return true;
}

// ---------- Core loop ----------

async function deleteAllReposts() {
  const navigated = await navigateToReposts();
  if (!navigated) return;

  const initial = await waitForVideoCards(8000);
  if (!initial.length) { sendMsg({ type: 'none' }); return; }

  let totalDeleted = 0;

  for (let i = 0; i < MAX_REPOSTS; i++) {
    const cards = findVideoCards();
    if (!cards.length) break;

    const card = cards[0];
    sendMsg({ type: 'progress', current: totalDeleted + 1, total: cards.length + totalDeleted });

    let success = false;
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      success = await deleteOneRepost(card);
      if (success) break;
      await sleep(DELAY_MS);
    }

    if (success) {
      totalDeleted++;
      await sleep(DELAY_MS);
    } else {
      // All retries failed — report what we know and stop
      sendMsg({ type: 'error', message: `Stopped after ${totalDeleted} deletion(s). TikTok may have changed their menu UI — open DevTools on the repost grid and check what the "..." button looks like, then update SELECTORS in content.js.` });
      return;
    }
  }

  sendMsg(totalDeleted > 0 ? { type: 'done', count: totalDeleted } : { type: 'none' });
}

async function deleteOneRepost(card) {
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(400);

  // Reveal hidden overlay buttons before searching
  revealCardOverlay(card);
  await sleep(200);

  const moreBtn = await findMoreButton(card);
  if (!moreBtn) return false;

  moreBtn.click();
  await sleep(MENU_WAIT_MS);

  const removeItem = findRemoveRepostItem();
  if (!removeItem) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    return false;
  }

  removeItem.click();
  await sleep(MENU_WAIT_MS);

  const confirmBtn = firstMatch(SELECTORS.confirm, document);
  if (confirmBtn) { confirmBtn.click(); await sleep(MENU_WAIT_MS); }

  return true;
}

// ---------- Message listener ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'deleteReposts') {
    deleteAllReposts().catch((err) => {
      sendMsg({ type: 'error', message: 'Unexpected error: ' + err.message });
    });
  }
});
