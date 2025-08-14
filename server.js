// src/server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import cheerio from "cheerio";

const app = express();

// CORS и парсинг JSON
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

/**
 * ===============================
 * 1) Главный прокси для OpenRouter (POST /?url=...)
 * ===============================
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
 * ===============================
 * 2) Новости GNews
 * ===============================
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

    let endpoint = "search";
    let query = qParam || cat;
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
      params.set("q", query);
    }

    const finalUrl = `https://gnews.io/api/v4/${endpoint}?${params.toString()}`;
    console.log("🔎 GNEWS URL:", finalUrl.replace(token, ""));

    const upstream = await fetch(finalUrl, { method: "GET", headers: { "Accept": "application/json" } });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res.status(upstream.status).type("text/plain; charset=utf-8").send(text);
    }

    if (mode === "raw") {
      res.type("application/json; charset=utf-8").send(text);
      return;
    }

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
      out = text;
    }

    res.type("text/plain; charset=utf-8").send(out);
  } catch (err) {
    console.error("💥 GNEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка при запросе к GNews");
  }
});

/**
 * ===============================
 * 3) Словарь (Викисловарь, русский)
 * ===============================
 */
async function parseWiktionary(word) {
  try {
    const url = `https://ru.wiktionary.org/wiki/${encodeURIComponent(word)}`;
    const { data } = await axios.get(url);
    const $ = cheerio.load(data);

    let partOfSpeech = "";
    let definition = "";
    let synonyms = [];
    let examples = [];

    const posElem = $("span.mw-headline").filter((i, el) => {
      const text = $(el).text().toLowerCase();
      return (
        text.includes("существительное") ||
        text.includes("глагол") ||
        text.includes("прилагательное") ||
        text.includes("наречие") ||
        text.includes("местоимение") ||
        text.includes("числительное")
      );
    }).first();
    if (posElem.length) {
      partOfSpeech = posElem.text();
    }

    $("span.mw-headline").each((i, el) => {
      if ($(el).text().toLowerCase().includes("значение")) {
        const list = $(el).parent().next("ol").find("li");
        if (list.length) {
          definition = $(list[0]).text().trim();
        }
      }
    });

    $("span.mw-headline").each((i, el) => {
      if ($(el).text().toLowerCase().includes("синонимы")) {
        $(el).parent().next("ul").find("li").each((j, li) => {
          synonyms.push($(li).text().trim());
        });
      }
    });

    $("dl dd").each((i, el) => {
      if (examples.length < 2) {
        examples.push($(el).text().trim());
      }
    });

    return {
      частьРечи: partOfSpeech || "—",
      толкование: definition || "—",
      синонимы: synonyms.join(", ") || "—",
      пример1: examples[0] || "—",
      пример2: examples[1] || "—"
    };

  } catch (error) {
    console.error("Ошибка парсинга:", error.message);
    return {
      частьРечи: "—",
      толкование: "—",
      синонимы: "—",
      пример1: "—",
      пример2: "—"
    };
  }
}

app.get("/yadict", async (req, res) => {
  const word = req.query.word;
  if (!word) {
    return res.status(400).json({ error: "Не указано слово" });
  }
  const result = await parseWiktionary(word);
  res.json(result);
});

/**
 * ===============================
 * 4) ChatGPT (через OpenAI API)
 * ===============================
 */
app.get("/gpt", async (req, res) => {
  const prompt = req.query.prompt;
  if (!prompt) {
    return res.status(400).json({ error: "Нет запроса" });
  }

  try {
    const { data } = await axios.post("https://api.openai.com/v1/chat/completions", {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }]
    }, {
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    res.json({ answer: data.choices[0].message.content.trim() });
  } catch (error) {
    console.error("Ошибка GPT:", error.message);
    res.status(500).json({ error: "Ошибка при запросе к ChatGPT" });
  }
});

// ===============================
// Запуск сервера
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

