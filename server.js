// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// CORS и парсинг JSON (универсально)
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Явная настройка CORS для всех routes
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

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

// --- улучшенные утилиты парсинга викитекста ---
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
  // Более гибкий поиск русской секции
  const reRu = /(^|\n)==\s*(?:Русский|\{\{-ru-\}\}|Russian)\s*==/i;
  const m = wiki.match(reRu);
  if (!m) return "";
  
  const idx = (m.index ?? 0) + (m[0].startsWith("\n") ? 1 : 0);
  return sliceSection(wiki, idx);
}

function firstPos(ru) {
  // Ищем часть речи более гибко
  const m = ru.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
  if (!m) return "";
  
  const raw = m[2].trim();
  const cleaned = cleanWikitext(raw);
  
  // Пропускаем технические разделы
  if (/морфологические|синтаксические|фонетические|тип|значение/i.test(cleaned)) {
    const rest = ru.slice(m.index + m[0].length);
    const m2 = rest.match(/(^|\n)===\s*([^=\n]+?)\s*===/);
    return m2 ? cleanWikitext(m2[2]) : cleaned;
  }
  
  return cleaned;
}

function extractBetween(ru, title) {
  const reStart = new RegExp(`(^|\\n)====\\s*${title}\\s*====`, "i");
  const m = ru.match(reStart);
  if (!m) return "";
  const from = (m.index ?? 0) + m[0].length;
  const rest = ru.slice(from);
  const reEnd = /(^|\n)====\s*[^=\n]+?\s*====/i;
  const endM = rest.match(reEnd);
  const to = endM ? from + endM.index : ru.length;
  return ru.slice(from, to);
}

function extractDefinition(ru) {
  // Ищем значение в разных вариантах разделов
  let body = extractBetween(ru, "Значение");
  if (!body) body = extractBetween(ru, "Семантические свойства");
  if (!body) body = extractBetween(ru, "Смысл");
  
  if (!body) {
    // Альтернативный поиск: ищем список определений
    const defMatch = ru.match(/(^|\n)#\s*([^\n]+)(?=\n#|$)/);
    if (defMatch) return cleanWikitext(defMatch[2]);
    return "";
  }
  
  const defs = body
    .split("\n")
    .filter((l) => l.trim().startsWith("#") && !l.trim().startsWith("#:"))
    .map((l) => cleanWikitext(l.replace(/^#\s*/, "")));
  
  return defs.length ? defs[0] : "";
}

function extractSynonyms(ru) {
  // Ищем синонимы в разных вариантах разделов
  let body = extractBetween(ru, "Синонимы");
  if (!body) body = extractBetween(ru, "Сходные по смыслу");
  if (!body) return "";
  
  const items = body
    .split("\n")
    .filter((l) => /^[#*:-]/.test(l.trim()))
    .map((l) => cleanWikitext(l.replace(/^[#*:-]\s*/, "")))
    .filter((l) => l && !/^Антонимы/i.test(l) && l.length > 2);
  
  if (!items.length) return "";
  return items.join(", ").replace(/\s*,\s*,/g, ",");
}

function extractExamples(ru) {
  // Ищем примеры в разных разделах
  let body = extractBetween(ru, "Примеры употребления");
  if (!body) body = extractBetween(ru, "Примеры");
  if (!body) body = extractBetween(ru, "Употребление");
  
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
      .map((l) => cleanWikitext(l.replace(/^[#*:]\s*/, "")))
      .filter(Boolean);
  }
  
  // Если примеров мало, ищем в основном тексте
  if (ex.length < 2) {
    const m = ru.match(/(^|\n)#:\s*[^\n]+/g);
    if (m) {
      const more = m.map((s) => cleanWikitext(s.replace(/^#:\s*/, "")));
      ex = ex.concat(more);
    }
  }
  
  // Если все еще мало, ищем любые предложения в кавычках
  if (ex.length < 2) {
    const quoteMatch = ru.match(/«([^»]+)»/g);
    if (quoteMatch) {
      const quotes = quoteMatch.map(q => q.replace(/[«»]/g, ''));
      ex = ex.concat(quotes);
    }
  }
  
  ex = ex.filter(Boolean).slice(0, 2);
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
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
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
    const r1 = await fetchWithTimeout(url1, { headers }, 10000);
    const txt1 = await r1.text();
    if (r1.ok) {
      const j1 = JSON.parse(txt1);
      const w1 = j1?.parse?.wikitext?.["*"];
      if (w1) {
        console.log("✅ Got wikitext from parse API");
        return w1;
      }
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
    const r2 = await fetchWithTimeout(url2, { headers }, 10000);
    const txt2 = await r2.text();
    if (r2.ok) {
      const j2 = JSON.parse(txt2);
      const pages = j2?.query?.pages || {};
      for (const k of Object.keys(pages)) {
        const slot = pages[k]?.revisions?.[0]?.slots?.main?.["*"];
        if (slot) {
          console.log("✅ Got wikitext from revisions API");
          return slot;
        }
      }
    }
  } catch (e) {
    console.warn("revisions failed:", e?.name || e);
  }

  console.log("❌ No wikitext found");
  return "";
}

// --- единый обработчик для /wikidict и /dict ---
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
      console.log("❌ No wikitext found for:", word);
      return res
        .status(200)
        .type("text/plain; charset=utf-8")
        .send(fallbackOut(word));
    }

    console.log("📖 Raw wikitext length:", wiki.length);

    const ru = extractRuSection(wiki);
    if (!ru) {
      console.log("❌ No Russian section found");
      return res
        .status(200)
        .type("text/plain; charset=utf-8")
        .send(fallbackOut(word));
    }

    console.log("🇷🇺 Russian section length:", ru.length);

    const pos = firstPos(ru) || "-";
    const def = extractDefinition(ru) || "-";
    const syn = extractSynonyms(ru) || "-";
    const [ex1, ex2] = extractExamples(ru);

    console.log("📊 Extracted data:", { pos, def, syn, ex1, ex2 });

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
    console.error("Error stack:", e.stack);
    return res
      .status(200)
      .type("text/plain; charset=utf-8")
      .send(fallbackOut(word));
  }
}

app.get("/wikidict", wikidictHandler);
app.get("/dict", wikidictHandler);

// ------------------------------
// Запуск
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});


