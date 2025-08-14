// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * 1) Прокси для OpenRouter (ChatGPT)
 */
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("Ошибка: укажи параметр ?url=");
  }

  try {
    const allow = ["authorization", "content-type", "x-title", "http-referer", "referer", "accept"];
    const headersToForward = {};
    for (const k of allow) if (req.headers[k]) headersToForward[k] = req.headers[k];
    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    const bodyString = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString
    });

    const rawText = await upstream.text();
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
    } catch {}

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).send("Ошибка на прокси-сервере");
  }
});

/**
 * 2) Новости (GNews API)
 */
app.get("/gnews", async (req, res) => {
  try {
    const cat = (req.query.cat ?? "").trim();
    const qParam = (req.query.q ?? "").trim();
    const lang = req.query.lang ?? "ru";
    const country = req.query.country ?? "ru";
    const max = req.query.max ?? "5";
    const mode = req.query.mode ?? "text";

    const token = process.env.GNEWS_TOKEN || req.query.token;
    if (!token) {
      return res.status(400).send("Ошибка: нет API-ключа GNews");
    }

    let endpoint = "search";
    let query = qParam || cat;
    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines";
    }

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

    if (endpoint === "search") {
      if (!query) {
        return res.status(400).send("Ошибка: параметр q обязателен для поиска");
      }
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    const upstream = await fetch(finalUrl);
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).send(text);
    }

    if (mode === "raw") {
      return res.type("application/json; charset=utf-8").send(text);
    }

    let out = "";
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.articles) ? data.articles : [];
      if (list.length === 0) out = "Новости не найдены.";
      else {
        out = list
          .slice(0, Number(max))
          .map((a, i) => {
            const title = a?.title ?? "Без заголовка";
            const src = a?.source?.name ? ` — ${a.source.name}` : "";
            const url = a?.url ?? "";
            return `${i + 1}. ${title}${src}\n${url}`;
          })
          .join("\n\n");
      }
    } catch {
      out = text;
    }

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res.status(500).send("Ошибка при запросе к GNews");
  }
});

/**
 * 3) Словарь (Wiktionary API)
 */
app.get("/dict", async (req, res) => {
  const word = (req.query.word ?? "").trim();
  if (!word) {
    return res.status(400).send("Ошибка: укажи ?word=...");
  }

  try {
    const url = `https://ru.wiktionary.org/w/api.php?action=query&prop=extracts&titles=${encodeURIComponent(word)}&format=json&explaintext=1`;
    const upstream = await fetch(url);
    const data = await upstream.json();

    const pages = data?.query?.pages || {};
    const page = Object.values(pages)[0];
    if (!page?.extract) {
      return res.status(404).send("Слово не найдено");
    }

    // Здесь нужно будет сделать парсинг, я упрощаю пример:
    const partOfSpeech = "—"; // можно извлечь из текста
    const definition = page.extract.split("\n")[1] || "—";
    const synonyms = "—"; // нет в API напрямую
    const example1 = "—";
    const example2 = "—";

    const out = `📚 ${word}
Часть речи: ${partOfSpeech}
Толкование: ${definition}
Синонимы: ${synonyms}
Пример 1: ${example1}
Пример 2: ${example2}`;

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 DICT ERROR:", err);
    res.status(500).send("Ошибка при запросе к словарю");
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

