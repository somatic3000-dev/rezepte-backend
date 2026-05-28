// api/cron.js – Wöchentlicher automatischer Import
// Wird von Vercel jeden Montag um 7:00 Uhr aufgerufen

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BASE_URL = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "https://rezepte-backend.vercel.app";

async function redis(command, ...args) {
  const response = await fetch(`${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const data = await response.json();
  return data.result;
}

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

async function scrapeUrl(url) {
  const response = await fetch(
    `${BASE_URL}/api/scrape?url=${encodeURIComponent(url)}`,
    { signal: AbortSignal.timeout(20000) }
  );
  if (!response.ok) return null;
  const data = await response.json();
  return data.success ? data : null;
}

async function saveRecipe(recipe) {
  await fetch(`${BASE_URL}/api/recipes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(recipe)
  });
}

export default async function handler(req, res) {
  // Sicherheit: nur Vercel Cron darf diese Route aufrufen
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Nicht autorisiert" });
  }

  const log = [];
  const startedAt = new Date().toISOString();

  try {
    // URL-Liste laden
    const raw = await redis("get", "import_urls");
    const urls = raw ? JSON.parse(raw) : [];
    const activeUrls = urls.filter(u => u.active);

    log.push(`${activeUrls.length} aktive URLs gefunden`);

    if (activeUrls.length === 0) {
      return res.status(200).json({ success: true, log, imported: 0 });
    }

    let importedCount = 0;
    let skippedCount = 0;
    const updatedUrls = [...urls];

    for (const entry of activeUrls) {
      try {
        log.push(`Verarbeite: ${entry.url}`);
        const data = await scrapeUrl(entry.url);

        if (!data) {
          log.push(`  → Fehler: Keine Daten erhalten`);
          skippedCount++;
          continue;
        }

        // Prüfen ob Rezept schon existiert (anhand URL)
        const existingIds = await redis("smembers", "recipe_ids");
        const urlKey = `recipe_url:${encodeURIComponent(entry.url)}`;
        const existingId = await redis("get", urlKey);

        if (existingId) {
          log.push(`  → Bereits vorhanden, übersprungen`);
          skippedCount++;
        } else {
          // Rezept speichern
          const recipe = {
            id: `cron-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
            title: data.name || "Importiertes Rezept",
            description: data.description || "",
            sourceName: new URL(entry.url).hostname.replace(/^www\./, ""),
            sourceUrl: entry.url,
            category: "Hauptgericht",
            difficulty: "Mittel",
            servings: data.servings || 4,
            totalTime: data.cookTime || 30,
            tags: [...(data.tags || []).map(t => t.toLowerCase()), "auto-import"],
            icon: "🍽️",
            ingredients: data.ingredients || [],
            instructions: data.instructions || [],
            image: data.image || null,
            importedAt: new Date().toISOString(),
            isAutoImport: true
          };

          await saveRecipe(recipe);
          await redisPost(["set", urlKey, recipe.id]);

          log.push(`  → Importiert: „${recipe.title}"`);
          importedCount++;
        }

        // lastImportedAt aktualisieren
        const urlIndex = updatedUrls.findIndex(u => u.url === entry.url);
        if (urlIndex !== -1) {
          updatedUrls[urlIndex].lastImportedAt = new Date().toISOString();
        }

      } catch (err) {
        log.push(`  → Fehler bei ${entry.url}: ${err.message}`);
        skippedCount++;
      }
    }

    // Aktualisierte URL-Liste speichern
    await redisPost(["set", "import_urls", JSON.stringify(updatedUrls)]);

    // Cron-Log speichern (letzten 5 behalten)
    const cronLog = {
      startedAt,
      finishedAt: new Date().toISOString(),
      imported: importedCount,
      skipped: skippedCount,
      log
    };

    const existingLogs = await redis("get", "cron_logs");
    const logs = existingLogs ? JSON.parse(existingLogs) : [];
    logs.unshift(cronLog);
    await redisPost(["set", "cron_logs", JSON.stringify(logs.slice(0, 5))]);

    return res.status(200).json({
      success: true,
      imported: importedCount,
      skipped: skippedCount,
      log
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, log });
  }
}
