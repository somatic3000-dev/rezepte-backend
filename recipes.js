// api/recipes.js – Rezepte aus Upstash laden und speichern
// GET  /api/recipes        → alle gespeicherten Rezepte laden
// POST /api/recipes        → ein Rezept speichern

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // GET – alle Rezepte laden
  if (req.method === "GET") {
    try {
      const ids = await redis("smembers", "recipe_ids");
      if (!ids || ids.length === 0) return res.status(200).json({ recipes: [] });

      const pipeline = ids.map(id => ["get", `recipe:${id}`]);
      const response = await fetch(UPSTASH_URL + "/pipeline", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${UPSTASH_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pipeline)
      });
      const results = await response.json();
      const recipes = results
        .map(r => {
          try { return JSON.parse(r.result); } catch { return null; }
        })
        .filter(Boolean);

      return res.status(200).json({ recipes });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST – Rezept speichern
  if (req.method === "POST") {
    try {
      const recipe = req.body;
      if (!recipe || !recipe.id) return res.status(400).json({ error: "Ungültiges Rezept" });

      await redisPost(["set", `recipe:${recipe.id}`, JSON.stringify(recipe)]);
      await redisPost(["sadd", "recipe_ids", recipe.id]);

      return res.status(200).json({ success: true, id: recipe.id });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Methode nicht erlaubt" });
}
