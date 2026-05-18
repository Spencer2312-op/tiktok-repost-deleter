// content.js — runs on TikTok pages, navigates to the repost tab, and removes every repost.
// TikTok is a React/Next.js SPA, so we rely on DOM queries and MutationObserver rather than
// page-reload navigation. Update selector constants below when TikTok redesigns their UI.

// ---------- Configurable constants ----------
const DELAY_MS = 1500;          // wait between deletions to avoid rate limiting
const NAV_WAIT_MS = 2500;       // wait after navigating to a new page/tab
const MENU_WAIT_MS = 800;       // wait for context menu to appear
const RETRY_LIMIT = 3;          // retries per repost before giving up
const MAX_REPOSTS = 500;        // safety cap to prevent infinite loops

// TikTok CSS selectors — update these if TikTok changes their markup
const SELECTORS = {
  // The username shown in the top nav / avatar area (indicates login state)
  userAvatar: '[data-e2e="nav-avatar"], [data-e2e="header-user-avatar"], .user-avatar',

  // "Reposts" tab on the profile page
  repostTab: '[data-e2e="user-page-repost-tab"], [data-e2e="repost-tab"]',

  // Individual video cards in the repost list
  videoCard: '[data-e2e="user-post-item"], [data-e2e="repost-item"]',

  // The "..." (more) button on each video card
  moreBtn: '[data-e2e="user-post-item-more"], .video-card-big-container .tiktok-ellipsis, [class*="DivMoreBtn"], button[aria-label="More options"]',

  // The "Remove repost" menu item inside the context menu
  removeRepostItem: '[data-e2e="remove-repost"], [class*="remove-repost"]',

  // Confirm button in the confirmation dialog (if any)
  confirmBtn: '[data-e2e="confirm-button"], [class*="ConfirmBtn"], button.confirm',
};

// ---------- Helpers ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Try multiple selectors until one returns a result
function queryAny(selectors, root = document) {
  for (const sel of selectors.split(",").map((s) => s.trim())) {
    const el = root.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function queryAll(selectors, root = document) {
  const results = [];
  for (const sel of selectors.split(",").map((s) => s.trim())) {
    results.push(...root.querySelectorAll(sel));
  }
  // deduplicate
  return [...new Set(results)];
}

// Wait for an element matching `selector` to appear in the DOM
function waitForElement(selector, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const existing = queryAny(selector);
    if (existing) return resolve(existing);

    const observer = new MutationObserver(() => {
      const el = queryAny(selector);
      if (el) {
        observer.disconnect();
        resolve(el);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      resolve(null); // timed out
    }, timeoutMs);
  });
}

// Send a message back to popup.js (best-effort; popup may be closed)
function sendMsg(msg) {
  try {
    chrome.runtime.sendMessage(msg);
  } catch (_) {}
}

// ---------- Navigation ----------

// Navigate to the logged-in user profile and click the Reposts tab
async function navigateToReposts() {
  // Check login by looking for avatar element
  const avatar = queryAny(SELECTORS.userAvatar);
  if (!avatar) {
    // Try waiting briefly in case page is still loading
    await sleep(2000);
    if (!queryAny(SELECTORS.userAvatar)) {
      sendMsg({ type: "notLoggedIn" });
      return false;
    }
  }

  // Derive the profile URL from the current username in the URL or from the
  // avatar href. Fallback: navigate to /@me which TikTok redirects properly.
  let profileUrl = null;

  // If we are already on a profile page, stay here
  if (window.location.pathname.startsWith("/@")) {
    profileUrl = window.location.pathname;
  } else {
    // Try to find a link to the user profile in the nav
    const profileLink = document.querySelector(
      'a[href^="/@"][data-e2e="nav-profile"], a[href^="/@"].avatar-anchor, header a[href^="/@"]'
    );
    if (profileLink) {
      profileUrl = profileLink.getAttribute("href");
    }
  }

  if (profileUrl && !window.location.pathname.startsWith(profileUrl.split("?")[0])) {
    // Navigate to profile using SPA router if possible, else hard navigate
    window.location.href = profileUrl;
    await sleep(NAV_WAIT_MS);
  }

  // Wait for the Reposts tab to appear
  const repostTab = await waitForElement(SELECTORS.repostTab, 8000);
  if (!repostTab) {
    // The user may have no reposts tab at all (account has never reposted)
    sendMsg({ type: "none" });
    return false;
  }

  // Click the Reposts tab
  repostTab.click();
  await sleep(NAV_WAIT_MS);
  return true;
}

// ---------- Core deletion loop ----------

async function deleteAllReposts() {
  const navigated = await navigateToReposts();
  if (!navigated) return;

  let totalDeleted = 0;
  let iteration = 0;

  while (iteration < MAX_REPOSTS) {
    iteration++;

    // Refresh card list on each iteration (cards are removed from DOM after deletion)
    const cards = queryAll(SELECTORS.videoCard);
    if (cards.length === 0) break;

    // We always target the first card to avoid stale-element issues
    const card = cards[0];

    // Report progress — we don't know the total until we've fetched all, so show running count
    // On first pass try to count all visible cards as an estimate
    const estimatedTotal = Math.max(cards.length, totalDeleted + cards.length);
    sendMsg({ type: "progress", current: totalDeleted + 1, total: estimatedTotal });

    let success = false;
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {
      success = await deleteOneRepost(card);
      if (success) break;
      await sleep(DELAY_MS);
    }

    if (success) {
      totalDeleted++;
      // Wait between deletions to avoid triggering rate limits
      await sleep(DELAY_MS);
    } else {
      // Could not delete this card — skip it to avoid infinite loop
      break;
    }
  }

  if (totalDeleted === 0) {
    sendMsg({ type: "none" });
  } else {
    sendMsg({ type: "done", count: totalDeleted });
  }
}

// Attempt to delete a single repost card. Returns true on success.
async function deleteOneRepost(card) {
  // Hover the card to reveal the "..." button (TikTok hides it until hover)
  card.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
  card.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  await sleep(300);

  // Find and click the "more options" button
  let moreBtn = queryAny(SELECTORS.moreBtn, card);
  if (!moreBtn) {
    // Try a broader search — some TikTok layouts render the button outside the card
    moreBtn = document.querySelector(SELECTORS.moreBtn);
  }
  if (!moreBtn) return false;

  moreBtn.click();
  await sleep(MENU_WAIT_MS);

  // Find the "Remove repost" option in the context menu
  let removeItem = queryAny(SELECTORS.removeRepostItem);

  // Fallback: scan all visible menu items for text containing "repost"
  if (!removeItem) {
    const allMenuItems = document.querySelectorAll(
      '[role="menuitem"], [class*="MenuItem"], [class*="menu-item"]'
    );
    for (const item of allMenuItems) {
      if (item.textContent.toLowerCase().includes("repost")) {
        removeItem = item;
        break;
      }
    }
  }

  if (!removeItem) {
    // Close any open menu by pressing Escape, then give up on this card
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    return false;
  }

  removeItem.click();
  await sleep(MENU_WAIT_MS);

  // Handle optional confirmation dialog
  const confirmBtn = queryAny(SELECTORS.confirmBtn);
  if (confirmBtn) {
    confirmBtn.click();
    await sleep(MENU_WAIT_MS);
  }

  return true;
}

// ---------- Message listener ----------

// Listen for the "deleteReposts" command from popup.js
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg.action === "deleteReposts") {
    deleteAllReposts().catch((err) => {
      sendMsg({ type: "error", message: "Unexpected error: " + err.message });
    });
  }
});
