// api/scan.js – Scannt Rezeptseiten nach neuen Rezepten via Sitemap oder RSS
// Wird vom Cron-Job und manuell aufgerufen

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://rezepte-backend.vercel.app";

const MAX_PER_SITE = 10;

// Bekannte Sitemap/RSS-Pfade je Domain
const SITE_HINTS = {
  "chefkoch.de":          { sitemap: "/sitemap-rezepte.xml", rss: "/magazin/rss.xml" },
  "lecker.de":            { sitemap: "/sitemap-rezepte.xml", rss: "/rss.xml" },
  "essen-und-trinken.de": { sitemap: "/sitemap.xml",         rss: "/rss.xml" },
  "kuechengoetter.de":    { sitemap: "/sitemap.xml",         rss: "/feed" },
  "eatsmarter.de":        { sitemap: "/sitemap.xml",         rss: "/rss.xml" },
  "springlane.de":        { sitemap: "/sitemap.xml",         rss: "/magazin/feed" },
  "zuckerjagdwurst.com":  { sitemap: "/sitemap.xml",         rss: "/feed" },
  "biancazapatka.com":    { sitemap: "/sitemap.xml",         rss: "/feed" },
  "gaumenfreundin.de":    { sitemap: "/sitemap.xml",         rss: "/feed" },
  "emmikochteinfach.de":  { sitemap: "/sitemap.xml",         rss: "/feed" },
  "rewe.de":              { sitemap: "/sitemap.xml",         rss: null },
  "edeka.de":             { sitemap: "/sitemap.xml",         rss: null },
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
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RecipeFinderBot/1.0)",
      Accept: "text/html,application/xhtml+xml,application/xml,text/xml,*/*"
    },
    signal: AbortSignal.timeout(12000),
    redirect: "follow"
  });
  if (!response.ok) return null;
  return response.text();
}

// Rezept-URLs aus Sitemap extrahieren
function extractUrlsFromSitemap(xml, baseHost) {
  const urls = [];
  const locMatches = xml.matchAll(/<loc>(.*?)<\/loc>/gs);
  for (const match of locMatches) {
    const url = match[1].trim();
    // Nur echte Rezept-URLs (enthalten typische Schlüsselwörter)
    if (isLikelyRecipeUrl(url, baseHost)) {
      urls.push(url);
    }
  }
  return urls;
}

