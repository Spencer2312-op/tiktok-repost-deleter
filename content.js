// content.js — runs on TikTok pages, navigates to the repost tab, and removes every repost.
// TikTok is a React SPA with dynamic class names. We use layered fallback strategies so that
// when one selector stops working, the others still catch it. Update SELECTORS first when
// TikTok makes a UI change.

// ---------- Timing constants ----------
const DELAY_MS     = 1500;   // pause between deletions (rate-limit safety)
const NAV_WAIT_MS  = 3000;   // pause after SPA navigation
const MENU_WAIT_MS = 1000;   // pause for context menu to render
const RETRY_LIMIT  = 3;      // attempts per card before skipping
const MAX_REPOSTS  = 500;    // safety cap

// ---------- Stable data-e2e attributes (try these first) ----------
const SELECTORS = {
  // Login indicators
  userAvatar: [
    '[data-e2e="nav-avatar"]',
    '[data-e2e="header-user-avatar"]',
    '[data-e2e="profile-icon"]',
    '[data-e2e="nav-upload"]',
    'header a[href^="/@"]',
  ],

  // Reposts tab link
  repostTab: [
    '[data-e2e="user-page-repost-tab"]',
    '[data-e2e="repost-tab"]',
    '[data-e2e="user-repost-tab"]',
  ],

  // Individual video cards (data-e2e only; see findVideoCards() for deeper fallbacks)
  videoCard: [
    '[data-e2e="user-post-item"]',
    '[data-e2e="repost-item"]',
    '[data-e2e="user-repost-item"]',
  ],

  // "..." more-options button on a card
  moreBtn: [
    '[data-e2e="video-card-more-btn"]',
    '[data-e2e="user-post-item-more"]',
    'button[aria-label*="more" i]',
    'button[aria-label*="option" i]',
  ],

  // Remove-repost menu item
  removeRepost: [
    '[data-e2e="remove-repost"]',
    '[data-e2e="unrepost"]',
  ],

  // Confirm dialog button
  confirm: [
    '[data-e2e="confirm-button"]',
  ],
};

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Send a message back to popup.js (fire-and-forget; popup may be closed)
function sendMsg(msg) {
  try { chrome.runtime.sendMessage(msg); } catch (_) {}
}

// Try each selector in an array; return the first matching element
function firstMatch(selectorList, root = document) {
  for (const sel of selectorList) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

// ---------- Login check ----------

function isLoggedIn() {
  return SELECTORS.userAvatar.some((s) => document.querySelector(s));
}

// ---------- Repost-tab helpers ----------

// Find the "Reposts" tab element using data-e2e attributes, then text, then href
function findRepostTab() {
  // 1. data-e2e attributes
  const byAttr = firstMatch(SELECTORS.repostTab);
  if (byAttr) return byAttr;

  // 2. Any <a> / [role=tab] whose visible text is exactly "Reposts"
  for (const el of document.querySelectorAll('a, [role="tab"], button')) {
    const text = el.textContent.trim().toLowerCase();
    if (text === 'reposts' || text === 'repost') return el;
  }

  // 3. href containing "/repost"
  return document.querySelector('a[href*="/repost"]');
}

// Decide whether we are already viewing the repost feed so we can skip tab-clicking
function isRepostTabActive() {
  const path = window.location.pathname + window.location.search + window.location.hash;
  if (path.toLowerCase().includes('repost')) return true;

  // Check if a "Reposts" tab has an active aria/class marker
  for (const el of document.querySelectorAll('a, [role="tab"]')) {
    const text = el.textContent.trim().toLowerCase();
    if ((text === 'reposts' || text === 'repost') &&
        (el.getAttribute('aria-selected') === 'true' ||
         el.classList.toString().toLowerCase().includes('active') ||
         el.classList.toString().toLowerCase().includes('current'))) {
      return true;
    }
  }
  return false;
}

// ---------- Video-card detection (multi-strategy) ----------

function findVideoCards() {
  // Strategy 1 — data-e2e attributes (fastest when present)
  for (const sel of SELECTORS.videoCard) {
    const items = [...document.querySelectorAll(sel)];
    if (items.length) return items;
  }

  // Strategy 2 — locate every <a href*="/video/"> and walk up to find its grid cell.
  // TikTok renders profile grids as rows of sibling divs, so the first ancestor
  // with multiple siblings is the card boundary.
  const videoLinks = [...document.querySelectorAll('a[href*="/video/"]')];
  if (videoLinks.length) {
    const cardSet = new Set();
    for (const link of videoLinks) {
      let el = link.parentElement;
      while (el && el !== document.body) {
        const parent = el.parentElement;
        if (parent && parent.childElementCount >= 2 && el.tagName === 'DIV') {
          cardSet.add(el);
          break;
        }
        el = parent;
      }
    }
    if (cardSet.size) return [...cardSet];
    // Last resort within this strategy: just use the links as "cards"
    return videoLinks;
  }

  // Strategy 3 — video thumbnail images (TikTok CDN URLs)
  const thumbs = [...document.querySelectorAll(
    'img[src*="tiktokcdn"], img[src*="p16-sign"], img[src*="p19-sign"]'
  )];
  if (thumbs.length) {
    const cardSet = new Set();
    for (const img of thumbs) {
      let el = img.parentElement;
      while (el && el !== document.body) {
        const parent = el.parentElement;
        if (parent && parent.childElementCount >= 2) {
          cardSet.add(el);
          break;
        }
        el = parent;
      }
    }
    if (cardSet.size) return [...cardSet];
  }

  return [];
}

// Poll until cards appear or we time out
async function waitForVideoCards(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cards = findVideoCards();
    if (cards.length) return cards;
    await sleep(500);
  }
  return [];
}

