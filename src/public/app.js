// --- State ---
let isConnected = false;

// --- API helpers ---

async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok && data.error) {
    throw new Error(data.error);
  }
  return data;
}

// --- Toast ---

let toastTimer;
function showToast(msg, isError = false, duration = 2000) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast visible" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = "toast";
  }, duration);
}

// --- Screen navigation ---

function showDiscovery() {
  document.getElementById("discovery-screen").classList.add("active");
  document.getElementById("remote-screen").classList.remove("active");
}

function showRemote(name) {
  document.getElementById("discovery-screen").classList.remove("active");
  document.getElementById("remote-screen").classList.add("active");
  document.getElementById("tv-name").textContent = name || "Samsung TV";
}

// --- Discovery ---

async function scanForTVs() {
  const btn = document.getElementById("scan-btn");
  const status = document.getElementById("scan-status");
  const list = document.getElementById("tv-list");

  btn.classList.add("scanning");
  btn.querySelector("span").textContent = "Scanning\u2026";
  status.textContent = "Searching for Samsung TVs on your network\u2026";
  list.innerHTML = "";

  try {
    const data = await api("GET", "/api/discover");
    const devices = data.devices || [];

    if (devices.length === 0) {
      status.textContent = "No TVs found. Make sure your TV is on and on the same network.";
    } else {
      status.textContent = `Found ${devices.length} TV${devices.length > 1 ? "s" : ""}:`;
      for (const d of devices) {
        const item = document.createElement("div");
        item.className = "tv-item";
        item.innerHTML = `
          <span class="tv-icon">&#x1F4FA;</span>
          <div class="tv-info">
            <div class="name">${escapeHtml(d.friendlyName || "Samsung TV")}</div>
            <div class="ip">${escapeHtml(d.ip)} &middot; ${escapeHtml(d.mac)}</div>
          </div>
          <span class="arrow">&#x203A;</span>
        `;
        item.onclick = () => connectToTV(d, item);
        list.appendChild(item);
      }
    }
  } catch (err) {
    status.textContent = "Scan failed: " + err.message;
    showToast("Scan failed", true);
  }

  btn.classList.remove("scanning");
  btn.querySelector("span").textContent = "Scan for TVs";
}

// --- Connect ---

async function connectToTV(device, itemEl) {
  if (itemEl) itemEl.classList.add("connecting");
  const status = document.getElementById("scan-status");
  status.textContent = `Connecting to ${device.friendlyName || device.ip}\u2026 Check your TV for a pairing prompt.`;

  try {
    await api("POST", "/api/connect", {
      ip: device.ip,
      mac: device.mac,
      friendlyName: device.friendlyName,
    });
    isConnected = true;
    showRemote(device.friendlyName || device.ip);
    showToast("Connected!");
  } catch (err) {
    status.textContent = "Connection failed: " + err.message;
    showToast("Connection failed", true);
  }

  if (itemEl) itemEl.classList.remove("connecting");
}

// --- Send key ---

async function sendKey(key) {
  try {
    await api("POST", "/api/key", { key });
  } catch (err) {
    showToast(err.message, true);
    if (err.message.includes("Not connected")) {
      isConnected = false;
      showDiscovery();
    }
  }
}

// --- Smart Search ---

async function doSmartSearch() {
  const input = document.getElementById("smart-input");
  const btn = document.getElementById("smart-btn");
  const query = input.value.trim();
  if (!query) return;

  btn.classList.add("loading");
  try {
    const data = await api("POST", "/api/smart", { query });
    input.value = "";
    showToast(`Searching: ${data.search}`);
  } catch (err) {
    showToast(err.message, true);
  }
  btn.classList.remove("loading");
}

document.addEventListener("keydown", (e) => {
  if (e.target.id === "smart-input" && e.key === "Enter") {
    e.preventDefault();
    doSmartSearch();
  }
});

// --- Launch streaming app ---

async function launchApp(appName) {
  try {
    await api("POST", "/api/launch", { app: appName });
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- Wake-on-LAN ---

async function wakeTV() {
  try {
    showToast("Sending wake signal\u2026");
    await api("POST", "/api/wake");
    showToast("Wake signal sent! TV should power on shortly.");
  } catch (err) {
    showToast(err.message, true);
  }
}

// --- Helpers ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Init ---

async function init() {
  // Check if already connected (e.g. server auto-reconnected)
  try {
    const status = await api("GET", "/api/status");
    if (status.connected && status.device) {
      isConnected = true;
      showRemote(status.device.friendlyName || status.device.ip);
      return;
    }
  } catch {}

  // Stay on discovery screen
  showDiscovery();
}

// Add visual feedback for button presses
const pressable = ".btn, .btn-nav-lg, .btn-vol, .btn-mute, .btn-quick, .btn-media, .btn-num, .btn-extra, .btn-ch, .btn-smart-send, .app-btn, .btn-power";

document.addEventListener("pointerdown", (e) => {
  const btn = e.target.closest(pressable);
  if (btn) btn.classList.add("pressed");
});

function clearPressed() {
  document.querySelectorAll(".pressed").forEach((b) => b.classList.remove("pressed"));
}

document.addEventListener("pointerup", clearPressed);
document.addEventListener("pointercancel", clearPressed);

init();
