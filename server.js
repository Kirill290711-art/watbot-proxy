import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Функция декодирования \uXXXX в обычный текст
function decodeUnicode(str) {
  return str.replace(/\\u[\dA-Fa-f]{4}/g, m =>
    String.fromCharCode(parseInt(m.replace("\\u", ""), 16))
  );
}

// Проверка здоровья
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// Главный прокси
app.post("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    console.log("➡ INCOMING from Watbot:", targetUrl);

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

    console.log("⬅ STATUS:", upstream.status);
    console.log("⬅ RAW:", rawText.slice(0, 800));

    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data.choices?.[0]?.text) {
        out = data.choices[0].text;
      } else if (typeof data === "string") {
        out = data;
      }
    } catch {
      out = rawText;
    }

    // Декодируем Unicode (и для GPT, и для новостей)
    out = decodeUnicode(out);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ watbot-proxy listening on ${PORT}`);
});

