// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// Храним показанные новости по ключу запроса
const shownByKey = new Map();

app.use(cors());
app.use(express.json({ type: "/", limit: "1mb" }));

// Health-check
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// Прокси для OpenRouter
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res
      .status(400)
      .type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    const allow = [
      "authorization",
      "content-type",
      "x-title",
      "http-referer",
      "referer",
      "accept"
    ];
    const headersToForward = {};
    for (const k of allow) {
      if (req.headers[k]) headersToForward[k] = req.headers[k];
    }
    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    const bodyString =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString
    });

    const rawText = await upstream.text();
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data?.choices?.[0]?.text) {
        out = data.choices[0].text;
      } else if (typeof data === "string") {
        out = data;
      }
    } catch {}
    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res
      .status(500)
      .type("text/plain; charset=utf-8")
      .send("Ошибка на прокси-сервере");
  }
});

// Новости GNews
app.get("/gnews", async (req, res) => {
  try {
    const cat = (req.query.cat ?? "").trim();
    const qParam = (req.query.q ?? "").trim();
    const lang = (req.query.lang ?? "ru").trim();
    const country = (req.query.country ?? "ru").trim();
    const max = Number(req.query.max ?? "5") || 5;
    const mode = (req.query.mode ?? "text").trim();

    const token =
      process.env.GNEWS_TOKEN || (req.query.token ?? "").trim();
    if (!token) {
      return res
        .status(400)
        .type("text/plain; charset=utf-8")
        .send("Ошибка: нет API-ключа.");
    }

    let endpoint = "search";
    let query = qParam || cat;
    const normCat = cat.toLowerCase();
    if (
      normCat === "гз" ||
      normCat === "главные заголовки" ||
      (!qParam && cat === "")
    ) {
      endpoint = "top-headlines";
      query = "";
    }

    const makeParams = (pageNum) => {
      const p = new URLSearchParams();
      p.set("lang", lang);
      p.set("country", country);
      p.set("max", String(max));
      p.set("page", String(pageNum));
      p.set("token", token);
      if (endpoint === "search" && query) p.set("q", query);
      return p;
    };

    if (mode === "raw") {
      const page = Math.floor(Math.random() * 75) + 1;
      const params = makeParams(page);
      const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params}`;
      const upstream = await fetch(finalUrl, { headers: { Accept: "application/json" } });
      const text = await upstream.text();
      return res
        .status(upstream.ok ? 200 : upstream.status)
        .type("application/json; charset=utf-8")
        .send(text);
    }

    const key = `${endpoint}|${query}|${cat}|${lang}|${country}`;
    if (!shownByKey.has(key)) shownByKey.set(key, new Set());
    const seen = shownByKey.get(key);

    let articles = [];
    let tries = 0;
    while (articles.length === 0 && tries < 10) {
      tries++;
      const page = Math.floor(Math.random() * 75) + 1;
      const params = makeParams(page);
      const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params}`;
      const upstream = await fetch(finalUrl, { headers: { Accept: "application/json" } });
      if (!upstream.ok) break;

      let data;
      try {
        data = await upstream.json();
      } catch {
        break;
      }

      const list = Array.isArray(data?.articles) ? data.articles : [];
      const fresh = list.filter(a => a?.url && !seen.has(a.url));
      if (fresh.length > 0) {
        articles = fresh.slice(0, max);
        for (const a of articles) seen.add(a.url);
      }
    }

    let out = "";
    if (articles.length === 0) {
      shownByKey.delete(key);
      out = "Новости не найдены или все уже были показаны.";
    } else {
      out = articles
        .map((a, i) => {
          const title = a?.title ?? "Без заголовка";
          const src = a?.source?.name ? ` — ${a.source.name}` : "";
          return `${i + 1}. ${title}${src}\n${a.url ?? ""}`;
        })
        .join("\n\n");
    }

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res
      .status(500)
      .type("text/plain; charset=utf-8")
      .send("Ошибка при запросе к GNews");
  }
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});






