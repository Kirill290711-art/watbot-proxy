// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// CORS и парсинг JSON (на всякий случай для любого content-type)
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * 1) Главный прокси для OpenRouter (POST /?url=...)
 *    — оставил как было, текст ответа вычищается для Watbot
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

    // пробрасываем только нужные заголовки
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
    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    // извлекаем чистый текст из chat-completions
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
      else if (typeof data === "string") out = data;
    } catch {
      // это не JSON — отдаём как есть
    }

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка на прокси-сервере");
  }
});

/**
 * 2) Специальный маршрут для GNews (GET /gnews)
 *    Параметры:
 *      - cat: строка. Если "ГЗ" → top-headlines, иначе search по cat (или q)
 *      - q:   необязательный ручной запрос. Если есть — берём его вместо cat
 *      - lang, country, max: необязательные (по умолчанию ru, ru, 5)
 *      - token: необязательный, если не задали GNEWS_TOKEN в переменных окружения
 *      - mode=raw → вернуть сырой JSON (иначе отдадим список заголовков текстом)
 */
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
      return res
        .status(400)
        .type("text/plain; charset=utf-8")
        .send('Ошибка: нет API-ключа. Добавь переменную окружения GNEWS_TOKEN в Render или передавай ?token=...');
    }

    // определяем эндпоинт и запрос
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

    if (endpoint === "search") {
      if (!query) {
        return res
          .status(400)
          .type("text/plain; charset=utf-8")
          .send('Ошибка: параметр q обязателен для /search. Передай ?q=... или ?cat=... (кроме "ГЗ").');
      }
      // URLSearchParams сам закодирует Unicode
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "****"));

    const upstream = await fetch(finalUrl, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // пробрасываем текст ошибки как есть (чтобы видеть ответ GNews)
      return res.status(upstream.status).type("text/plain; charset=utf-8").send(text);
    }

    // режим: сырой JSON (если нужен)
    if (mode === "raw") {
      res.type("application/json; charset=utf-8").send(text);
      return;
    }

    // обычный режим: делаем человекочитаемый список заголовков
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
      // если вдруг формат изменился — отдадим как есть
      out = text;
    }

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка при запросе к GNews");
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

