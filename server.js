// src/server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();

// --- Общие настройки ---
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// --- Проверка живости ---
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// ----------------- 1) Прокси для ChatGPT / OpenRouter -----------------
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    const allow = ["authorization", "content-type", "x-title", "http-referer", "referer", "accept"];
    const headersToForward = {};
    for (const k of allow) {
      if (req.headers[k]) headersToForward[k] = req.headers[k];
    }
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
      else if (typeof data === "string") out = data;
    } catch {
      // не JSON — отдаем как есть
    }

    res.status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8")
      .send("Ошибка на прокси-сервере");
  }
});

// ----------------- 2) Новости GNews -----------------
app.get("/gnews", async (req, res) => {
  try {
    const cat = (req.query.cat ?? "").toString().trim();
    const qParam = (req.query.q ?? "").toString().trim();
    const lang = (req.query.lang ?? "ru").toString();
    const country = (req.query.country ?? "ru").toString();
    const max = (req.query.max ?? "5").toString();
    const mode = (req.query.mode ?? "text").toString();

    const token = process.env.GNEWS_TOKEN || (req.query.token ?? "").toString();
    if (!token) {
      return res.status(400).type("text/plain; charset=utf-8")
        .send('Ошибка: нет API-ключа. Добавь GNEWS_TOKEN в Render или передавай ?token=...');
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
        return res.status(400).type("text/plain; charset=utf-8")
          .send('Ошибка: параметр q обязателен для /search.');
      }
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    const upstream = await fetch(finalUrl, { method: "GET" });

    const text = await upstream.text();
    if (!upstream.ok) return res.status(upstream.status).send(text);

    if (mode === "raw") {
      res.type("application/json; charset=utf-8").send(text);
      return;
    }

    let out = "";
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.articles) ? data.articles : [];
      if (list.length === 0) out = "Новости не найдены.";
      else {
        out = list
          .slice(0, Number(max) || 5)
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

// ----------------- 3) Словарь Wiktionary -----------------
app.get("/dict", async (req, res) => {
  const word = (req.query.word ?? "").toString().trim();
  if (!word) {
    return res.status(400).type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?word=...");
  }

  try {
    const url = `https://ru.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=${encodeURIComponent(word)}&format=json`;
    const response = await fetch(url);
    const data = await response.json();

    const pages = data.query.pages;
    const firstPage = Object.values(pages)[0];
    const extract = firstPage.extract || "Не найдено.";

    // Простейший парсинг
    const lines = extract.split("\n").map(l => l.trim()).filter(l => l);
    let partOfSpeech = "";
    let definition = "";
    let synonyms = [];
    let examples = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      if (!partOfSpeech && /часть речи/i.test(lines[i])) {
        partOfSpeech = lines[i + 1] || "";
      }
      if (!definition && /^[0-9]+\./.test(lines[i])) {
        definition = lines[i].replace(/^[0-9]+\.\s*/, "");
      }
      if (/синонимы/i.test(lines[i])) {
        synonyms = (lines[i + 1] || "").split(/[;,]/).map(s => s.trim());
      }
      if (/пример/i.test(lines[i]) || lines[i].startsWith("♦")) {
        examples.push(lines[i + 1] || "");
      }
    }

    const out = `📚 ${word}
Часть речи: ${partOfSpeech || "—"}
Толкование: ${definition || "—"}
Синонимы: ${synonyms.length ? synonyms.join(", ") : "—"}
Пример 1: ${examples[0] || "—"}
Пример 2: ${examples[1] || "—"}`;

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 DICT ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8")
      .send("Ошибка при запросе к Викисловарю");
  }
});

// --- Запуск сервера ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

