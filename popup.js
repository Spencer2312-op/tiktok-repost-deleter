// popup.js — handles button click and communicates with the content script

const deleteBtn   = document.getElementById("deleteBtn");
const statusEl    = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar  = document.getElementById("progressBar");
const countNumber  = document.getElementById("countNumber");
const countLabel   = document.getElementById("countLabel");

let currentTabId = null;
let repostCount  = 0;

function setStatus(msg, type = "") {
  statusEl.textContent = msg;
  statusEl.className = type;
}

function setProgress(current, total) {
  if (total > 0) {
    progressWrap.classList.add("visible");
    progressBar.style.width = Math.round((current / total) * 100) + "%";
  } else {
    progressWrap.classList.remove("visible");
    progressBar.style.width = "0%";
  }
}

function showCount(n, label = "reposts found") {
  countNumber.textContent = n;
  countNumber.classList.remove("loading");
  countLabel.textContent = label;
}

function showCountLoading() {
  countNumber.textContent = "—";
  countNumber.classList.add("loading");
  countLabel.textContent = "checking reposts...";
}

async function injectAndSend(tabId, action) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content.js"],
    });
  } catch (_) {}
  chrome.tabs.sendMessage(tabId, { action });
}

// On popup open — auto-count reposts
async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("tiktok.com")) {
    showCount("!", "open TikTok first");
    countNumber.style.color = "#fe2c55";
    setStatus("Please open TikTok in this tab first.", "error");
    return;
  }

  currentTabId = tab.id;
  showCountLoading();
  await injectAndSend(tab.id, "countReposts");
}

// Delete button click
deleteBtn.addEventListener("click", async () => {
  if (!currentTabId) return;
  deleteBtn.disabled = true;
  setStatus("Starting...", "running");
  setProgress(0, 0);
  showCount(repostCount, "deleting...");
  await injectAndSend(currentTabId, "deleteReposts");
});

// Messages from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "count") {
    repostCount = msg.count;
    if (repostCount === 0) {
      showCount(0, "no reposts found");
      setStatus("");
      deleteBtn.disabled = true;
    } else {
      showCount(repostCount, repostCount === 1 ? "repost found" : "reposts found");
      setStatus("");
      deleteBtn.disabled = false;
    }
  } else if (msg.type === "progress") {
    showCount(msg.total - msg.current, "remaining");
    setStatus(`Deleting repost ${msg.current} of ${msg.total}...`, "running");
    setProgress(msg.current, msg.total);
  } else if (msg.type === "done") {
    showCount(0, "all deleted!");
    countNumber.style.color = "#69c779";
    setStatus("All reposts deleted!", "success");
    setProgress(1, 1);
    deleteBtn.disabled = true;
  } else if (msg.type === "none") {
    showCount(0, "no reposts found");
    setStatus("");
    deleteBtn.disabled = true;
    setProgress(0, 0);
  } else if (msg.type === "error") {
    showCount("!", "something went wrong");
    countNumber.style.color = "#fe2c55";
    setStatus(msg.message || "An error occurred.", "error");
    setProgress(0, 0);
    deleteBtn.disabled = false;
  } else if (msg.type === "notLoggedIn") {
    showCount("?", "not logged in");
    countNumber.style.color = "#fe2c55";
    setStatus("Please log in to TikTok first.", "error");
    setProgress(0, 0);
    deleteBtn.disabled = true;
  }
});

init();
