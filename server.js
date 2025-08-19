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

    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
      else if (typeof data === "string") out = data;
    } catch {}

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
// 2) Новости GNews с анти-повтором и рандомом страниц (1..75)
// ------------------------------
const lastPageMap = new Map();
const keyFor = (endpoint, query, lang, country) =>
  `${endpoint}|${query || ""}|${lang}|${country}`;
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
      query = "";
    }

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

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
      params.set("q", query);
    }

    params.set("_t", Math.random().toString(36).slice(2));

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

    const upstream = await fetch(finalUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    const text = await upstream.text();

    if (!upstream.ok) {
      return res.status(upstream.status).type("text/plain; charset=utf-8").send(text);
    }

    if (mode === "raw") {
      return res
        .type("application/json; charset=utf-8")
        .set("Cache-Control", "no-store")
        .send(text);
    }

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
      out = text;
    }

    res.type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка при запросе к GNews");
  }
});

// ------------------------------
// 3) Викисловарь (Русский): Часть речи, Толкование, Синонимы, 2 Примера
//    GET /wikidict?word=слово   (алиас /dict)
// ------------------------------

// --- утилиты парсинга викитекста ---
function cleanWikitext(s) {
  if (!s) return "";
  let t = s;

  // [[страница|текст]] / [[страница]]
  t = t.replace(/\[\[([^|\]]+)\|([^|\]]+)\]\]/g, "$2");
  t = t.replace(/\[\[([^\]]+)\]\]/g, "$1");

  // [url текст] / [url]
  t = t.replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/g, "$2");
  t = t.replace(/\[(https?:\/\/[^\s\]]+)\]/g, "");

  // {{...}} (несколько прогонов)
  for (let i = 0; i < 5; i++) t = t.replace(/\{\{[^{}]*\}\}/g, "");

  // комментарии/HTML/курсив/маркеры
  t = t.replace(/<!--[\s\S]*?-->/g, "");
  t = t.replace(/<\/?[^>]+>/g, "");
  t = t.replace(/''+/g, "");
  t = t.replace(/^[#*:;]\s*/gm, "");
  t = t.replace(/\s*—\s*:/g, " — ");
  t = t.replace(/\s{2,}/g, " ");
  return t.trim();
}

function sliceSection(text, startIdx) {
  const rest = text.slice(startIdx);
  const reLang = /(^|\n)==\s*(?:[A-Za-zА-Яа-яЁё][^=]*|\{\{-[a-z]{2}-\}\})\s*==/g;
  reLang.lastIndex = 0;
  const m = reLang.exec(rest.slice(1));
  const end = m ? startIdx + 1 + m.index : text.length;
  return text.slice(startIdx, end);
}

function extractRuSection(wiki) {
  const reRu1 = /(^|\n)==\s*Русский\s*==/i;
  const reRu2 = /(^|\n)==\s*\{\{-ru-\}\}\s*==/i;
  let m = wiki.match(reRu1) || wiki.match(reRu2);
  if (!m) return "";
  const idx = (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0);
  return sliceSection(wiki, idx);
}

function firstPos(ru) {
  const m = ru.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
  if (!m) return "";
  const raw = m[2].trim();
  if (/морфологические|синтаксические/i.test(raw)) {
    const rest = ru.slice(m.index + m[0].length);
    const m2 = rest.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
    return m2 ? cleanWikitext(m2[2]) : cleanWikitext(raw);
  }
  return cleanWikitext(raw);
}

function extractBetween(ru, title) {
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
  if (!items.length) return "";
  return items.join(", ").replace(/\s*,\s*,/g, ",");
}

function extractExamples(ru) {
  let body = extractBetween(ru, "Примеры употребления");
  if (!body) body = extractBetween(ru, "Примеры");
  let ex = [];
  if (body) {
    ex = body
      .split("\n")
      .filter(
        (l) =>
          l.trim().startsWith("#") ||
          l.trim().startsWith("*") ||
          l.trim().startsWith(":")
      )
      .map((l) => cleanWikitext(l))
      .filter(Boolean);
  }
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

// --- починка кодировки и подготовка слова ---
function normalizeWordFromQuery(req) {
  let word = (req.query.word ?? "").toString();

  // "+" -> пробел
  if (word.includes("+")) word = word.replace(/\+/g, " ");

  // попытка декодировать 1–2 раза
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(word);
      if (d === word) break;
      word = d;
    } catch {
      break;
    }
  }

  // если «моджибейк» (Ð/Ñ/Р/�) — лечим latin1→utf8
  if (!/[А-Яа-яЁё]/.test(word) && /[ÐÑ�Р]/.test(word)) {
    const fixed = Buffer.from(word, "latin1").toString("utf8");
    if (/[А-Яа-яЁё]/.test(fixed)) word = fixed;
  }

  return word.trim();
}

