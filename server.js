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
// 3) СЛОВАРИ - альтернативный источник через Glosbe.com
// ------------------------------

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

// --- починка кодировки ---
function normalizeWordFromQuery(req) {
  let word = (req.query.word ?? "").toString();
  if (word.includes("+")) word = word.replace(/\+/g, " ");
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(word);
      if (d === word) break;
      word = d;
    } catch { break; }
  }
  if (!/[А-Яа-яЁё]/.test(word) && /[ÐÑ�Р]/.test(word)) {
    const fixed = Buffer.from(word, "latin1").toString("utf8");
    if (/[А-Яа-яЁё]/.test(fixed)) word = fixed;
  }
  return word.trim();
}

// --- обработчик словаря через Glosbe ---
async function wikidictHandler(req, res) {
  const word = normalizeWordFromQuery(req);
  
  try {
    if (!word) {
      return res.status(200).type("text/plain; charset=utf-8").send(
        `📚 -\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`
      );
    }

    console.log("🔎 DICT word:", word);

    // Используем Glosbe API для получения данных о слове
    const url = `https://glosbe.com/gapi/translate?from=rus&dest=rus&format=json&phrase=${encodeURIComponent(word)}`;
    
    const response = await fetchWithTimeout(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json'
      }
    }, 8000);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    
    let partOfSpeech = "-";
    let meaning = "-";
    let synonyms = "-";
    let examples = ["-", "-"];

    // Парсим данные из ответа
    if (data.tuc && data.tuc.length > 0) {
      const firstResult = data.tuc[0];
      
      // Часть речи
      if (firstResult.meanings && firstResult.meanings.length > 0) {
        partOfSpeech = firstResult.meanings[0].text || "-";
      }
      
      // Значение
      if (firstResult.phrases && firstResult.phrases.length > 0) {
        meaning = firstResult.phrases[0].text || "-";
      }
      
      // Синонимы (берем из дополнительных значений)
      if (data.tuc.length > 1) {
        const syns = data.tuc.slice(1, 4).map(item => {
          if (item.phrases && item.phrases[0]) return item.phrases[0].text;
          return null;
        }).filter(Boolean);
        if (syns.length > 0) synonyms = syns.join(", ");
      }
      
      // Примеры из контекста
      if (data.examples && data.examples.length > 0) {
        examples = data.examples.slice(0, 2).map(ex => ex.text || "-");
      }
    }

    const out = `📚 ${word}\n` +
                `Часть речи: ${partOfSpeech}\n` +
                `Толкование: ${meaning}\n` +
                `Синонимы: ${synonyms}\n` +
                `Пример 1: ${examples[0]}\n` +
                `Пример 2: ${examples[1]}`;

    return res.status(200).type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);

  } catch (error) {
    console.error("💥 DICT ERROR:", error);
    // Fallback на локальную базу распространенных слов
    const commonWords = {
      "город": ["существительное", "крупный населённый пункт", "мегаполис, поселение", "Я живу в большом городе.", "Этот город известен своими памятниками."],
      "дом": ["существительное", "здание для жилья", "здание, жилище, строение", "Мы купили новый дом.", "Этот дом очень старый."],
      "человек": ["существительное", "разумное живое существо", "личность, индивидуум, особа", "Человек должен быть добрым.", "Этот человек мне помог."],
      "вода": ["существительное", "прозрачная жидкость", "жидкость, влага, H2O", "Я пью воду каждый день.", "Вода в реке холодная."],
      "солнце": ["существительное", "звезда в центре системы", "светило, дневное светило", "Солнце светит ярко.", "Мы грелись на солнце."]
    };

    const lowerWord = word.toLowerCase();
    if (commonWords[lowerWord]) {
      const [pos, mean, syn, ex1, ex2] = commonWords[lowerWord];
      const out = `📚 ${word}\n` +
                  `Часть речи: ${pos}\n` +
                  `Толкование: ${mean}\n` +
                  `Синонимы: ${syn}\n` +
                  `Пример 1: ${ex1}\n` +
                  `Пример 2: ${ex2}`;
      return res.status(200).type("text/plain; charset=utf-8").send(out);
    }

    return res.status(200).type("text/plain; charset=utf-8").send(
      `📚 ${word}\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`
    );
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