// Rezept-URLs aus RSS extrahieren
function extractUrlsFromRSS(xml) {
  const urls = [];
  const linkMatches = xml.matchAll(/<link>(.*?)<\/link>/gs);
  for (const match of linkMatches) {
    const url = match[1].trim();
    if (url.startsWith("http")) urls.push(url);
  }
  // Auch <guid> Tags prüfen
  const guidMatches = xml.matchAll(/<guid[^>]*>(.*?)<\/guid>/gs);
  for (const match of guidMatches) {
    const url = match[1].trim();
    if (url.startsWith("http") && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Prüft ob eine URL wahrscheinlich ein einzelnes Rezept ist
function isLikelyRecipeUrl(url, baseHost) {
  try {
    const parsed = new URL(url);
    if (!parsed.hostname.includes(baseHost)) return false;

    const path = parsed.pathname.toLowerCase();

    // Ausschließen: Kategorieseiten, Tag-Seiten, Autorenseiten etc.
    const excluded = ["/tag/", "/kategorie/", "/category/", "/autor/", "/author/",
      "/page/", "/search", "/suche", "/magazin/", "/blog/", "/tipps/",
      "/sitemap", "/feed", "/rss", "/?", "/impressum", "/datenschutz"];
    if (excluded.some(e => path.includes(e))) return false;

    // Einschließen: Pfade die auf Rezepte hinweisen
    const included = ["/rezept", "/recipe", "/kochen", "/backen", "/gericht"];
    if (included.some(e => path.includes(e))) return true;

    // Pfade mit ausreichend Tiefe (z.B. /pasta/carbonara-123)
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 2) return true;

    return false;
  } catch {
    return false;
  }
}

// Versucht Sitemap-Index → einzelne Sitemaps zu finden
async function findRecipeUrlsFromSitemap(baseUrl, hostname) {
  const hints = SITE_HINTS[hostname] || {};
  const candidates = [
    hints.sitemap,
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/rezepte-sitemap.xml",
    "/recipe-sitemap.xml"
  ].filter(Boolean);

  for (const path of candidates) {
    const xml = await fetchText(baseUrl + path);
    if (!xml) continue;

    // Sitemap-Index? → Unter-Sitemaps laden
    if (xml.includes("<sitemapindex") || xml.includes("<sitemap>")) {
      const subMatches = [...xml.matchAll(/<loc>(.*?)<\/loc>/gs)];
      for (const match of subMatches) {
        const subUrl = match[1].trim();
        if (subUrl.toLowerCase().includes("rezept") || subUrl.toLowerCase().includes("recipe")) {
          const subXml = await fetchText(subUrl);
          if (subXml) {
            const urls = extractUrlsFromSitemap(subXml, hostname);
            if (urls.length > 0) return urls;
          }
        }
      }
    }

    // Direkte Sitemap
    const urls = extractUrlsFromSitemap(xml, hostname);
    if (urls.length > 0) return urls;
  }

  return [];
}

// Versucht RSS-Feed zu finden
async function findRecipeUrlsFromRSS(baseUrl, hostname) {
  const hints = SITE_HINTS[hostname] || {};
  if (hints.rss === null) return [];

  const candidates = [
    hints.rss,
    "/feed",
    "/rss.xml",
    "/feed.xml",
    "/atom.xml",
    "/rezepte/feed"
  ].filter(Boolean);

  for (const path of candidates) {
    const xml = await fetchText(baseUrl + path);
    if (!xml) continue;
    if (!xml.includes("<rss") && !xml.includes("<feed") && !xml.includes("<item>")) continue;
    const urls = extractUrlsFromRSS(xml);
    if (urls.length > 0) return urls;
  }

  return [];
}

// Hauptfunktion: Scannt eine Domain und gibt neue Rezept-URLs zurück
async function scanSiteForNewRecipes(siteUrl) {
  const parsed = new URL(siteUrl);
  const baseUrl = parsed.origin;
  const hostname = parsed.hostname.replace(/^www\./, "");

  let candidateUrls = [];

  // 1. Sitemap versuchen
  candidateUrls = await findRecipeUrlsFromSitemap(baseUrl, hostname);

  // 2. RSS als Fallback
  if (candidateUrls.length === 0) {
    candidateUrls = await findRecipeUrlsFromRSS(baseUrl, hostname);
  }

  if (candidateUrls.length === 0) return [];

  // Bereits importierte URLs filtern
  const newUrls = [];
  for (const url of candidateUrls) {
    const urlKey = `recipe_url:${encodeURIComponent(url)}`;
    const existing = await redis("get", urlKey);
    if (!existing) newUrls.push(url);
    if (newUrls.length >= MAX_PER_SITE) break;
  }

  return newUrls;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Sicherheit
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  const log = [];
  let totalImported = 0;
  let totalSkipped = 0;

  try {
    // Alle gespeicherten Seiten laden
    const raw = await redis("get", "import_urls");
    const sites = raw ? JSON.parse(raw) : [];
    const activeSites = sites.filter(s => s.active);

    log.push(`${activeSites.length} aktive Seiten gefunden`);

    for (const site of activeSites) {
      log.push(`\nScanne: ${site.url}`);

      try {
        const newUrls = await scanSiteForNewRecipes(site.url);
        log.push(`  → ${newUrls.length} neue Rezept-URLs gefunden`);

        for (const recipeUrl of newUrls) {
          try {
            // Rezept scrapen
            const scrapeRes = await fetch(
              `${BASE_URL}/api/scrape?url=${encodeURIComponent(recipeUrl)}`,
              { signal: AbortSignal.timeout(15000) }
            );
            if (!scrapeRes.ok) { totalSkipped++; continue; }

            const data = await scrapeRes.json();
            if (!data.success) { totalSkipped++; continue; }

            // Rezept speichern
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

            // URL als importiert markieren
            await redisPost(["set", `recipe_url:${encodeURIComponent(recipeUrl)}`, recipe.id]);

            log.push(`  ✓ Importiert: „${recipe.title}"`);
            totalImported++;

            // Kurze Pause zwischen Requests
            await new Promise(r => setTimeout(r, 800));

          } catch (err) {
            log.push(`  ✗ Fehler bei ${recipeUrl}: ${err.message}`);
            totalSkipped++;
          }
        }

        // lastImportedAt aktualisieren
        const siteIndex = sites.findIndex(s => s.url === site.url);
        if (siteIndex !== -1) {
          sites[siteIndex].lastImportedAt = new Date().toISOString();
        }

      } catch (err) {
        log.push(`  ✗ Scan-Fehler: ${err.message}`);
        totalSkipped++;
      }
    }

    // Aktualisierte Seitenliste speichern
    await redisPost(["set", "import_urls", JSON.stringify(sites)]);

    // Scan-Log speichern
    const scanLog = {
      startedAt: new Date().toISOString(),
      imported: totalImported,
      skipped: totalSkipped,
      log
    };
    const existingLogs = await redis("get", "cron_logs");
    const logs = existingLogs ? JSON.parse(existingLogs) : [];
    logs.unshift(scanLog);
    await redisPost(["set", "cron_logs", JSON.stringify(logs.slice(0, 5))]);

    return res.status(200).json({ success: true, imported: totalImported, skipped: totalSkipped, log });

  } catch (err) {
    return res.status(500).json({ error: err.message, log });
  }
}
