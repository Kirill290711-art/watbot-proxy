// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// CORS и парсинг JSON (на всякий случай для любого content-type)
app.use(cors());
app.use(express.json({ type: "/", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * 1) Главный прокси для OpenRouter (POST /?url=...)
 *    — пробрасывает запрос и возвращает «чистый текст» ответа,
 *      чтобы Watbot мог сразу печатать его в чат.
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

    // Пробрасываем только нужные заголовки
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

    // Достаём «голый текст» из chat-completions
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
 * 2) GNews (GET /gnews)
 *
 * Параметры:
 *   - cat: строка. Если "ГЗ" → top-headlines, иначе search по cat (или по q).
 *   - q:   необязательный ручной запрос (если есть — используем его вместо cat).
 *   - lang, country, max: по умолчанию ru, ru, 5 (max — сколько показать).
 *   - token: если не задан GNEWS_TOKEN в переменных окружения.
 *   - mode=raw → вернуть сырой JSON без форматирования.
 *   - pageMax: верхняя граница для случайной страницы (по умолчанию 75).
 *
 * Алгоритм разнообразия:
 *   1) Всегда добавляем случайную page в диапазоне [1..pageMax].
 *   2) Из пришедшего массива статей делаем случайную выборку нужного размера
 *      без повторов (shuffle + slice).
 */
app.get("/gnews", async (req, res) => {
  try {
    const cat = (req.query.cat ?? "").toString().trim();
    const qParam = (req.query.q ?? "").toString().trim();
    const lang = (req.query.lang ?? "ru").toString();
    const country = (req.query.country ?? "ru").toString();
    const maxToShow = Math.max(1, parseInt(req.query.max ?? "5", 10));
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

    // Какой эндпоинт используем
    let endpoint = "search";
    let query = qParam || cat;
    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines"; // главные заголовки
    }

    // Случайная страница (по умолчанию 1..75)
    const pageMax = Math.max(1, parseInt(req.query.pageMax ?? "75", 10));
    const page = Math.floor(Math.random() * pageMax) + 1;

    // Собираем параметры запроса к GNews
    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    // Просим чутка больше статей, чем покажем, чтобы было из чего выбирать.
    // Если у тебя жёстко нужно ровно max выкачивать — можно заменить на maxToShow.
    const fetchMax = Math.max(maxToShow, 15); // пул для случайной выборки
    params.set("max", String(fetchMax));
    params.set("page", String(page));
    params.set("token", token);

    if (endpoint === "search") {
      if (!query) {
        return res
          .status(400)
          .type("text/plain; charset=utf-8")
          .send(
            'Ошибка: параметр q обязателен для /search. Передай ?q=... или ?cat=... (кроме "ГЗ").'
          );
      }
      params.set("q", query); // URLSearchParams сам закодирует Unicode
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    // Не светим токен в логах
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "<TOKEN>"));

    const upstream = await fetch(finalUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Пробрасываем текст ошибки GNews (так понятнее, что не так)
      return res
        .status(upstream.status)
        .type("text/plain; charset=utf-8")
        .send(text);
    }

    if (mode === "raw") {
      res.type("application/json; charset=utf-8").send(text);
      return;
    }

    // Формируем человекочитаемый текст и СЛУЧАЙНУЮ выборку статей
    let out = "";
    try {
      const data = JSON.parse(text);
      const all = Array.isArray(data?.articles) ? data.articles : [];

      // Удаляем возможные дубли по URL
      const byUrl = new Map();
      for (const a of all) {
        const u = (a?.url ?? "").trim();
        if (!byUrl.has(u) && u) byUrl.set(u, a);
      }
      const pool = Array.from(byUrl.values());

      // Fisher–Yates shuffle
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }

      const picked = pool.slice(0, maxToShow);

      if (picked.length === 0) {
        out = "Новости не найдены.";
      } else {
        out = picked
          .map((a, i) => {
            const title = a?.title ?? "Без заголовка";
            const src = a?.source?.name ? ` — ${a.source.name}` : "";
            const url = a?.url ?? "";
            return `${i + 1}. ${title}${src}\n${url}`;
          })
          .join("\n\n");
      }
    } catch {
      // Если формат внезапно изменился — отдаём как есть
      out = text;
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
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});




