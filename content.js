// content.js — TikTok Repost Deleter v3
// Strategy: SPA-navigate to each video page and remove the repost there.
// Video page action buttons are always visible (no CSS hover hiding), which makes
// this far more reliable than trying to click the hidden grid overlay button.

const DELAY_MS     = 800;    // pause between deletions
const NAV_WAIT_MS  = 3500;   // wait for SPA navigation to settle
const MENU_WAIT_MS = 1200;   // wait for context menu to render
const RETRY_LIMIT  = 3;
const MAX_REPOSTS  = 500;

// Stable data-e2e selectors — these are the first thing to update when TikTok
// changes their markup. Everything else falls back to text / structural heuristics.
const SELECTORS = {
  userAvatar: [
    '[data-e2e="nav-avatar"]',
    '[data-e2e="header-user-avatar"]',
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
  // "..." button on the VIDEO PAGE (always visible — not hover-gated)
  videoPageMore: [
    '[data-e2e="browse-video-more"]',
    '[data-e2e="video-more-btn"]',
    '[data-e2e="video-more"]',
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

// ---------- Video card / link detection ----------

function findVideoCards() {
  for (const sel of SELECTORS.videoCard) {
    const items = [...document.querySelectorAll(sel)];
    if (items.length) return items;
  }
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
    return links;
  }
  return [];
}

// Get a video page URL from a card element
function getVideoLink(card) {
  if (card.tagName === 'A' && card.href && card.href.includes('/video/')) return card;
  return card.querySelector('a[href*="/video/"]');
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

// ---------- Video page detection ----------

// Returns true once we are on a video page and the page has settled
async function waitForVideoPage(ms = 7000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (window.location.pathname.includes('/video/')) {
      const ready = document.querySelector(
        '[data-e2e="browse-video-more"], [data-e2e="browse-video-desc"], ' +
        '[data-e2e="video-play"], video, [class*="DivVideoWrapper"]'
      );
      if (ready) return true;
    }
    await sleep(300);
  }
  return false;
}

// ---------- Remove repost from video page ----------

// Scan for the "Remove repost" text in any currently open menu / sheet
function findRemoveRepostItem() {
  const byAttr = firstMatch(SELECTORS.removeRepost, document);
  if (byAttr) return byAttr;
  const candidates = document.querySelectorAll(
    '[role="menuitem"], [role="option"], li, ' +
    '[class*="menu" i] button, [class*="Menu"] button, ' +
    '[class*="sheet" i] button, [class*="Sheet"] button, ' +
    '[class*="drawer" i] button, [class*="Drawer"] button, ' +
    '[class*="action" i] li, [class*="list" i] li'
  );
  const keywords = ['remove repost', 'unrepost', 'remove from reposts', 'undo repost'];
  for (const el of candidates) {
    const t = el.textContent.trim().toLowerCase();
    if (keywords.some((k) => t.includes(k))) return el;
  }
  return null;
}

async function findVideoPageMoreButton() {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    // 1. Named data-e2e selectors
    const byAttr = firstMatch(SELECTORS.videoPageMore);
    if (byAttr) return byAttr;

    // 2. Icon-only buttons in the right-side action panel
    const actionPanel = document.querySelector(
      '[data-e2e="browse-video-action-bar"], [class*="DivActionBar"], ' +
      '[class*="action-bar" i], [class*="ActionBar"]'
    );
    const searchRoot = actionPanel || document;
    for (const btn of searchRoot.querySelectorAll('button, [role="button"]')) {
      if (btn.querySelector('svg') && !btn.textContent.trim()) return btn;
    }

    // 3. Look for a button whose accessible name or title hints at "more"
    for (const btn of document.querySelectorAll('button, [role="button"]')) {
      const label = (btn.getAttribute('aria-label') || btn.title || '').toLowerCase();
      if (label.includes('more') || label.includes('option')) return btn;
    }

    await sleep(400);
  }
  return null;
}

async function removeRepostFromVideoPage() {
  const moreBtn = await findVideoPageMoreButton();
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

// ---------- Core deletion loop ----------

async function deleteAllReposts() {
  const navigated = await navigateToReposts();
  if (!navigated) return;

  const initial = await waitForVideoCards(8000);
  if (!initial.length) { sendMsg({ type: 'none' }); return; }

  let totalDeleted = 0;

  for (let i = 0; i < MAX_REPOSTS; i++) {
    // Always re-query after returning from the video page
    const cards = findVideoCards();
    if (!cards.length) break;

    const card = cards[0];
    const estimatedTotal = cards.length + totalDeleted;
    sendMsg({ type: 'progress', current: totalDeleted + 1, total: estimatedTotal });

    // Get the clickable <a> link from the card
    const videoLink = getVideoLink(card);
    if (!videoLink) {
      sendMsg({ type: 'error', message: 'Could not find a video link on the repost card. TikTok may have changed their layout.' });
      return;
    }

    // --- SPA navigate to the video page ---
    videoLink.click();
    const loaded = await waitForVideoPage(7000);
    if (!loaded) {
      // Bail back to the repost list and skip this one
      history.back();
      await sleep(NAV_WAIT_MS);
      continue;
    }
    await sleep(600); // let the page fully settle

    // --- Remove the repost from the video page ---
    let success = false;
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      success = await removeRepostFromVideoPage();
      if (success) break;
      await sleep(1200);
    }

    // --- Navigate back to the repost grid ---
    history.back();
    await sleep(NAV_WAIT_MS);

    // Re-click the Reposts tab so TikTok fetches the updated list
    // (without this, bfcache may restore the old grid with the deleted item still showing)
    const tab = findRepostTab();
    if (tab) { tab.click(); await sleep(NAV_WAIT_MS); }

    await waitForVideoCards(5000);

    if (success) {
      totalDeleted++;
      await sleep(DELAY_MS);
    } else {
      sendMsg({
        type: 'error',
        message: `Stopped after ${totalDeleted} deletion(s). ` +
          `The "Remove repost" option was not found on the video page — ` +
          `TikTok may have renamed it. Open DevTools on a TikTok video page, ` +
          `click the "..." button, and check what the menu item is called.`
      });
      return;
    }
  }

  sendMsg(totalDeleted > 0 ? { type: 'done', count: totalDeleted } : { type: 'none' });
}

// ---------- Count reposts ----------

async function countReposts() {
  if (!isLoggedIn()) {
    await sleep(1500);
    if (!isLoggedIn()) { sendMsg({ type: 'notLoggedIn' }); return; }
  }

  // Navigate to the repost tab if not already there
  if (!isRepostTabActive()) {
    const navigated = await navigateToReposts();
    if (!navigated) { sendMsg({ type: 'count', count: 0 }); return; }
  }

  // Wait for the grid to populate, then count
  const cards = await waitForVideoCards(6000);
  sendMsg({ type: 'count', count: cards.length });
}

// ---------- Message listener ----------

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'deleteReposts') {
    deleteAllReposts().catch((err) => {
      sendMsg({ type: 'error', message: 'Unexpected error: ' + err.message });
    });
  } else if (msg.action === 'countReposts') {
    countReposts().catch((err) => {
      sendMsg({ type: 'error', message: 'Count error: ' + err.message });
    });
  }
});
