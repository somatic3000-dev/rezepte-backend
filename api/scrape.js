// api/scrape.js — Vercel Serverless Function
// Lädt eine Rezept-URL, extrahiert strukturierte Daten (JSON-LD / Open Graph / Fallback)

export default async function handler(req, res) {
  // CORS-Header: erlaubt Zugriff von deiner GitHub Pages App
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Parameter 'url' fehlt." });
  }

  let targetUrl;
  try {
    targetUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: "Ungültige URL." });
  }

  // HTML der Rezeptseite laden
  let html;
  try {
    const response = await fetch(targetUrl.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; RecipeFinderBot/1.0; +https://github.com/somatic3000-dev/rezepte-app)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return res
        .status(502)
        .json({ error: `Seite nicht erreichbar (HTTP ${response.status})` });
    }

    html = await response.text();
  } catch (err) {
    return res
      .status(502)
      .json({ error: `Fehler beim Laden der Seite: ${err.message}` });
  }

  // JSON-LD Rezeptdaten extrahieren
  const recipe = extractRecipe(html, targetUrl.toString());

  return res.status(200).json(recipe);
}

// ─── Extraktion ────────────────────────────────────────────────────────────────

function extractRecipe(html, sourceUrl) {
  // 1) JSON-LD suchen
  const jsonLdMatches = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];

  for (const match of jsonLdMatches) {
    try {
      const data = JSON.parse(match[1]);
      const recipeNode = findRecipeNode(data);
      if (recipeNode) {
        return normalizeJsonLd(recipeNode, sourceUrl);
      }
    } catch {
      // weiter versuchen
    }
  }

  // 2) Fallback: Meta-Tags / Open Graph
  return extractFallback(html, sourceUrl);
}

function findRecipeNode(data) {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findRecipeNode(item);
      if (found) return found;
    }
  }
  if (data["@type"] === "Recipe") return data;
  if (data["@graph"]) return findRecipeNode(data["@graph"]);
  return null;
}

function normalizeJsonLd(r, sourceUrl) {
  const ingredients = (r.recipeIngredient || []).map((i) => String(i).trim());
  const instructions = extractInstructions(r.recipeInstructions);
  const cookTime = parseDuration(r.totalTime || r.cookTime || r.prepTime);
  const servings = parseServings(r.recipeYield);
  const tags = [
    ...(r.recipeCategory ? [].concat(r.recipeCategory) : []),
    ...(r.recipeCuisine ? [].concat(r.recipeCuisine) : []),
    ...(r.keywords ? String(r.keywords).split(",").map((k) => k.trim()) : []),
  ].filter(Boolean).slice(0, 8);

  return {
    success: true,
    source: "json-ld",
    name: r.name || "Rezept ohne Titel",
    description: stripHtml(r.description || ""),
    ingredients,
    instructions,
    cookTime,
    servings,
    tags,
    image: extractImage(r.image),
    sourceUrl,
  };
}

function extractInstructions(raw) {
  if (!raw) return [];
  if (typeof raw === "string") return [raw.trim()];
  if (Array.isArray(raw)) {
    return raw.flatMap((step) => {
      if (typeof step === "string") return [step.trim()];
      if (step["@type"] === "HowToStep") return [stripHtml(step.text || step.name || "")];
      if (step["@type"] === "HowToSection") return extractInstructions(step.itemListElement);
      return [];
    }).filter(Boolean);
  }
  return [];
}

function extractImage(img) {
  if (!img) return null;
  if (typeof img === "string") return img;
  if (Array.isArray(img)) return extractImage(img[0]);
  return img.url || img.contentUrl || null;
}

function parseDuration(iso) {
  if (!iso) return null;
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return null;
  return (parseInt(m[1] || 0) * 60) + parseInt(m[2] || 0);
}

function parseServings(raw) {
  if (!raw) return 4;
  const s = Array.isArray(raw) ? raw[0] : raw;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0]) : 4;
}

function stripHtml(s) {
  return String(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// ─── Fallback ──────────────────────────────────────────────────────────────────

function extractFallback(html, sourceUrl) {
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || "Unbekanntes Rezept";
  const desc =
    html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)?.[1] ||
    html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/i)?.[1] ||
    "";
  const image =
    html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)?.[1] || null;

  return {
    success: true,
    source: "fallback",
    name: title,
    description: desc.trim(),
    ingredients: [],
    instructions: [],
    cookTime: null,
    servings: 4,
    tags: [],
    image,
    sourceUrl,
    warning:
      "Auf dieser Seite wurden keine strukturierten Rezeptdaten (JSON-LD) gefunden. Zutaten und Schritte konnten nicht automatisch extrahiert werden.",
  };
}
