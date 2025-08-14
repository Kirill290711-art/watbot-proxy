// src/server.js
import express from "express";
import cors from "cors";

// Node 18+ уже имеет fetch глобально
const app = express();

// ===== Общие миддлы =====
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" })); // парсим JSON даже при странных content-type

// ===== Healthcheck =====
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// ===== Утилиты =====
const DEBUG = !!process.env.DEBUG;

function log(...args) {
  if (DEBUG) console.log(...args);
}

// надёжный декодер \uXXXX и прочего
function decodeUnicode(maybe) {
  if (typeof maybe !== "string") return maybe;
  try {
    // декод \uXXXX
    const unescaped = maybe.replace(/\\u([0-9a-fA-F]{4})/g, (_, g) =>
      String.fromCharCode(parseInt(g, 16))
    );
    // декод %xx, если вдруг встретится
    try {
      return decodeURIComponent(unescaped);
    } catch {
      return unescaped;
    }
  } catch {
    return maybe;
  }
}

// ===== 1) Главный прокси OpenRouter (POST /?url=...) =====
// Отдаём "чистый текст" для Watbot (без JSON-обёртки)
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
    log("⬅ UPSTREAM STATUS:", upstream.status);
    log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    // Пытаемся вынуть «чистый текст» из известных форматов
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data?.choices?.[0]?.text) {
        out = data.choices[0].text;
      } else if (typeof data === "string") {
        out = data;
      } else {
        // оставляем как есть — пусть Render вернёт тело (как ты и использовал)
        out = rawText;
      }
    } catch {
      // не JSON — отдаём как есть
      out = rawText;
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

// ===== 2) Новости GNews (GET /gnews) =====
// Параметры:
//   - cat: категория (строка). "ГЗ" → top-headlines
//   - q:   явный текст запроса (перебивает cat, кроме "ГЗ")
//   - lang, country, max: по умолчанию ru, ru, 5
//   - token: если не задан GNEWS_TOKEN в env
//   - page: можно явно передать, иначе каждый раз RANDOM 1..75
//   - mode=raw → сырой JSON; иначе — человекочитаемый текст
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
      query = ""; // у top-headlines q не нужен
    }

    // Страница: если не передали — каждый запрос случайная 1..75
    const page =
      Number(req.query.page) > 0
        ? Number(req.query.page)
        : Math.floor(Math.random() * 75) + 1;

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
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

    // Анти-кэш, чтобы CDN не вернуть старое
    params.set("_t", Math.random().toString(36).slice(2));

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

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
      // сырой JSON — для сложных интеграций
      return res
        .type("application/json; charset=utf-8")
        .set("Cache-Control", "no-store")
        .send(text);
    }

    // Человекочитаемый список (для «выводить тело ответа в чат»)
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
      out = text; // если внезапно не JSON
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

// ===== 3) Словарь Яндекс (GET /yadict) =====
// Параметры:
//   - word: искомое слово (обязательно)
//   - token: опционально; если не передали — берём из env YADICT_TOKEN
// Возвращает ПЛОСКИЙ JSON для простого «соотношения переменных» в Watbot:
//   { слово, частьРечи, толкование, синонимы, пример1, пример2 }
app.get("/yadict", async (req, res) => {
  try {
    const word = (req.query.word ?? "").toString().trim();
    if (!word) {
      return res
        .status(400)
        .type("application/json; charset=utf-8")
        .send(JSON.stringify({ error: "Не указано слово (?word=...)" }));
    }

    const apiKey =
      process.env.YADICT_TOKEN || (req.query.token ?? "").toString();
    if (!apiKey) {
      return res
        .status(500)
        .type("application/json; charset=utf-8")
        .send(JSON.stringify({ error: "API ключ Яндекс.Словаря не настроен" }));
    }

    const url =
      `https://dictionary.yandex.net/api/v1/dicservice.json/lookup` +
      `?key=${encodeURIComponent(apiKey)}` +
      `&lang=ru-ru` +
      `&text=${encodeURIComponent(word)}`;

    log("📖 YADICT URL:", url.replace(apiKey, "[HIDDEN]"));

    const upstream = await fetch(url, { method: "GET" });
    const data = await upstream.json();

    // базовая распаковка с защитой от отсутствующих полей
    const def = Array.isArray(data?.def) && data.def.length > 0 ? data.def[0] : null;

    const partOfSpeech = def?.pos ?? "";
    const tr0 = Array.isArray(def?.tr) && def.tr.length > 0 ? def.tr[0] : null;

    // в ru-ru tr[0].text — «толкование/основной смысл»; mean[] — дополнительные синонимы
    const meaning = tr0?.text ?? "";
    const synonyms =
      Array.isArray(tr0?.mean) && tr0.mean.length > 0
        ? tr0.mean.map((m) => m?.text).filter(Boolean).join(", ")
        : "";

    // примеры (первые два), если есть
    const ex0 = Array.isArray(tr0?.ex) && tr0.ex.length > 0 ? tr0.ex[0]?.text : "";
    const ex1 = Array.isArray(tr0?.ex) && tr0.ex.length > 1 ? tr0.ex[1]?.text : "";

    const payload = {
      слово: decodeUnicode(word),
      частьРечи: decodeUnicode(partOfSpeech),
      толкование: decodeUnicode(meaning),
      синонимы: decodeUnicode(synonyms),
      пример1: decodeUnicode(ex0),
      пример2: decodeUnicode(ex1)
    };

    res
      .type("application/json; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(JSON.stringify(payload));
  } catch (err) {
    console.error("💥 YADICT ERROR:", err);
    res
      .status(500)
      .type("application/json; charset=utf-8")
      .send(JSON.stringify({ error: "Ошибка при запросе к Яндекс.Словарю" }));
  }
});

// ===== Запуск =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});
