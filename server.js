import express from "express";
import cors from "cors";

const app = express();

app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Health-check
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
    console.log("➡ INCOMING from Watbot:", {
      method: req.method,
      url: targetUrl,
      headers: req.headers,
      body: req.body
    });

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

    console.log("⬅ UPSTREAM STATUS:", upstream.status);
    console.log("⬅ UPSTREAM RAW:", rawText.slice(0, 800));

    let out = rawText;
    try {
      const data = JSON.parse(rawText);
      if (data.choices?.[0]?.message?.content) {
        out = data.choices[0].message.content;
      } else if (data.choices?.[0]?.text) {
        out = data.choices[0].text;
      }
    } catch {
      // не JSON — оставляем как есть
    }

    // Возвращаем так, чтобы Watbot мог распарсить
    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(`var_result=${out}`);

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

