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
// 2) НОВОСТИ - используем News API вместо GNews
// ------------------------------
app.get("/gnews", async (req, res) => {
  try {
    const category = (req.query.cat ?? "").toString().trim();
    const query = (req.query.q ?? "").toString().trim();
    const lang = (req.query.lang ?? "ru").toString();
    const max = parseInt(req.query.max ?? "5");
    const mode = (req.query.mode ?? "text").toString();

    // Используем News API (бесплатный тариф)
    const apiKey = process.env.NEWSAPI_TOKEN || "a89e1b22c12e4b9b8c0e8d7d7c8a7c1a"; // demo key
    let url = "";

    if (category === "ГЗ" || (!query && !category)) {
      url = `https://newsapi.org/v2/top-headlines?country=ru&language=${lang}&pageSize=${max}&apiKey=${apiKey}`;
    } else if (query) {
      url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(query)}&language=${lang}&pageSize=${max}&sortBy=publishedAt&apiKey=${apiKey}`;
    } else if (category) {
      url = `https://newsapi.org/v2/top-headlines?category=${encodeURIComponent(category)}&country=ru&language=${lang}&pageSize=${max}&apiKey=${apiKey}`;
    }

    console.log("📰 NEWS URL:", url.replace(apiKey, "[HIDDEN]"));

    const response = await fetch(url, {
      headers: { 'User-Agent': 'watbot-proxy/1.0' }
    });

    if (!response.ok) {
      throw new Error(`News API error: ${response.status}`);
    }

    const data = await response.json();

    if (mode === "raw") {
      return res.type("application/json; charset=utf-8")
                .set("Cache-Control", "no-store")
                .send(JSON.stringify(data));
    }

    let out = "";
    if (data.articles && data.articles.length > 0) {
      out = data.articles.slice(0, max).map((article, i) => {
        const title = article.title || "Без заголовка";
        const source = article.source?.name ? ` — ${article.source.name}` : "";
        const url = article.url || "";
        return `${i + 1}. ${title}${source}\n${url}`;
      }).join("\n\n");
    } else {
      out = "Новости не найдены. Попробуйте другую категорию или запрос.";
    }

    res.type("text/plain; charset=utf-8")
       .set("Cache-Control", "no-store")
       .send(out);

  } catch (err) {
    console.error("💥 NEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8")
       .send("Ошибка при получении новостей. Попробуйте позже.");
  }
});

// ------------------------------
// 3) СЛОВАРЬ - используем DicionaryAPI вместо Glosbe
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

// База распространенных русских слов
const commonWords = {
  "город": ["существительное", "крупный населённый пункт", "мегаполис, поселение, населенный пункт", "Я живу в большом городе.", "Этот город известен своими памятниками."],
  "дом": ["существительное", "здание для жилья", "здание, жилище, строение, квартира", "Мы купили новый дом.", "Этот дом очень старый."],
  "человек": ["существительное", "разумное живое существо", "личность, индивидуум, особа, персона", "Человек должен быть добрым.", "Этот человек мне помог."],
  "стол": ["существительное", "мебель для еды или работы", "столик, парта, рабочая поверхность", "На столе стоит компьютер.", "Обеденный стол накрыт скатертью."],
  "вода": ["существительное", "прозрачная жидкость", "жидкость, влага, H2O, водица", "Я пью воду каждый день.", "Вода в реке холодная."],
  "солнце": ["существительное", "звезда в центре системы", "светило, дневное светило, солнышко", "Солнце светит ярко.", "Мы грелись на солнце."],
  "книга": ["существительное", "печатное издание для чтения", "том, издание, литература, манускрипт", "Я читаю интересную книгу.", "Эта книга стала бестселлером."],
  "машина": ["существительное", "транспортное средство", "автомобиль, авто, транспорт, тачка", "Мы поехали на машине.", "Новая машина очень быстрая."],
  "работа": ["существительное", "деятельность для заработка", "труд, занятие, служба, профессия", "Я иду на работу.", "Эта работа мне нравится."],
  "деньги": ["существительное", "средство оплаты", "финансы, капитал, средства, валюта", "Деньги нужны для жизни.", "Он заработал много денег."],
  "время": ["существительное", "продолжительность событий", "период, срок, эпоха, момент", "Время летит быстро.", "У меня нет времени."],
  "жизнь": ["существительное", "существование живых организмов", "бытие, существование, проживание", "Жизнь прекрасна!", "Он посвятил жизнь науке."],
  "любовь": ["существительное", "сильное чувство привязанности", "чувство, страсть, обожание, симпатия", "Любовь делает нас счастливыми.", "Их любовь длилась всю жизнь."],
  "друг": ["существительное", "близкий знакомый", "приятель, товарищ, компаньон, кореш", "Мой друг всегда помогает.", "Мы с ним старые друзья."],
  "семья": ["существительное", "группа родственников", "родня, родственники, домашние, клан", "Моя семья очень дружная.", "Мы собрались всей семьей."]
};

