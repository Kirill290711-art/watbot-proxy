import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ type: "*/*", limit: "1mb" }));

// Проверка живости
app.get("/health", (req, res) => {
  res.type("text/plain; charset=utf-8").send(`ok ${new Date().toISOString()}`);
});

// Универсальный прокси — GET или POST, без ограничений
app.all("/", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).type("text/plain; charset=utf-8")
      .send("Ошибка: укажи параметр ?url=");
  }

  try {
    console.log("➡ INCOMING:", {
      method: req.method,
      url: targetUrl,
      headers: req.headers
    });

    const headersToForward = {};
    const allow = ["authorization", "content-type", "x-title", "http-referer", "referer", "accept"];
    for (const k of allow) {
      if (req.headers[k]) headersToForward[k] = req.headers[k];
    }

    if (!headersToForward["content-type"]) {
      headersToForward["content-type"] = "application/json";
    }

    const fetchOptions = {
      method: req.method,
      headers: headersToForward
    };

    if (req.method !== "GET" && req.body && Object.keys(req.body).length > 0) {
      fetchOptions.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }

    const upstream = await fetch(targetUrl, fetchOptions);
    const rawText = await upstream.text();
    console.log("⬅ UPSTREAM STATUS:", upstream.status);

    // Декодируем \uXXXX для русского
    const decodedText = rawText.replace(/\\u([\dA-F]{4})/gi, (_, g) =>
      String.fromCharCode(parseInt(g, 16))
    );

    res
      .status(upstream.ok ? 200 : upstream.status)
      .type("text/plain; charset=utf-8")
      .send(decodedText);

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

