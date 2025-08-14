// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// Память для уже показанных новостей (общая для всех запросов)
const shownNewsUrls = new Set();

// CORS и парсинг JSON
app.use(cors());
app.use(express.json({ type: "/", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * 1) Главный прокси для OpenRouter (POST /?url=...)
 */
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res
      .status(400)
      .type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    console.log("➡ INCOMING:", {
      method: req.method,
      url: targetUrl,
      headers: req.headers,
      bodyType: typeof req.body
    });

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
    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content)
        out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
      else if (typeof data === "string") out = data;
    } catch {
      // не JSON
    }

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

/**
 * 2) Специальный маршрут для GNews (GET /gnews)
 */
app.get("/gnews", async (req, res) => {
  try {
    const cat = (req.query.cat ?? "").toString().trim();
    const qParam = (req.query.q ?? "").toString().trim();
    const lang = (req.query.lang ?? "ru").toString();
    const country = (req.query.country ?? "ru").toString();
    const max = (req.query.max ?? "5").toString();
    const mode = (req.query.mode ?? "text").toString();

    const token =
      process.env.GNEWS_TOKEN || (req.query.token ?? "").toString();
    if (!token) {
      return res
        .status(400)
        .type("text/plain; charset=utf-8")
        .send(
          'Ошибка: нет API-ключа. Добавь переменную окружения GNEWS_TOKEN или передавай ?token=...'
        );
    }

    let endpoint = "search";
    let query = qParam || cat;

    // Если категория — главные заголовки, то q не нужен
    if (cat.toLowerCase() === "главные заголовки") {
      endpoint = "top-headlines";
      query = "";
    }

    let articles = [];
    let attempts = 0;

    // Пробуем до 10 раз найти страницу с новыми новостями
    while (articles.length === 0 && attempts < 10) {
      attempts++;

      const page = Math.floor(Math.random() * 75) + 1;

      const params = new URLSearchParams();
      params.set("lang", lang);
      params.set("country", country);
      params.set("max", max);
      params.set("page", page);
      params.set("token", token);
      if (endpoint === "search" && query) {
        params.set("q", query);
      }

      const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
      console.log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

      const upstream = await fetch(finalUrl, {
        method: "GET",
        headers: { Accept: "application/json" }
      });
      if (!upstream.ok) break;

      const data = await upstream.json();
      if (Array.isArray(data?.articles)) {
        const fresh = data.articles.filter(a => !shownNewsUrls.has(a.url));
        if (fresh.length > 0) {
          articles = fresh;
          fresh.forEach(a => shownNewsUrls.add(a.url));
        }
      }
    }

    let out = "";
    if (articles.length === 0) {
      shownNewsUrls.clear();
      out = "Новости не найдены или все уже были показаны.";
    } else {
      out = articles
        .slice(0, Number(max) || 5)
        .map((a, i) => {
          const title = a?.title ?? "Без заголовка";
          const src = a?.source?.name ? ` — ${a.source.name}` : "";
          const url = a?.url ?? "";
          return `${i + 1}. ${title}${src}\n${url}`;
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

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}