// ---------- More-button detection ----------

// After hovering a card, the "..." button animates in. Poll briefly for it.
async function findMoreButton(card) {
  const strategies = [
    // data-e2e on the card
    () => firstMatch(SELECTORS.moreBtn, card),
    // aria-label anywhere on the card
    () => card.querySelector('button[aria-label*="more" i], button[aria-label*="option" i]'),
    // Icon-only button (no text, contains an SVG) — TikTok's ellipsis buttons are usually these
    () => {
      for (const btn of card.querySelectorAll('button, [role="button"]')) {
        if (btn.querySelector('svg') && !btn.textContent.trim()) return btn;
      }
      return null;
    },
    // data-e2e anywhere in the document (some TikTok layouts render it outside the card)
    () => firstMatch(SELECTORS.moreBtn, document),
  ];

  for (let attempt = 0; attempt < 4; attempt++) {
    for (const fn of strategies) {
      const btn = fn();
      if (btn) return btn;
    }
    await sleep(250);
  }
  return null;
}

// ---------- "Remove repost" menu item ----------

function findRemoveRepostItem() {
  // data-e2e first
  const byAttr = firstMatch(SELECTORS.removeRepost, document);
  if (byAttr) return byAttr;

  // Scan every candidate menu element for recognisable text
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], li, ' +
    '[class*="menu" i] button, [class*="Menu" i] button, ' +
    '[class*="ActionSheet" i] button, [class*="BottomSheet" i] button, ' +
    '[class*="Sheet" i] button, [class*="Drawer" i] button'
  );
  const keywords = ['remove repost', 'unrepost', 'remove from reposts'];
  for (const el of candidates) {
    const text = el.textContent.trim().toLowerCase();
    if (keywords.some((k) => text.includes(k))) return el;
  }
  return null;
}

// ---------- Navigation ----------

async function navigateToReposts() {
  // Login check
  if (!isLoggedIn()) {
    await sleep(2000);
    if (!isLoggedIn()) {
      sendMsg({ type: 'notLoggedIn' });
      return false;
    }
  }

  // Already on the repost feed — nothing to navigate
  if (isRepostTabActive()) return true;

  // Not on a profile page — click the nav profile link first
  if (!window.location.pathname.startsWith('/@')) {
    const profileLink = document.querySelector(
      'a[href^="/@"][data-e2e="nav-profile"], header a[href^="/@"]'
    );
    if (profileLink) {
      profileLink.click();
      await sleep(NAV_WAIT_MS);
    }
  }

  // Find the Reposts tab (poll up to 6 s in case the profile is still loading)
  let repostTab = findRepostTab();
  const deadline = Date.now() + 6000;
  while (!repostTab && Date.now() < deadline) {
    await sleep(500);
    repostTab = findRepostTab();
  }

  if (!repostTab) {
    sendMsg({ type: 'none' });
    return false;
  }

  repostTab.click();
  await sleep(NAV_WAIT_MS);
  return true;
}

// ---------- Core deletion loop ----------

async function deleteAllReposts() {
  const navigated = await navigateToReposts();
  if (!navigated) return;

  // Wait for at least one card to appear before starting
  const initial = await waitForVideoCards(8000);
  if (!initial.length) {
    sendMsg({ type: 'none' });
    return;
  }

  let totalDeleted = 0;

  for (let i = 0; i < MAX_REPOSTS; i++) {
    const cards = findVideoCards();
    if (!cards.length) break;

    const card = cards[0];
    const estimatedTotal = cards.length + totalDeleted;
    sendMsg({ type: 'progress', current: totalDeleted + 1, total: estimatedTotal });

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
      // All retries failed for this card — stop to avoid looping forever
      break;
    }
  }

  sendMsg(totalDeleted > 0
    ? { type: 'done', count: totalDeleted }
    : { type: 'none' });
}

// Attempt to delete a single repost card via the UI context menu
async function deleteOneRepost(card) {
  // Scroll into view so TikTok renders the hover overlay
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  await sleep(300);

  // Fire hover events to reveal the hidden "..." button
  for (const evt of ['mouseenter', 'mouseover', 'pointermove']) {
    card.dispatchEvent(new MouseEvent(evt, { bubbles: true }));
  }
  await sleep(400);

  // Locate and click the more-options button
  const moreBtn = await findMoreButton(card);
  if (!moreBtn) return false;

  moreBtn.click();
  await sleep(MENU_WAIT_MS);

  // Find "Remove repost" / "Unrepost" in the context menu
  const removeItem = findRemoveRepostItem();
  if (!removeItem) {
    // Close any stray menu and bail
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(300);
    return false;
  }

  removeItem.click();
  await sleep(MENU_WAIT_MS);

  // Handle optional confirmation dialog (TikTok sometimes shows one)
  const confirmBtn = firstMatch(SELECTORS.confirm, document);
  if (confirmBtn) {
    confirmBtn.click();
    await sleep(MENU_WAIT_MS);
  }

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
