// api/scan.js – Intelligenter Scanner: Sitemap/Scraping wo möglich, RSS als Fallback

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://rezepte-backend.vercel.app";

const MAX_PER_SITE = 10;

// Bekannte Konfigurationen je Domain
// method: "sitemap" | "rss" | "both"
const SITE_CONFIG = {
  "chefkoch.de":          { method: "rss",     rss: "/magazin/rss.xml" },
  "lecker.de":            { method: "rss",     rss: "/rss.xml" },
  "essen-und-trinken.de": { method: "rss",     rss: "/rss.xml" },
  "rewe.de":              { method: "sitemap", sitemap: "/sitemap.xml", recipePattern: "/rezepte/" },
  "edeka.de":             { method: "sitemap", sitemap: "/sitemap.xml", recipePattern: "/rezepte/" },
  "eatsmarter.de":        { method: "both",    sitemap: "/sitemap.xml", rss: "/rss.xml", recipePattern: "/rezepte/" },
  "kuechengoetter.de":    { method: "both",    sitemap: "/sitemap.xml", rss: "/feed",    recipePattern: "/rezepte/" },
  "springlane.de":        { method: "both",    sitemap: "/sitemap.xml", rss: "/magazin/feed", recipePattern: "/magazin/" },
  "zuckerjagdwurst.com":  { method: "rss",     rss: "/feed" },
  "biancazapatka.com":    { method: "rss",     rss: "/de/feed" },
  "gaumenfreundin.de":    { method: "rss",     rss: "/feed" },
  "emmikochteinfach.de":  { method: "rss",     rss: "/feed" },
};

async function redis(command, ...args) {
  const response = await fetch(
    `${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join("/")}`,
    { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
  );
  const data = await response.json();
  return data.result;
}

async function redisPost(body) {
  const response = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  return data.result;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RecipeFinderBot/1.0)",
        Accept: "application/rss+xml, application/xml, text/xml, text/html, */*"
      },
      signal: AbortSignal.timeout(12000),
      redirect: "follow"
    });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  }
}

// ── RSS ──────────────────────────────────────────────────────────────────────

