import express from "express";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  discoverTVs,
  connectToTV,
  autoReconnect,
  sendKey,
  sendText,
  launchApp,
  castToTV,
  smartSearch,
  parseSmartQuery,
  searchYouTube,
  wakeTV,
  getStatus,
  disconnect,
  getAvailableKeys,
} from "./tv.js";
import { networkInterfaces } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// --- API Routes ---

// Discover Samsung TVs on the network
app.get("/api/discover", async (_req, res) => {
  try {
    const devices = await discoverTVs();
    res.json({ devices });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Connect to a TV
app.post("/api/connect", async (req, res) => {
  const { ip, mac, friendlyName, port } = req.body;
  if (!ip) {
    res.status(400).json({ error: "ip is required" });
    return;
  }
  const result = await connectToTV(ip, mac || "", friendlyName, port);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Get connection status
app.get("/api/status", (_req, res) => {
  res.json(getStatus());
});

// Send a key command
app.post("/api/key", async (req, res) => {
  const { key } = req.body;
  if (!key) {
    res.status(400).json({ error: "key is required" });
    return;
  }
  const result = await sendKey(key);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Send text input
app.post("/api/text", async (req, res) => {
  const { text } = req.body;
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  const result = await sendText(text);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

// Launch app
app.post("/api/launch", async (req, res) => {
  const { app: appName } = req.body;
  if (!appName) {
    res.status(400).json({ error: "app is required" });
    return;
  }
  const result = await launchApp(appName);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Smart search
app.post("/api/smart", async (req, res) => {
  const { query } = req.body;
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  const result = await smartSearch(query);
  if (result.success) {
    res.json({ success: true, app: result.app, search: result.search, message: result.error });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Cast content to TV via deep link
app.post("/api/cast", async (req, res) => {
  const { app: appName, contentId, metaTag } = req.body;
  if (!appName) {
    res.status(400).json({ error: "app is required" });
    return;
  }
  if (!contentId && !metaTag) {
    res.status(400).json({ error: "contentId or metaTag is required" });
    return;
  }
  const result = await castToTV(appName, contentId || "", metaTag);
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Search YouTube for videos (returns results for casting)
app.get("/api/search/youtube", async (req, res) => {
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: "q query parameter is required" });
    return;
  }
  try {
    const results = await searchYouTube(query);
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Parse a natural language query into app + search term
app.get("/api/parse", (req, res) => {
  const query = req.query.q as string;
  if (!query) {
    res.status(400).json({ error: "q query parameter is required" });
    return;
  }
  const parsed = parseSmartQuery(query);
  res.json(parsed);
});

// Wake-on-LAN
app.post("/api/wake", async (_req, res) => {
  const result = await wakeTV();
  if (result.success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ success: false, error: result.error });
  }
});

// Disconnect
app.post("/api/disconnect", (_req, res) => {
  disconnect();
  res.json({ success: true });
});

// Get available keys
app.get("/api/keys", (_req, res) => {
  res.json({ keys: getAvailableKeys() });
});

// --- Start ---

function getLocalIPs(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

app.listen(PORT, "0.0.0.0", async () => {
  const ips = getLocalIPs();
  console.log(`\n  Samsung TV Remote Control`);
  console.log(`  ────────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`  Network: http://${ip}:${PORT}`);
  }
  console.log();

  // Try to auto-reconnect to last TV
  const reconnected = await autoReconnect();
  if (reconnected) {
    const status = getStatus();
    console.log(
      `  Auto-reconnected to ${status.device?.friendlyName || status.device?.ip}`
    );
  } else {
    console.log(`  No saved TV connection. Open the UI to discover and connect.`);
  }
  console.log();
});
