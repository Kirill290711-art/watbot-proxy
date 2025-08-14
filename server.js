import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// Healthcheck
app.get("/health", (req, res) => {
  res.send("OK");
});

app.post("/", async (req, res) => {
  try {
    const targetUrl = req.query.url || "https://openrouter.ai/api/v1/chat/completions";
    if (!targetUrl) {
      return res.status(400).send("Ошибка: не указан параметр ?url=");
    }

    // Если модель пришла в query — заменяем её в теле запроса
    if (req.query.model) {
      if (!req.body.model) {
        req.body.model = req.query.model;
      } else {
        req.body.model = req.query.model; // перезаписываем
      }
    }

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    let text = "";
    if (data.choices && data.choices[0]?.message?.content) {
      text = data.choices[0].message.content;
    } else if (typeof data === "string") {
      text = data;
    } else {
      text = JSON.stringify(data);
    }

    res.send(text);

  } catch (error) {
    console.error(error);
    res.status(500).send("Ошибка на сервере");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});

