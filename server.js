// src/server.js
import express from "express";
import cors from "cors";

const app = express();

/* ======================= Общие настройки ======================= */

// CORS и парсинг JSON (на любой content-type — важно для Watbot)
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Неболтливые логи (поставь LOG_LEVEL=silent в Render, если не хочешь видеть логи)
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const log = (...args) => LOG_LEVEL !== "silent" && console.log(...args);

/* ======================= Служебка ======================= */

app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// Утилита: случайное целое [min, max]
function randInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/* =================================================================
 * 1) Прокси-эндпоинт для OpenRouter (POST /?url=...)
 *    — прокидываем тело/заголовки как есть,
 *    — вынимаем «чистый текст» из ответов chat-completions.
 * ================================================================ */
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res
      .status(400)
      .type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    log("➡ INCOMING:", {
      method: req.method,
      url: targetUrl,
      bodyType: typeof req.body,
    });

    // Пробрасываем только безопасные/нужные заголовки
    const allowHeaders = [
      "authorization",
      "content-type",
      "x-title",
      "http-referer",
      "referer",
      "accept",
      // Иногда полезны доп. заголовки организации/маршрутизации
      "x-organization",
      "x-router",
    ];
    const headersToForward = {};
    for (const h of allowHeaders) {
      const v = req.headers[h];
      if (v) headersToForward[h] = v;
    }
    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    // Тело запроса
    const bodyString =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});

    // Запрос к апстриму
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString,
    });

    const rawText = await upstream.text();
    log("⬅ UPSTREAM STATUS:", upstream.status);
    log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    // Если апстрим вернул ошибку — пробрасываем текст ошибки как есть,
    // но в text/plain, чтобы Watbot показал его аккуратно.
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .type("text/plain; charset=utf-8")
        .send(rawText);
    }

    // Пытаемся извлечь «чистый текст» из JSON ответов моделей
    let out = rawText;
    try {
      const data = JSON.parse(rawText);

      // Ветви под разные семейства API
      if (data?.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data?.choices?.[0]?.text) {
        out = data.choices[0].text;
      } else if (typeof data === "string") {
        out = data;
      } else {
        // Если это не chat-completions (например, tool-calls) — отдаём сырой JSON,
        // но в text/plain, чтобы Watbot не захлестнуло форматирование.
        out = rawText;
      }
    } catch {
      // не JSON — отдаём как есть
      out = rawText;
    }

    return res.status(200).type("text/plain; charset=utf-8").send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    return res
      .status(500)
      .type("text/plain; charset=utf-8")
      .send("Ошибка на прокси-сервере");
  }
});

/* =================================================================
 * 2) Новости GNews (GET /gnews)
 *    Параметры:
 *      - cat: строка. Если "ГЗ" → top-headlines (без q)
 *      - q:   строка, ручной запрос (если есть — важнее cat)
 *      - lang, country, max: опционально (ru, ru, 5)
 *      - token: опционально (или GNEWS_TOKEN в env)
 *      - mode: "text" (по умолчанию) | "raw"
 *      - page: опционально. Если не задан — выбирается случайная страница 1..75
 * ================================================================ */
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
          'Ошибка: нет API-ключа. Добавь переменную окружения GNEWS_TOKEN в Render или передай ?token=...'
        );
    }

    // Определяем эндпоинт и запрос
    let endpoint = "search";
    let query = qParam || cat;

    // "ГЗ" → top-headlines (без q)
    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines";
    }

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

    // Рандомная страница 1..75 (если пользователь не задал свою)
    const pageFromUser = Number(req.query.page);
    const page =
      Number.isFinite(pageFromUser) && pageFromUser >= 1
        ? pageFromUser
        : randInt(1, 75);
    params.set("page", String(page));

    // Для search параметр q обязателен
    if (endpoint === "search") {
      if (!query) {
        return res
          .status(400)
          .type("text/plain; charset=utf-8")
          .send(
            'Ошибка: параметр q обязателен для /search. Передай ?q=... или ?cat=... (кроме "ГЗ").'
          );
      }
      // URLSearchParams сам корректно кодирует Юникод
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    // Чтобы токен не светился в логах:
    log("🔎 GNEWS URL:", finalUrl.replace(token, "******"));

    const upstream = await fetch(finalUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    const text = await upstream.text();

    if (!upstream.ok) {
      // пробрасываем ответ GNews как есть (text/plain)
      return res.status(upstream.status).type("text/plain; charset=utf-8").send(text);
    }

    if (mode === "raw") {
      return res.type("application/json; charset=utf-8").send(text);
    }

    // Преобразуем в удобный список для чата
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
      // На всякий случай — просто вернём оригинальный текст
      out = text;
    }

    return res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    return res
      .status(500)
      .type("text/plain; charset=utf-8")
      .send("Ошибка при запросе к GNews");
  }
});

/* ======================= Запуск ======================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});