// --- fetch с таймаутом ---
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// --- получение викитекста (2 попытки) ---
async function fetchWikitext(word) {
  const headers = {
    "User-Agent": "watbot-proxy/1.0 (+render)",
    Accept: "application/json"
  };

  // 1) parse + wikitext
  try {
    const url1 =
      `https://ru.wiktionary.org/w/api.php` +
      `?action=parse&page=${encodeURIComponent(word)}` +
      `&prop=wikitext&format=json&redirects=1&origin=*`;
    const r1 = await fetchWithTimeout(url1, { headers }, 8000);
    const txt1 = await r1.text();
    if (r1.ok) {
      const j1 = JSON.parse(txt1);
      const w1 = j1?.parse?.wikitext?.["*"];
      if (w1) return w1;
    }
  } catch (e) {
    console.warn("parse failed:", e?.name || e);
  }

  // 2) fallback: revisions
  try {
    const url2 =
      `https://ru.wiktionary.org/w/api.php` +
      `?action=query&prop=revisions&rvprop=content&rvslots=main&format=json` +
      `&redirects=1&titles=${encodeURIComponent(word)}&origin=*`;
    const r2 = await fetchWithTimeout(url2, { headers }, 8000);
    const txt2 = await r2.text();
    if (r2.ok) {
      const j2 = JSON.parse(txt2);
      const pages = j2?.query?.pages || {};
      for (const k of Object.keys(pages)) {
        const slot = pages[k]?.revisions?.[0]?.slots?.main?.["*"];
        if (slot) return slot;
      }
    }
  } catch (e) {
    console.warn("revisions failed:", e?.name || e);
  }

  return "";
}

// --- единый обработчик для /wikidict и /dict ---
// ВАЖНО: всегда отвечает 200 текстом, чтобы конструктор показал ответ
async function wikidictHandler(req, res) {
  const word = normalizeWordFromQuery(req);
  const fallbackOut = (w) =>
    `📚 ${w || "-"}\n` +
    `Часть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`;

  try {
    if (!word) {
      return res
        .status(200)
        .type("text/plain; charset=utf-8")
        .send(fallbackOut(""));
    }

    console.log("🔎 WIKIDICT word:", word);

    const wiki = await fetchWikitext(word);
    if (!wiki) {
      return res
        .status(200)
        .type("text/plain; charset=utf-8")
        .send(fallbackOut(word));
    }

    const ru = extractRuSection(wiki);
    if (!ru) {
      return res
        .status(200)
        .type("text/plain; charset=utf-8")
        .send(fallbackOut(word));
    }

    const pos = firstPos(ru) || "-";
    const def = extractDefinition(ru) || "-";
    const syn = extractSynonyms(ru) || "-";
    const [ex1, ex2] = extractExamples(ru);

    const out =
      `📚 ${word}\n` +
      `Часть речи: ${pos}\n` +
      `Толкование: ${def}\n` +
      `Синонимы: ${syn}\n` +
      `Пример 1: ${ex1 || "-"}\n` +
      `Пример 2: ${ex2 || "-"}`;

    return res
      .status(200)
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(out);
  } catch (e) {
    console.error("💥 WIKIDICT ERROR:", e);
    return res
      .status(200) // <- всегда 200 и текст
      .type("text/plain; charset=utf-8")
      .send(fallbackOut(word));
  }
}

app.get("/wikidict", wikidictHandler);
app.get("/dict", wikidictHandler); // алиас

// ------------------------------
// Запуск
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});


