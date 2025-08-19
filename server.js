// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// CORS и парсинг JSON (универсально)
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// ------------------------------
// Healthcheck
// ------------------------------
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// ------------------------------
// 1) Прокси для OpenRouter (POST /?url=...)
//    — возвращает ЧИСТЫЙ текст (без JSON-обёрток)
// ------------------------------
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
    for (const k of allow) if (req.headers[k]) headersToForward[k] = req.headers[k];
    if (!headersToForward["content-type"]) headersToForward["content-type"] = "application/json";

    const bodyString = typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString
    });

    const rawText = await upstream.text();
    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RAW (first 800):", rawText.slice(0, 800));

    // Вынимаем «голый» текст из chat-completions
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
      else if (typeof data === "string") out = data;
    } catch {
      // это не JSON — отдаём как получили
    }

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка на прокси-сервере");
  }
});

// ------------------------------
// 2) Новости GNews с анти‑повтором и рандомом страниц (1..75)
//    GET /gnews?cat=... | q=... | lang=ru | country=ru | max=5 | mode=text|raw
//    "ГЗ" => top-headlines
// ------------------------------
const lastPageMap = new Map();
const keyFor = (endpoint, query, lang, country) => `${endpoint}|${query || ""}|${lang}|${country}`;
const pickRandomPageExcept = (prev, min = 1, max = 75) => {
  if (max <= min) return min;
  let p;
  do p = Math.floor(Math.random() * (max - min + 1)) + min; while (p === prev);
  return p;
};

app.get("/gnews", async (req, res) => {
  try {
    const cat     = (req.query.cat ?? "").toString().trim();
    const qParam  = (req.query.q ?? "").toString().trim();
    const lang    = (req.query.lang ?? "ru").toString();
    const country = (req.query.country ?? "ru").toString();
    const max     = (req.query.max ?? "5").toString();
    const mode    = (req.query.mode ?? "text").toString();

    const token = (process.env.GNEWS_TOKEN || (req.query.token ?? "")).toString();
    if (!token) {
      return res
        .status(400)
        .type("text/plain; charset=utf-8")
        .send('Ошибка: нет API-ключа. Добавь GNEWS_TOKEN в Render или передавай ?token=...');
    }

    let endpoint = "search";
    let query = qParam || cat;

    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines";
      query = ""; // q не используется
    }

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

    // анти‑повтор страницы для связки endpoint+query+lang+country
    const key = keyFor(endpoint, query, lang, country);
    const prev = lastPageMap.get(key) ?? null;
    const page = pickRandomPageExcept(prev, 1, 75);
    lastPageMap.set(key, page);
    params.set("page", String(page));

    if (endpoint === "search") {
      if (!query) {
        return res
          .status(400)
          .type("text/plain; charset=utf-8")
          .send('Ошибка: для /search обязателен ?q=... (или ?cat=..., кроме "ГЗ").');
      }
      params.set("q", query); // Unicode сам закодируется
    }

    // анти‑кэш
    params.set("_t", Math.random().toString(36).slice(2));

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

    const upstream = await fetch(finalUrl, { method: "GET", headers: { Accept: "application/json" } });
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).type("text/plain; charset=utf-8").send(text);
    }

    if (mode === "raw") {
      return res.type("application/json; charset=utf-8").set("Cache-Control", "no-store").send(text);
    }

    // Человекочитаемый список
    let out = "";
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.articles) ? data.articles : [];
      out =
        list.length === 0
          ? "Новости не найдены."
          : list
              .slice(0, Number(max) || 5)
              .map((a, i) => {
                const title = a?.title ?? "Без заголовка";
                const src = a?.source?.name ? ` — ${a.source.name}` : "";
                const url = a?.url ?? "";
                return `${i + 1}. ${title}${src}\n${url}`;
              })
              .join("\n\n");
    } catch {
      out = text; // если вдруг не JSON
    }

    res.type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка при запросе к GNews");
  }
});

