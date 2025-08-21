33// src/server.js
import express from "express";
import cors from "cors";

const app = express();

// парсинг JSON
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// настройка CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  next();
});

// ------------------------------
// Проверка
// ------------------------------
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// ------------------------------
// Openrouter
// ------------------------------
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8").send("Ошибка: укажи параметр ?url=");
  }

  try {
    console.log("➡ INCOMING:", {
      method: req.method,
      url: targetUrl,
      headers: req.headers,
      body: req.body
    });

    const allow = [
      "authorization",
      "content-type",
      "x-title",
      "http-referer",
      "referer",
      "accept",
      "accept-encoding",
      "accept-language",
      "connection",
      "host",
      "origin",
      "user-agent"
    ];
    
    const headersToForward = {};
    for (const k of allow) {
      if (req.headers[k]) {
        headersToForward[k] = req.headers[k];
      }
    }

    // провнрка content-type
    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    // проверяем body
    let authHeader = headersToForward["authorization"];
    if (!authHeader && req.body && req.body.authorization) {
      authHeader = req.body.authorization;
      delete req.body.authorization; // Удаляем из body чтобы не дублировать
    }

    // деф авторизация
    if (!authHeader) {
      authHeader = process.env.OPENROUTER_API_KEY || "Bearer sk-or-v1-...";
    }

    headersToForward["authorization"] = authHeader;

    const bodyString = JSON.stringify(req.body);

    console.log("➡ FORWARDING to:", targetUrl);
    console.log("➡ HEADERS:", headersToForward);
    console.log("➡ BODY:", bodyString);

    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString
    });

    const rawText = await upstream.text();
    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RESPONSE:", rawText.slice(0, 500));

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
    } catch (e) {
      console.log("JSON parse error, returning raw text");
    }

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .set("Cache-Control", "no-store")
      .send(out);

  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка на прокси-сервере: " + e.message);
  }
});

// ------------------------------
// НОВОСТИ
// ------------------------------
app.get("/gnews", async (req, res) => {
  try {
    const token = process.env.GNEWS_TOKEN || (req.query.token ?? "").toString();
    if (!token) {
      return res.status(400).type("text/plain; charset=utf-8")
                 .send('Ошибка: нет API-ключа GNEWS_TOKEN');
    }

    const category = (req.query.cat ?? "general").toString();
    const url = `https://gnews.io/api/v4/top-headlines?category=${category}&lang=ru&country=ru&max=5&token=${token}`;

    const response = await fetch(url, {
      headers: { 'User-Agent': 'watbot-proxy/1.0' }
    });

    if (!response.ok) {
      throw new Error(`GNews error: ${response.status}`);
    }

    const data = await response.json();
    let out = "Новости не найдены";

    if (data.articles && data.articles.length > 0) {
      out = data.articles.map((article, i) => {
        return `${i + 1}. ${article.title}\n${article.url}`;
      }).join("\n\n");
    }

    res.type("text/plain; charset=utf-8").send(out);

  } catch (err) {
    console.error("💥 NEWS ERROR:", err);
    res.status(500).type("text/plain; charset=utf-8")
       .send("Ошибка при получении новостей");
  }
});

// ------------------------------
// Запуск
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

