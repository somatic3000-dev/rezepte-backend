// api/urls.js – Import-URL-Liste verwalten
// GET  /api/urls           → alle gespeicherten URLs laden
// POST /api/urls           → neue URL hinzufügen
// DELETE /api/urls?url=... → URL entfernen

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisPost(body) {
  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return data.result;
}

async function redis(command, ...args) {
  const response = await fetch(`${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await response.json();
  return data.result;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET – alle URLs laden
  if (req.method === "GET") {
    try {
      const raw = await redis("get", "import_urls");
      const urls = raw ? JSON.parse(raw) : [];
      return res.status(200).json({ urls });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST – URL hinzufügen
  if (req.method === "POST") {
    try {
      const { url, label } = req.body;
      if (!url) return res.status(400).json({ error: "URL fehlt" });

      const raw = await redis("get", "import_urls");
      const urls = raw ? JSON.parse(raw) : [];

      if (urls.find(u => u.url === url)) {
        return res.status(200).json({ success: true, message: "URL bereits vorhanden" });
      }

      urls.push({
        url,
        label: label || new URL(url).hostname,
        active: true,
        addedAt: new Date().toISOString(),
        lastImportedAt: null
      });

      await redisPost(["set", "import_urls", JSON.stringify(urls)]);
      return res.status(200).json({ success: true, urls });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE – URL entfernen
  if (req.method === "DELETE") {
    try {
      const urlToRemove = req.query.url;
      if (!urlToRemove) return res.status(400).json({ error: "URL fehlt" });

      const raw = await redis("get", "import_urls");
      const urls = raw ? JSON.parse(raw) : [];
      const filtered = urls.filter(u => u.url !== urlToRemove);

      await redisPost(["set", "import_urls", JSON.stringify(filtered)]);
      return res.status(200).json({ success: true, urls: filtered });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Methode nicht erlaubt" });
}
