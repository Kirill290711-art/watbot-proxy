// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// CORS и парсинг JSON
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * 1) Главный прокси для OpenRouter (POST /?url=...)
 *    — отдаёт чистый текст для Watbot (без JSON-обёрток)
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

    // Вытаскиваем «чистый текст» из chat-completions
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
    } catch {
      // не JSON — отдаём как есть
    }

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-store")
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
 * 2) GNews с антиповтором страниц (GET /gnews)
 *
 * Параметры:
 *  - cat: категория (строка). "ГЗ" → top-headlines
 *  - q:   явный текст запроса (перебивает cat, кроме "ГЗ")
 *  - lang, country, max: по умолчанию ru, ru, 5
 *  - token: если не задан GNEWS_TOKEN в переменных окружения
 *  - mode=raw → вернуть сырой JSON; иначе — человекочитаемый список
 *
 * Антиповтор:
 *  - для каждой «сценарной связки» (endpoint+query+lang+country) помним последнюю страницу;
 *  - новая страница: случайная 1..75, но не равная предыдущей для этой связки.
 */

// в памяти: последняя страница по ключу (endpoint|query|lang|country)
const lastPageMap = new Map();

function keyFor(endpoint, query, lang, country) {
  return `${endpoint}|${query || ""}|${lang}|${country}`;
}

function pickRandomPageExcept(prev, min = 1, max = 75) {
  if (max <= min) return min;
  let p;
  do {
    p = Math.floor(Math.random() * (max - min + 1)) + min; // [min..max]
  } while (p === prev);
  return p;
}

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

    // "Главные заголовки"
    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines";
      query = ""; // для top-headlines q не обязателен
    }

    // Собираем параметры запроса
    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

    // Выбираем страницу с антиповтором для конкретной связки
    const key = keyFor(endpoint, query, lang, country);
    const prevPage = lastPageMap.get(key) ?? null;
    const page = pickRandomPageExcept(prevPage, 1, 75);
    lastPageMap.set(key, page);
    params.set("page", String(page));

    if (endpoint === "search") {
      if (!query) {
        return res
          .status(400)
          .type("text/plain; charset=utf-8")
          .send(
            'Ошибка: параметр q обязателен для /search. Передай ?q=... или ?cat=... (кроме "ГЗ").'
          );
      }
      // URLSearchParams сам закодирует Unicode
      params.set("q", query);
    }

    // анти‑кэш, чтобы CDN не возвращал одно и то же
    params.set("_t", Math.random().toString(36).slice(2));

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

    const upstream = await fetch(finalUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .type("text/plain; charset=utf-8")
        .send(text);
    }

    if (mode === "raw") {
      res
        .type("application/json; charset=utf-8")
        .set("Cache-Control", "no-store")
        .send(text);
      return;
    }

    // Человекочитаемый список
    let out = "";
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.articles) ? data.articles : [];
      if (list.length === 0) {
        out = "Новости не найдены.";
      } else {
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
      // если формат внезапно не JSON — отдадим как есть
      out = text;
    }

    res
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(out);
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
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});
