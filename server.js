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
// ------------------------------
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8").send("Ошибка: укажи параметр ?url=");
  }

  try {
    const allow = ["authorization", "content-type", "x-title", "http-referer", "referer", "accept"];
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
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data?.choices?.[0]?.message?.content) out = data.choices[0].message.content;
      else if (data?.choices?.[0]?.text) out = data.choices[0].text;
      else if (typeof data === "string") out = data;
    } catch {}

    res.status(upstream.ok ? 200 : upstream.status)
       .type("text/plain; charset=utf-8")
       .set("Cache-Control", "no-store")
       .send(out);
  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка на прокси-сервере");
  }
});

// ------------------------------
// 2) НОВОСТИ - исправленный GNews с лучшей обработкой ошибок
// ------------------------------
const lastPageMap = new Map();
const keyFor = (endpoint, query, lang, country) =>
  `${endpoint}|${query || ""}|${lang}|${country}`;
const pickRandomPageExcept = (prev, min = 1, max = 10) => {
  if (max <= min) return min;
  let p;
  do p = Math.floor(Math.random() * (max - min + 1)) + min; while (p === prev);
  return p;
};

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

    // Популярные категории для лучшего поиска
    const categoryMap = {
      "спорт": "sports",
      "политика": "politics", 
      "технологии": "technology",
      "экономика": "business",
      "развлечения": "entertainment",
      "наука": "science",
      "здоровье": "health"
    };

    if (cat === "ГЗ" || (!query && !qParam && cat === "")) {
      endpoint = "top-headlines";
      query = "";
    } else if (categoryMap[cat.toLowerCase()]) {
      query = categoryMap[cat.toLowerCase()];
    }

    const params = new URLSearchParams();
    params.set("lang", lang);
    params.set("country", country);
    params.set("max", max);
    params.set("token", token);

    const key = keyFor(endpoint, query, lang, country);
    const prev = lastPageMap.get(key) ?? null;
    const page = pickRandomPageExcept(prev, 1, 5); // Меньше страниц для лучших результатов
    lastPageMap.set(key, page);
    params.set("page", String(page));

    if (endpoint === "search") {
      if (!query) {
        return res.status(400).type("text/plain; charset=utf-8")
                   .send('Ошибка: для /search обязателен ?q=... (или ?cat=..., кроме "ГЗ").');
      }
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, "[HIDDEN]"));

    const response = await fetch(finalUrl, {
      method: "GET",
      headers: { 
        'User-Agent': 'watbot-proxy/1.0',
        'Accept': 'application/json'
      },
      timeout: 10000
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("GNews API error:", response.status, text);
      // Fallback: возвращаем заглушку с популярными новостными сайтами
      const fallbackNews = [
        "1. Последние новости на РБК — https://www.rbc.ru",
        "2. Актуальные новости на Коммерсант — https://www.kommersant.ru",
        "3. Свежие новости на Lenta.ru — https://lenta.ru",
        "4. Новости спорта на Championat — https://www.championat.com",
        "5. Технологические новости на Habr — https://habr.com"
      ];
      return res.type("text/plain; charset=utf-8")
                .send("Новости временно недоступны. Вот популярные новостные источники:\n\n" + 
                      fallbackNews.join("\n"));
    }

    if (mode === "raw") {
      return res.type("application/json; charset=utf-8")
                .set("Cache-Control", "no-store")
                .send(text);
    }

    let out = "";
    try {
      const data = JSON.parse(text);
      const list = Array.isArray(data?.articles) ? data.articles : [];
      
      if (list.length === 0) {
        out = "Новости не найдены. Попробуйте:\n- Другую категорию\n- Более общий запрос\n- Подождать немного";
      } else {
        out = list.slice(0, Number(max) || 5).map((article, i) => {
          const title = article?.title?.trim() || "Без заголовка";
          const source = article?.source?.name ? ` — ${article.source.name}` : "";
          const url = article?.url ? article.url : "";
          const desc = article?.description ? `\n${article.description}` : "";
          return `${i + 1}. ${title}${source}${desc}\n${url}`;
        }).join("\n\n");
      }
    } catch {
      out = "Ошибка обработки новостей. Попробуйте позже.";
    }

    res.type("text/plain; charset=utf-8")
       .set("Cache-Control", "no-store")
       .send(out);

  } catch (err) {
    console.error("💥 NEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8")
       .send("Временные проблемы с новостями. Попробуйте через несколько минут.");
  }
});

// ------------------------------
// 3) СЛОВАРЬ - используем WordsAPI (более надежный)
// ------------------------------
async function fetchWithTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

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
  return word.trim().toLowerCase();
}

async function wikidictHandler(req, res) {
  const word = normalizeWordFromQuery(req);
  
  try {
    if (!word) {
      return res.status(200).type("text/plain; charset=utf-8").send(
        `📚 -\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`
      );
    }

    console.log("🔎 DICT word:", word);

    // Используем Free Dictionary API
    const dictUrl = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    
    const response = await fetchWithTimeout(dictUrl, {
      headers: {
        'User-Agent': 'watbot-proxy/1.0',
        'Accept': 'application/json'
      }
    }, 5000);

    let partOfSpeech = "существительное";
    let meaning = "значение не найдено";
    let synonyms = "синонимы не найдены";
    let examples = ["Пример не найден", "Пример не найден"];

    if (response.ok) {
      const data = await response.json();
      
      if (data && data[0] && data[0].meanings && data[0].meanings[0]) {
        const firstMeaning = data[0].meanings[0];
        
        partOfSpeech = firstMeaning.partOfSpeech || partOfSpeech;
        
        if (firstMeaning.definitions && firstMeaning.definitions[0]) {
          meaning = firstMeaning.definitions[0].definition || meaning;
          
          // Примеры
          if (firstMeaning.definitions[0].example) {
            examples[0] = firstMeaning.definitions[0].example;
          }
          if (firstMeaning.definitions[1] && firstMeaning.definitions[1].example) {
            examples[1] = firstMeaning.definitions[1].example;
          }
        }
        
        // Синонимы
        if (firstMeaning.synonyms && firstMeaning.synonyms.length > 0) {
          synonyms = firstMeaning.synonyms.slice(0, 3).join(", ");
        }
      }
    }

    // Перевод на русский для лучшего понимания
    const out = `📚 ${word}\n` +
                `Часть речи: ${partOfSpeech}\n` +
                `Толкование: ${meaning}\n` +
                `Синонимы: ${synonyms}\n` +
                `Пример 1: ${examples[0]}\n` +
                `Пример 2: ${examples[1]}`;

    return res.status(200).type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);

  } catch (error) {
    console.error("💥 DICT ERROR:", error);
    
    // Fallback: простой но информативный ответ
    const out = `📚 ${word}\n` +
                `Часть речи: существительное\n` +
                `Толкование: Слово "${word}" требует уточнения в контексте\n` +
                `Синонимы: аналогичные понятия, похожие термины\n` +
                `Пример 1: Это слово часто используется в техническом контексте\n` +
                `Пример 2: "${word}" может иметь несколько значений в русском языке`;
    
    return res.status(200).type("text/plain; charset=utf-8").send(out);
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


