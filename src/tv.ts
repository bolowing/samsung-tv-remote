import {
  getAwakeSamsungDevices,
  Keys,
  type SamsungDevice,
} from "samsung-tv-remote";
import WebSocket from "ws";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { networkInterfaces } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOKEN_DIR = join(__dirname, "..", ".tokens");
const TOKEN_FILE = join(TOKEN_DIR, "tv-token.json");
const APP_NAME = "SamsungWebRemote";

// Timeouts (ms)
const PROBE_TIMEOUT = 2000;
const DISCOVERY_TIMEOUT = 2000;
const WS_HANDSHAKE_TIMEOUT = 15000;
const SMARTHUB_OPEN_DELAY = 3000;
const SEARCH_INPUT_DELAY = 1000;
const SEARCH_RESULTS_DELAY = 3000;
const NAVIGATE_DELAY = 500;

interface SavedConnection {
  ip: string;
  mac: string;
  friendlyName?: string;
  token?: string;
}

let ws: WebSocket | null = null;
let connectedDevice: SamsungDevice | null = null;
let savedToken: string | undefined;

// --- Discovery ---

async function probeTVByIP(ip: string): Promise<SamsungDevice | null> {
  for (const port of [8001, 8002]) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
      const res = await fetch(`http://${ip}:${port}/api/v2/`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        const d = data.device;
        return {
          ip: d.ip || ip,
          mac: d.wifiMac || "",
          friendlyName: d.name || d.modelName || "Samsung TV",
        };
      }
    } catch {}
  }
  return null;
}

export async function discoverTVs(timeout = DISCOVERY_TIMEOUT): Promise<SamsungDevice[]> {
  // Try SSDP first
  const devices = await getAwakeSamsungDevices(timeout);
  if (devices.length > 0) return devices;

  // Fallback: probe local subnet via HTTP API
  const localIP = getLocalSubnet();
  if (!localIP) return [];

  const prefix = localIP.substring(0, localIP.lastIndexOf(".") + 1);
  const probes: Promise<SamsungDevice | null>[] = [];
  for (let i = 1; i < 255; i++) {
    probes.push(probeTVByIP(`${prefix}${i}`));
  }
  const results = await Promise.all(probes);
  return results.filter((d): d is SamsungDevice => d !== null);
}

function getLocalSubnet(): string | null {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return null;
}

// --- Token persistence ---

async function saveConnection(
  device: SamsungDevice,
  token?: string
): Promise<void> {
  await mkdir(TOKEN_DIR, { recursive: true });
  const data: SavedConnection = {
    ip: device.ip,
    mac: device.mac,
    friendlyName: device.friendlyName,
    token,
  };
  await writeFile(TOKEN_FILE, JSON.stringify(data, null, 2));
}

async function loadSavedConnection(): Promise<SavedConnection | null> {
  try {
    const raw = await readFile(TOKEN_FILE, "utf-8");
    return JSON.parse(raw) as SavedConnection;
  } catch {
    return null;
  }
}

// --- Direct WebSocket connection (bypasses ws strict close-code validation) ---

function buildWSUrl(ip: string, port: number, token?: string): string {
  const protocol = port === 8001 ? "ws" : "wss";
  const name = Buffer.from(APP_NAME).toString("base64");
  let url = `${protocol}://${ip}:${port}/api/v2/channels/samsung.remote.control?name=${name}`;
  if (token) url += `&token=${token}`;
  return url;
}

