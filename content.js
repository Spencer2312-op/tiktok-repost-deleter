// content.js — TikTok Repost Deleter v4
//
// KEY INSIGHT: On TikTok web, "Remove repost" lives inside the SHARE button sheet,
// not the "..." more menu. We try share first, then fall back to every other button.
//
// Guard prevents duplicate listener registration when the script is injected more than once.

if (window.__trdListenerRegistered) {
  // Already set up — do nothing to avoid duplicate handlers
} else {
  window.__trdListenerRegistered = true;

  // ── Constants ────────────────────────────────────────────────────────────────

  const DELAY_MS     = 800;
  const NAV_WAIT_MS  = 3500;
  const MENU_WAIT_MS = 1500;
  const RETRY_LIMIT  = 3;
  const MAX_REPOSTS  = 500;

  // data-e2e attributes — update these first when TikTok changes their markup
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
    // Share button — "Remove repost" is in the share sheet on TikTok web
    shareBtn: [
      '[data-e2e="browse-video-share"]',
      '[data-e2e="share-button"]',
      '[data-e2e="video-share"]',
      'button[aria-label*="share" i]',
    ],
    // "..." more button — secondary option
    moreBtn: [
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

  // ── Helpers ───────────────────────────────────────────────────────────────────

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sendMsg(msg) { try { chrome.runtime.sendMessage(msg); } catch (_) {} }

  function firstMatch(list, root = document) {
    for (const sel of list) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Scan every text node in the document for repost-related menu items.
  // TreeWalker reaches text inside any container regardless of class or structure.
  function findRemoveRepostItem() {
    const byAttr = firstMatch(SELECTORS.removeRepost);
    if (byAttr) return byAttr;

    const keywords = [
      'remove repost', 'unrepost', 'remove from reposts',
      'undo repost', 'delete repost',
    ];

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim().toLowerCase();
      if (text.length < 60 && keywords.some((k) => text.includes(k))) {
        // Walk up to the nearest interactive element
        let el = node.parentElement;
        while (el && el !== document.body) {
          const tag = el.tagName;
          const role = el.getAttribute('role');
          if (tag === 'BUTTON' || tag === 'A' || tag === 'LI' ||
              role === 'menuitem' || role === 'button' || role === 'option') {
            return el;
          }
          el = el.parentElement;
        }
        return node.parentElement;
      }
    }
    return null;
  }

  // ── Login ─────────────────────────────────────────────────────────────────────

  function isLoggedIn() {
    return SELECTORS.userAvatar.some((s) => document.querySelector(s));
  }

  // ── Repost tab ────────────────────────────────────────────────────────────────

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

  // ── Video card detection ──────────────────────────────────────────────────────

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

  // ── Video page detection ──────────────────────────────────────────────────────

  async function waitForVideoPage(ms = 7000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (window.location.pathname.includes('/video/')) {
        const ready = document.querySelector(
          '[data-e2e="browse-video-share"], [data-e2e="browse-video-more"], ' +
          '[data-e2e="browse-video-desc"], video, [class*="DivVideoWrapper"]'
        );
        if (ready) return true;
      }
      await sleep(300);
    }
    return false;
  }

  // ── Remove repost from the video page ────────────────────────────────────────
  //
  // Tries buttons in this priority order:
  //   1. Share button  — "Remove repost" is in the share sheet on TikTok web
  //   2. More/ellipsis button
  //   3. Every other visible SVG icon button (brute force)

  async function tryButton(btn) {
    if (!btn) return false;
    btn.click();
    await sleep(MENU_WAIT_MS);
    const item = findRemoveRepostItem();
    if (item) {
      item.click();
      await sleep(MENU_WAIT_MS);
      const confirmBtn = firstMatch(SELECTORS.confirm);
      if (confirmBtn) { confirmBtn.click(); await sleep(MENU_WAIT_MS); }
      return true;
    }
    // No match — close whatever opened and move on
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(500);
    return false;
  }

  async function removeRepostFromVideoPage() {
    await sleep(1000); // let the page fully render

    // 1. Share button (primary — TikTok web puts "Remove repost" here)
    if (await tryButton(firstMatch(SELECTORS.shareBtn))) return true;

    // 2. More/ellipsis button
    if (await tryButton(firstMatch(SELECTORS.moreBtn))) return true;

    // 3. Brute force: every visible button that contains an SVG icon
    const iconBtns = [...document.querySelectorAll('button, [role="button"]')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 10 && r.height > 10 && b.querySelector('svg');
    });

    for (const btn of iconBtns) {
      if (await tryButton(btn)) return true;
    }

    return false;
  }

  // ── Navigation ────────────────────────────────────────────────────────────────

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

  // ── Count reposts ─────────────────────────────────────────────────────────────

  async function countReposts() {
    if (!isLoggedIn()) {
      await sleep(1500);
      if (!isLoggedIn()) { sendMsg({ type: 'notLoggedIn' }); return; }
    }
    if (!isRepostTabActive()) {
      const ok = await navigateToReposts();
      if (!ok) { sendMsg({ type: 'count', count: 0 }); return; }
    }
    const cards = await waitForVideoCards(6000);
    sendMsg({ type: 'count', count: cards.length });
  }

  // ── Core deletion loop ────────────────────────────────────────────────────────

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

      const videoLink = getVideoLink(card);
      if (!videoLink) {
        sendMsg({ type: 'error', message: 'Could not find video link on card.' });
        return;
      }

      // SPA-navigate to the video page
      videoLink.click();
      const loaded = await waitForVideoPage(7000);
      if (!loaded) {
        history.back();
        await sleep(NAV_WAIT_MS);
        continue;
      }
      await sleep(600);

      // Remove the repost
      let success = false;
      for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
        success = await removeRepostFromVideoPage();
        if (success) break;
        await sleep(1200);
      }

      // Return to the repost grid
      history.back();
      await sleep(NAV_WAIT_MS);

      // Re-click Reposts tab to force a fresh list (bypasses bfcache)
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
            `"Remove repost" was not found in any button menu on the video page. ` +
            `Open a TikTok video, click the Share button, and check if "Remove repost" appears there.`,
        });
        return;
      }
    }

    sendMsg(totalDeleted > 0 ? { type: 'done', count: totalDeleted } : { type: 'none' });
  }

  // ── Message listener ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'deleteReposts') {
      deleteAllReposts().catch((err) => sendMsg({ type: 'error', message: err.message }));
    } else if (msg.action === 'countReposts') {
      countReposts().catch((err) => sendMsg({ type: 'error', message: err.message }));
    }
  });

} // end if (!window.__trdListenerRegistered)