function extractUrlsFromRSS(xml) {
  const urls = [];

  const linkMatches = [...xml.matchAll(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/gs)];
  for (const match of linkMatches) {
    const url = match[1].trim();
    if (url.startsWith("http")) urls.push(url);
  }

  const guidMatches = [...xml.matchAll(/<guid[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/guid>/gs)];
  for (const match of guidMatches) {
    const url = match[1].trim();
    if (url.startsWith("http") && !urls.includes(url)) urls.push(url);
  }

  const atomMatches = [...xml.matchAll(/<link[^>]+href="([^"]+)"/g)];
  for (const match of atomMatches) {
    const url = match[1].trim();
    if (url.startsWith("http") && !urls.includes(url)) urls.push(url);
  }

  return urls;
}

async function getUrlsFromRSS(baseUrl, rssPaths) {
  const candidates = Array.isArray(rssPaths) ? rssPaths : [rssPaths];
  const fallbacks = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml"];
  const all = [...new Set([...candidates, ...fallbacks])];

  for (const path of all) {
    const xml = await fetchText(baseUrl + path);
    if (!xml) continue;
    if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<item>") && !xml.includes("<entry>")) continue;
    const urls = extractUrlsFromRSS(xml);
    if (urls.length > 0) return urls;
  }

  return [];
}

// ── Sitemap ───────────────────────────────────────────────────────────────────

function extractUrlsFromSitemap(xml, recipePattern) {
  const urls = [];
  const locMatches = [...xml.matchAll(/<loc>(.*?)<\/loc>/gs)];

  for (const match of locMatches) {
    const url = match[1].trim();
    if (recipePattern && url.includes(recipePattern)) {
      urls.push(url);
    } else if (!recipePattern && isLikelyRecipeUrl(url)) {
      urls.push(url);
    }
  }

  return urls;
}

function isLikelyRecipeUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const excluded = ["/tag/", "/kategorie/", "/category/", "/autor/", "/author/",
      "/page/", "/search", "/suche", "/sitemap", "/feed", "/rss", "/impressum", "/datenschutz"];
    if (excluded.some(e => path.includes(e))) return false;
    const included = ["/rezept", "/recipe"];
    if (included.some(e => path.includes(e))) return true;
    return path.split("/").filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

async function getUrlsFromSitemap(baseUrl, sitemapPath, recipePattern) {
  const candidates = [sitemapPath, "/sitemap.xml", "/sitemap_index.xml"].filter(Boolean);

  for (const path of candidates) {
    const xml = await fetchText(baseUrl + path);
    if (!xml) continue;

    // Sitemap-Index → Unter-Sitemaps durchsuchen
    if (xml.includes("<sitemapindex") || (xml.includes("<sitemap>") && xml.includes("<loc>"))) {
      const subMatches = [...xml.matchAll(/<loc>(.*?)<\/loc>/gs)];
      for (const match of subMatches) {
        const subUrl = match[1].trim();
        const subPath = subUrl.toLowerCase();
        if (subPath.includes("rezept") || subPath.includes("recipe") || subPath.includes("food")) {
          const subXml = await fetchText(subUrl);
          if (subXml) {
            const urls = extractUrlsFromSitemap(subXml, recipePattern);
            if (urls.length > 0) return urls;
          }
        }
      }
    }

    const urls = extractUrlsFromSitemap(xml, recipePattern);
    if (urls.length > 0) return urls;
  }

  return [];
}

// ── Hauptlogik ────────────────────────────────────────────────────────────────

async function findNewRecipeUrls(siteUrl) {
  const parsed = new URL(siteUrl);
  const baseUrl = parsed.origin;
  const hostname = parsed.hostname.replace(/^www\./, "");
  const config = SITE_CONFIG[hostname] || { method: "both" };

  let candidateUrls = [];

  if (config.method === "rss" || config.method === "both") {
    candidateUrls = await getUrlsFromRSS(baseUrl, config.rss);
  }

  if ((config.method === "sitemap" || config.method === "both") && candidateUrls.length === 0) {
    candidateUrls = await getUrlsFromSitemap(baseUrl, config.sitemap, config.recipePattern);
  }

  // Bereits importierte herausfiltern
  const newUrls = [];
  for (const url of candidateUrls) {
    const existing = await redis("get", `recipe_url:${encodeURIComponent(url)}`);
    if (!existing) newUrls.push(url);
    if (newUrls.length >= MAX_PER_SITE) break;
  }

  return newUrls;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  const log = [];
  let totalImported = 0;
  let totalSkipped = 0;

  try {
    const raw = await redis("get", "import_urls");
    const sites = raw ? JSON.parse(raw) : [];
    const activeSites = sites.filter(s => s.active);

    log.push(`${activeSites.length} aktive Seiten gefunden`);

    for (const site of activeSites) {
      log.push(`\nScanne: ${site.url}`);

      try {
        const newUrls = await findNewRecipeUrls(site.url);
        log.push(`  → ${newUrls.length} neue URLs gefunden`);

        for (const recipeUrl of newUrls) {
          try {
            const scrapeRes = await fetch(
              `${BASE_URL}/api/scrape?url=${encodeURIComponent(recipeUrl)}`,
              { signal: AbortSignal.timeout(15000) }
            );
            if (!scrapeRes.ok) { totalSkipped++; continue; }

            const data = await scrapeRes.json();
            if (!data.success || !data.ingredients || data.ingredients.length === 0) {
              log.push(`  ✗ Kein Rezept: ${recipeUrl}`);
              totalSkipped++;
              continue;
            }

            const recipe = {
              id: `auto-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
              title: data.name || "Importiertes Rezept",
              description: data.description || "",
              sourceName: new URL(recipeUrl).hostname.replace(/^www\./, ""),
              sourceUrl: recipeUrl,
              category: "Hauptgericht",
              difficulty: "Mittel",
              servings: data.servings || 4,
              totalTime: data.cookTime || 30,
              tags: [...(data.tags || []).map(t => t.toLowerCase()), "auto-import"],
              icon: "🍽️",
              image: data.image || null,
              ingredients: data.ingredients || [],
              instructions: data.instructions || [],
              importedAt: new Date().toISOString(),
              isAutoImport: true
            };

            await fetch(`${BASE_URL}/api/recipes`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(recipe)
            });

            await redisPost(["set", `recipe_url:${encodeURIComponent(recipeUrl)}`, recipe.id]);

            log.push(`  ✓ Importiert: „${recipe.title}"`);
            totalImported++;

            await new Promise(r => setTimeout(r, 800));

          } catch (err) {
            log.push(`  ✗ Fehler: ${err.message}`);
            totalSkipped++;
          }
        }

        const idx = sites.findIndex(s => s.url === site.url);
        if (idx !== -1) sites[idx].lastImportedAt = new Date().toISOString();

      } catch (err) {
        log.push(`  ✗ Scan-Fehler: ${err.message}`);
      }
    }

    await redisPost(["set", "import_urls", JSON.stringify(sites)]);

    const scanLog = { startedAt: new Date().toISOString(), imported: totalImported, skipped: totalSkipped, log };
    const existingLogs = await redis("get", "cron_logs");
    const logs = existingLogs ? JSON.parse(existingLogs) : [];
    logs.unshift(scanLog);
    await redisPost(["set", "cron_logs", JSON.stringify(logs.slice(0, 5))]);

    return res.status(200).json({ success: true, imported: totalImported, skipped: totalSkipped, log });

  } catch (err) {
    return res.status(500).json({ error: err.message, log });
  }
}
