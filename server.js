import express from "express";
import cors from "cors";
// В Node 18+ fetch уже встроен. node-fetch тоже подключён в package.json — проблем не будет.

const app = express();
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(ok ${new Date().toISOString()});
});
app.use(cors());
// Парсим JSON даже если Content-Type странный
app.use(express.json({ type: "/", limit: "1mb" }));

// Простая проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(ok ${new Date().toISOString()});
});

// Главный прокси-эндпоинт
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    // Логи входящего запроса от Watbot
    console.log("➡ INCOMING from Watbot:", {
      method: req.method,
      url: targetUrl,
      headers: req.headers,
      body: req.body
    });

    // Пробрасываем только нужные заголовки
    const headersToForward = {};
    const allow = [
      "authorization",
      "content-type",
      "x-title",
      "http-referer",
      "referer",
      "accept"
    ];
    for (const k of allow) {
      if (req.headers[k]) headersToForward[k] = req.headers[k];
    }

    // Если Content-Type не задан — выставим JSON
    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    // Тело запроса в строку
    const bodyString =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    // Запрос к целевому API
    const upstream = await fetch(targetUrl, {
      method: "POST",
      headers: headersToForward,
      body: bodyString
    });

    const rawText = await upstream.text();

    // Лог ответа апстрима (обрезаем для читаемости)
    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    // Пытаемся вытащить «чистый текст» (для Chat Completions)
    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data.choices?.[0]?.text) {
        out = data.choices[0].text;
      } else if (typeof data === "string") {
        out = data;
      } else {
        out = rawText; // отдаём как есть
      }
    } catch {
      // не JSON — отдаём как есть
      out = rawText;
    }

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(out);

  } catch (e) {
    console.error("💥 PROXY ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8")
      .send("Ошибка на прокси-сервере");
  }
});

// Запуск
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(✅ watbot-proxy listening on ${PORT});
});
