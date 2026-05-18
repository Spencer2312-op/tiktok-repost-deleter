// popup.js — handles button click and communicates with the content script via chrome.tabs.sendMessage

const deleteBtn = document.getElementById("deleteBtn");
const statusEl = document.getElementById("status");
const progressWrap = document.getElementById("progressWrap");
const progressBar = document.getElementById("progressBar");

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

deleteBtn.addEventListener("click", async () => {
  // Get the currently active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Guard: must be on tiktok.com
  if (!tab || !tab.url || !tab.url.includes("tiktok.com")) {
    setStatus("Please open TikTok in this tab first.", "error");
    return;
  }

  deleteBtn.disabled = true;
  setStatus("Starting...", "running");
  setProgress(0, 0);

  // Inject the content script if not already present, then kick off deletion
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
  } catch (_) {
    // Script may already be injected — that is fine, continue
  }

  // Send a message to the content script to begin deletion
  chrome.tabs.sendMessage(tab.id, { action: "deleteReposts" });
});

// Listen for progress/status updates sent back from the content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    setStatus(`Deleting repost ${msg.current} of ${msg.total}...`, "running");
    setProgress(msg.current, msg.total);
  } else if (msg.type === "done") {
    setStatus("All reposts deleted!", "success");
    setProgress(1, 1);
    deleteBtn.disabled = false;
  } else if (msg.type === "none") {
    setStatus("No reposts found.", "success");
    setProgress(0, 0);
    deleteBtn.disabled = false;
  } else if (msg.type === "error") {
    setStatus(msg.message || "An error occurred.", "error");
    setProgress(0, 0);
    deleteBtn.disabled = false;
  } else if (msg.type === "notLoggedIn") {
    setStatus("Please log in to TikTok first.", "error");
    setProgress(0, 0);
    deleteBtn.disabled = false;
  }
});