function connectWS(
  ip: string,
  port: number,
  token?: string,
  timeoutMs = WS_HANDSHAKE_TIMEOUT
): Promise<{ ws: WebSocket; token?: string }> {
  return new Promise((resolve, reject) => {
    const url = buildWSUrl(ip, port, token);
    console.log(`  Connecting to ${url.replace(/token=.*/, "token=***")}`);

    const socket = new WebSocket(url, {
      rejectUnauthorized: false,
      handshakeTimeout: timeoutMs,
    });

    const timeout = setTimeout(() => {
      socket.removeAllListeners();
      socket.close();
      reject(new Error("Connection timed out — no response from TV"));
    }, timeoutMs);

    socket.on("error", (err: any) => {
      // Ignore the invalid close code error from Samsung TVs
      if (err.message?.includes("1005")) {
        clearTimeout(timeout);
        socket.removeAllListeners();
        reject(
          new Error(
            "TV rejected the connection (notack). You may need to allow the device in TV Settings > General > External Device Manager."
          )
        );
        return;
      }
      clearTimeout(timeout);
      socket.removeAllListeners();
      reject(err);
    });

    socket.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event === "ms.channel.connect") {
          clearTimeout(timeout);
          const newToken = msg.data?.token;
          resolve({ ws: socket, token: newToken || token });
        }
      } catch {}
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      reject(new Error("TV closed the connection"));
    });
  });
}

// --- Connection ---

export async function connectToTV(
  ip: string,
  mac: string,
  friendlyName?: string,
  port?: number
): Promise<{ success: boolean; error?: string }> {
  try {
    // Disconnect existing
    disconnect();

    const device: SamsungDevice = { ip, mac, friendlyName };

    // Load saved token if connecting to same IP
    const saved = await loadSavedConnection();
    const token =
      saved?.ip === ip && saved.token ? saved.token : undefined;

    // If a specific port is given, use it directly; otherwise try 8002 then 8001
    let result: { ws: WebSocket; token?: string };
    if (port) {
      result = await connectWS(ip, port, token);
    } else {
      try {
        result = await connectWS(ip, 8002, token);
      } catch {
        result = await connectWS(ip, 8001, token);
      }
    }

    ws = result.ws;
    savedToken = result.token;
    connectedDevice = device;
    await saveConnection(device, result.token);

    // Log all messages from TV for debugging
    ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.event !== "ms.channel.connect") {
          console.log(`  TV msg: ${JSON.stringify(msg)}`);
        }
      } catch {}
    });

    // Handle unexpected disconnects
    ws.on("close", () => {
      console.log("  TV disconnected");
      ws = null;
      connectedDevice = null;
    });

    console.log("  Connected to TV!");
    return { success: true };
  } catch (err: any) {
    ws = null;
    connectedDevice = null;
    return { success: false, error: err.message || String(err) };
  }
}

export async function autoReconnect(): Promise<boolean> {
  const saved = await loadSavedConnection();
  if (!saved) return false;

  const result = await connectToTV(
    saved.ip,
    saved.mac,
    saved.friendlyName
  );
  return result.success;
}

// --- Commands ---

function sendRawKey(key: string): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: "Click",
        DataOfCmd: key,
        Option: false,
        TypeOfRemote: "SendRemoteKey",
      },
    })
  );
}

export async function sendKey(
  key: string
): Promise<{ success: boolean; error?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { success: false, error: "Not connected to any TV" };
  }

  try {
    const keyValue = (Keys as any)[key];
    if (keyValue === undefined) {
      // Try sending as raw key (for keys not in the library enum)
      sendRawKey(key);
      return { success: true };
    }
    ws.send(
      JSON.stringify({
        method: "ms.remote.control",
        params: {
          Cmd: "Click",
          DataOfCmd: keyValue,
          Option: false,
          TypeOfRemote: "SendRemoteKey",
        },
      })
    );
    return { success: true };
  } catch (err: any) {
    ws = null;
    connectedDevice = null;
    return { success: false, error: err.message || String(err) };
  }
}

// --- Send Text ---

export async function sendText(
  text: string
): Promise<{ success: boolean; error?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return { success: false, error: "Not connected to any TV" };
  }

  try {
    const encoded = Buffer.from(text).toString("base64");
    ws.send(
      JSON.stringify({
        method: "ms.remote.control",
        params: {
          Cmd: encoded,
          DataOfCmd: "base64",
          TypeOfRemote: "SendInputString",
        },
      })
    );
    return { success: true };
  } catch (err: any) {
    ws = null;
    connectedDevice = null;
    return { success: false, error: err.message || String(err) };
  }
}

// --- Launch App ---