// ------------------------------
// 3) Викисловарь (Русский): Часть речи, Толкование, Синонимы, 2 Примера
//    GET /wikidict?word=слово
//    Отдаёт ТОЛЬКО текст — готовый для отправки в чат.
// ------------------------------
function cleanWikitext(s) {
  if (!s) return "";
  let t = s;

  // Ссылки [[страница|текст]] / [[страница]]
  t = t.replace(/\[\[([^|\]]+)\|([^|\]]+)\]\]/g, "$2");
  t = t.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // Внешние ссылки [url текст] / [url]
  t = t.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$2");
  t = t.replace(/\[(https?:\/\/[^\s\]]+)\]/g, "");

  // Шаблоны {{...}} (наивно, несколько прогонов)
  for (let i = 0; i < 5; i++) t = t.replace(/\{\{[^{}]*\}\}/g, "");

  // HTML-комменты и теги
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/<\/?[^>]+>/g, "");

  // Курсив/полужирное '' ''' ''''
  t = t.replace(/''+/g, "");

  // Маркеры списков/нумерации/разделители
  t = t.replace(/^[#*:;]\s*/gm, "");
  t = t.replace(/\s*—\s*:/g, " — ");
  t = t.replace(/\s{2,}/g, " ");

  return t.trim();
}

function sliceSection(text, startIdx) {
  // взять подстроку от startIdx до следующего языкового == ... ==
  const rest = text.slice(startIdx);
  const reLang = /(^|\n)==\s*(?:[A-Za-zА-Яа-яЁё][^=]*|\{\{-[a-z]{2}-\}\})\s*==/g;
  reLang.lastIndex = 0;
  const m = reLang.exec(rest.slice(1)); // пропускаем текущую строку
  const end = m ? startIdx + 1 + m.index : text.length;
  return text.slice(startIdx, end);
}

function extractRuSection(wiki) {
  // Ищем "== Русский ==" ИЛИ "== {{-ru-}} =="
  const reRu1 = /(^|\n)==\s*Русский\s*==/i;
  const reRu2 = /(^|\n)==\s*\{\{-ru-\}\}\s*==/i;

  let m = wiki.match(reRu1) || wiki.match(reRu2);
  if (!m) return "";
  const idx = (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0);
  return sliceSection(wiki, idx);
}

function firstPos(ru) {
  // первая подглава уровня === ... === (обычно Существительное / Глагол и т.п.)
  const m = ru.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
  if (!m) return "";
  const raw = m[2].trim();
  // частая шумовая глава "Морфологические и синтаксические свойства" — пропустим
  if (/морфологические|синтаксические/i.test(raw)) {
    const rest = ru.slice(m.index + m[0].length);
    const m2 = rest.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
    return m2 ? cleanWikitext(m2[2]) : cleanWikitext(raw);
  }
  return cleanWikitext(raw);
}

function extractBetween(ru, title) {
  // Возвращает тело подзаголовка "==== title ====" до следующего "===="
  const reStart = new RegExp(`(^|\\n)====\\s*${title}\\s*====`);
  const m = ru.match(reStart);
  if (!m) return "";
  const from = (m.index ?? 0) + m[0].length;
  const rest = ru.slice(from);
  const reEnd = /(^|\n)====\s*[^=\n]+?\s*====/;
  const endM = rest.match(reEnd);
  const to = endM ? from + endM.index : ru.length;
  return ru.slice(from, to);
}

function extractDefinition(ru) {
  // Берём раздел "Значение": первые строки, начинающиеся с "#"
  const body = extractBetween(ru, "Значение");
  if (!body) return "";
  const defs = body
    .split("\n")
    .filter((l) => l.trim().startsWith("#") && !l.trim().startsWith("#:"))
    .map((l) => cleanWikitext(l));
  return defs.length ? defs[0] : "";
}

function extractSynonyms(ru) {
  const body = extractBetween(ru, "Синонимы");
  if (!body) return "";
  const items = body
    .split("\n")
    .filter((l) => /^[#*]/.test(l.trim()))
    .map((l) => cleanWikitext(l))
    .filter((l) => l && !/^Антонимы/i.test(l));
  // Иногда раздела нет — вернётся пусто
  if (!items.length) return "";
  // Сократим до разумного количества
  return items.join(", ").replace(/\s*,\s*,/g, ",");
}

function extractExamples(ru) {
  // 1) Явный раздел "Примеры" или "Примеры употребления"
  let body = extractBetween(ru, "Примеры употребления");
  if (!body) body = extractBetween(ru, "Примеры");
  let ex = [];
  if (body) {
    ex = body
      .split("\n")
      .filter((l) => l.trim().startsWith("#") || l.trim().startsWith("*") || l.trim().startsWith(":"))
      .map((l) => cleanWikitext(l))
      .filter(Boolean);
  }
  // 2) Если нет явного раздела — попробуем примеры после значений ("#:")
  if (ex.length < 2) {
    const m = ru.match(/(^|\n)#:\s*[^\n]+/g);
    if (m) {
      const more = m.map((s) => cleanWikitext(s.replace(/^#:\s*/, "")));
      ex = ex.concat(more);
    }
  }
  ex = ex.filter(Boolean);
  return [ex[0] || "", ex[1] || ""];
}

app.get("/wikidict", async (req, res) => {
  try {
    const word = (req.query.word ?? "").toString().trim();
    if (!word) {
      return res.status(400).type("text/plain; charset=utf-8").send("Ошибка: передай ?word=слово");
    }

    // Забираем WIKITEXT страницы
    const url = `https://ru.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(
      word
    )}&prop=wikitext&format=json&redirects=1`;
    const r = await fetch(url, { headers: { "User-Agent": "watbot-proxy/1.0" } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(r.status).type("text/plain; charset=utf-8").send("Не удалось получить данные.");
    }

    let wiki = "";
    try {
      const j = JSON.parse(txt);
      wiki = j?.parse?.wikitext?.["*"] || "";
    } catch {
      // если не JSON — просто пусто
    }
    if (!wiki) {
      return res.type("text/plain; charset=utf-8").send(
        `📚 ${word}\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`
      );
    }

    const ru = extractRuSection(wiki);
    if (!ru) {
      return res
        .type("text/plain; charset=utf-8")
        .send(`📚 ${word}\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`);
    }

    const pos = firstPos(ru) || "-";
    const def = extractDefinition(ru) || "-";
    const syn = extractSynonyms(ru) || "-";
    const [ex1, ex2] = extractExamples(ru);
    const out = `📚 ${word}\nЧасть речи: ${pos || "-"}\nТолкование: ${def || "-"}\nСинонимы: ${syn || "-"}\nПример 1: ${ex1 || "-"}\nПример 2: ${ex2 || "-"}`;

    res.type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);
  } catch (e) {
    console.error("💥 WIKIDICT ERROR:", e);
    res
      .status(500)
      .type("text/plain; charset=utf-8")
      .send("Ошибка при запросе к Викисловарю");
  }
});

// ------------------------------
// Запуск
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});