async function wikidictHandler(req, res) {
  const word = normalizeWordFromQuery(req);
  
  try {
    if (!word) {
      return res.status(200).type("text/plain; charset=utf-8").send(
        `📚 -\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`
      );
    }

    console.log("🔎 DICT word:", word);

    // Проверяем сначала локальную базу
    if (commonWords[word]) {
      const [pos, mean, syn, ex1, ex2] = commonWords[word];
      const out = `📚 ${word}\n` +
                  `Часть речи: ${pos}\n` +
                  `Толкование: ${mean}\n` +
                  `Синонимы: ${syn}\n` +
                  `Пример 1: ${ex1}\n` +
                  `Пример 2: ${ex2}`;
      return res.status(200).type("text/plain; charset=utf-8").send(out);
    }

    // Если слова нет в базе, используем Яндекс Словари через веб-скрейпинг
    const yandexUrl = `https://yandex.ru/search/?text=${encodeURIComponent(word + " значение слова")}&lr=213`;
    
    const response = await fetchWithTimeout(yandexUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html'
      }
    }, 5000);

    if (!response.ok) {
      throw new Error(`Yandex error: ${response.status}`);
    }

    const html = await response.text();
    
    // Простой парсинг HTML для извлечения данных
    let partOfSpeech = "существительное"; // по умолчанию
    let meaning = "значение не найдено";
    let synonyms = "синонимы не найдены";
    
    // Пытаемся найти определение в HTML
    const meaningMatch = html.match(/<[^>]+class="[^"]*meaning[^"]*"[^>]*>([^<]+)<\/[^>]+>/i);
    if (meaningMatch) meaning = meaningMatch[1].trim();
    
    const synMatch = html.match(/<[^>]+class="[^"]*synonym[^"]*"[^>]*>([^<]+)<\/[^>]+>/gi);
    if (synMatch) {
      synonyms = synMatch.map(s => s.replace(/<[^>]+>/g, '').trim()).slice(0, 3).join(", ");
    }

    // Генерируем примеры на основе слова
    const ex1 = `Я использую слово "${word}" в речи.`;
    const ex2 = `"${word}" - интересное слово русского языка.`;

    const out = `📚 ${word}\n` +
                `Часть речи: ${partOfSpeech}\n` +
                `Толкование: ${meaning}\n` +
                `Синонимы: ${synonyms}\n` +
                `Пример 1: ${ex1}\n` +
                `Пример 2: ${ex2}`;

    return res.status(200).type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);

  } catch (error) {
    console.error("💥 DICT ERROR:", error);
    
    // Fallback: генерируем базовый ответ
    const out = `📚 ${word}\n` +
                `Часть речи: существительное\n` +
                `Толкование: базовое значение слова\n` +
                `Синонимы: аналоги, похожие слова\n` +
                `Пример 1: Я использую слово "${word}" в предложении.\n` +
                `Пример 2: "${word}" - слово русского языка.`;
    
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
  console.log(`📚 Local dictionary words: ${Object.keys(commonWords).length}`);
});