const APP_IDS: Record<string, string> = {
  Netflix: "11101200001",
  YouTube: "111299001912",
  "Disney+": "3201901017640",
  Hulu: "3201601007625",
  "HBO Max": "3202301029760",
  "Prime Video": "3201512006785",
};

export async function launchApp(
  appName: string
): Promise<{ success: boolean; error?: string }> {
  if (!connectedDevice) {
    return { success: false, error: "Not connected to any TV" };
  }

  const appId = APP_IDS[appName];
  if (!appId) {
    // Only allow numeric app IDs if not a known app name
    if (!/^\d+$/.test(appName)) {
      return { success: false, error: `Unknown app: ${appName}. Use a known app name or a numeric app ID.` };
    }
  }
  const resolvedId = appId || appName;

  try {
    const res = await fetch(
      `http://${connectedDevice.ip}:8001/api/v2/applications/${resolvedId}`,
      { method: "POST" }
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return {
        success: false,
        error: data.message || `Failed to launch ${appName}`,
      };
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// --- Deep Link Casting ---

function deepLinkViaWS(appId: string, metaTag: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(
      JSON.stringify({
        method: "ms.channel.emit",
        params: {
          event: "ed.apps.launch",
          to: "host",
          data: {
            appId,
            action_type: "DEEP_LINK",
            metaTag,
          },
        },
      })
    );
    return true;
  } catch {
    return false;
  }
}

async function deepLinkViaREST(ip: string, appId: string, metaTag: string): Promise<boolean> {
  try {
    const res = await fetch(
      `http://${ip}:8001/api/v2/applications/${appId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: appId, metaTag }),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function castToTV(
  appName: string,
  contentId: string,
  metaTag?: string
): Promise<{ success: boolean; error?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN || !connectedDevice) {
    return { success: false, error: "Not connected to any TV" };
  }

  const appId = APP_IDS[appName];
  if (!appId) {
    return { success: false, error: `Unknown app: ${appName}` };
  }

  const tag = metaTag || contentId;
  console.log(`  Casting to ${appName} (${appId}): metaTag=${tag}`);

  // Try WebSocket deep link first (most reliable), fall back to REST
  if (deepLinkViaWS(appId, tag)) {
    return { success: true };
  }

  const ok = await deepLinkViaREST(connectedDevice.ip, appId, tag);
  if (ok) {
    return { success: true };
  }

  return { success: false, error: `Failed to cast to ${appName}` };
}

// --- YouTube Search (server-side) ---

interface YouTubeResult {
  videoId: string;
  title: string;
  channel: string;
}

async function searchYouTube(query: string): Promise<YouTubeResult[]> {
  try {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    const html = await res.text();
    // Extract video data from ytInitialData JSON embedded in the page
    const dataMatch = html.match(/var ytInitialData = ({.*?});<\/script>/s);
    if (!dataMatch) {
      // Fallback: just grab video IDs
      const ids = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)]
        .map((m) => m[1])
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .slice(0, 5);
      return ids.map((id) => ({ videoId: id, title: "", channel: "" }));
    }

    try {
      const data = JSON.parse(dataMatch[1]);
      const contents =
        data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.sections?.[0]?.itemSectionRenderer?.contents || [];
      const results: YouTubeResult[] = [];
      for (const item of contents) {
        const renderer = item.videoRenderer;
        if (!renderer?.videoId) continue;
        results.push({
          videoId: renderer.videoId,
          title: renderer.title?.runs?.[0]?.text || "",
          channel: renderer.ownerText?.runs?.[0]?.text || "",
        });
        if (results.length >= 5) break;
      }
      return results;
    } catch {
      // JSON parse failed, fallback to regex
      const ids = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)]
        .map((m) => m[1])
        .filter((id, i, arr) => arr.indexOf(id) === i)
        .slice(0, 5);
      return ids.map((id) => ({ videoId: id, title: "", channel: "" }));
    }
  } catch {
    return [];
  }
}

// --- Smart Search & Cast ---

const APP_KEYWORDS: { pattern: RegExp; app: string }[] = [
  { pattern: /\bon\s+netflix\b|\bnetflix\b/i, app: "Netflix" },
  { pattern: /\bon\s+disney\b|\bdisney\s*\+?\b/i, app: "Disney+" },
  { pattern: /\bon\s+hulu\b|\bhulu\b/i, app: "Hulu" },
  { pattern: /\bon\s+hbo\b|\bhbo\b|\bon\s+max\b/i, app: "HBO Max" },
  { pattern: /\bon\s+prime\b|\bprime\s*video\b|\bamazon\b/i, app: "Prime Video" },
  { pattern: /\bon\s+youtube\b|\byoutube\b/i, app: "YouTube" },
];

function parseSmartQuery(query: string): { app: string; search: string } {
  for (const { pattern, app } of APP_KEYWORDS) {
    if (pattern.test(query)) {
      const search = query.replace(pattern, "").replace(/\b(put on|play|watch|find|search|search for|look up)\b/gi, "").trim();
      return { app, search };
    }
  }
  // Default to YouTube for general queries
  const search = query.replace(/\b(put on|play|watch|find|search|search for|look up)\b/gi, "").trim();
  return { app: "YouTube", search };
}

export { parseSmartQuery, searchYouTube };

export async function smartSearch(
  query: string
): Promise<{ success: boolean; app: string; search: string; error?: string }> {
  if (!ws || ws.readyState !== WebSocket.OPEN || !connectedDevice) {
    return { success: false, app: "", search: "", error: "Not connected to any TV" };
  }

  const { app, search } = parseSmartQuery(query);
  const searchTerm = search || query;

  console.log(`  Smart cast: "${searchTerm}" -> ${app}`);

  // For YouTube queries, search for video and deep link directly
  if (app === "YouTube") {
    const results = await searchYouTube(searchTerm);
    if (results.length > 0) {
      const result = await castToTV("YouTube", results[0].videoId, results[0].videoId);
      if (result.success) {
        return { success: true, app, search: searchTerm };
      }
    }
    // Fallback: launch YouTube and search via SmartHub
    console.log(`  YouTube deep link failed, falling back to SmartHub search`);
  } else {
    // For other apps, launch with search query as deep link meta tag
    const result = await castToTV(app, searchTerm);
    if (result.success) {
      return { success: true, app, search: searchTerm };
    }
    console.log(`  Deep link to ${app} failed, falling back to SmartHub search`);
  }

  // Fallback: use SmartHub key-based search
  sendRawKey("KEY_SMART_HUB");
  await new Promise((r) => setTimeout(r, SMARTHUB_OPEN_DELAY));

  const encoded = Buffer.from(searchTerm).toString("base64");
  ws.send(
    JSON.stringify({
      method: "ms.remote.control",
      params: {
        Cmd: encoded,
        DataOfCmd: "base64",
        TypeOfRemote: "SendInputString",
      },
    })
  );
  await new Promise((r) => setTimeout(r, SEARCH_INPUT_DELAY));

  sendRawKey("KEY_ENTER");
  await new Promise((r) => setTimeout(r, SEARCH_RESULTS_DELAY));

  sendRawKey("KEY_DOWN");
  await new Promise((r) => setTimeout(r, NAVIGATE_DELAY));
  sendRawKey("KEY_ENTER");

  return { success: true, app, search: searchTerm };
}

// --- Wake-on-LAN ---

export async function wakeTV(): Promise<{
  success: boolean;
  error?: string;
}> {
  const saved = await loadSavedConnection();
  if (!saved) {
    return { success: false, error: "No saved TV to wake. Connect first." };
  }

  try {
    const { wake } = await import("wake_on_lan" as string);
    return new Promise((resolve) => {
      wake(saved.mac, { num_packets: 30 }, (err: Error | null) => {
        if (err) resolve({ success: false, error: err.message });
        else resolve({ success: true });
      });
    });
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
}

// --- Status ---

export function getStatus(): {
  connected: boolean;
  device: SamsungDevice | null;
} {
  return {
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
    device: connectedDevice,
  };
}

// --- Disconnect ---

export function disconnect(): void {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {}
    ws = null;
    connectedDevice = null;
  }
}

// --- Available keys (for frontend) ---

export function getAvailableKeys(): string[] {
  return Object.keys(Keys);
}
