import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/", async (req, res) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send("Ошибка: не указан параметр ?url=");
    }

    console.log("=== Новый запрос ===");
    console.log("URL:", targetUrl);
    console.log("Заголовки:", req.headers);
    console.log("Тело запроса:", JSON.stringify(req.body, null, 2));

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    console.log("Статус ответа от OpenRouter:", response.status);

    const data = await response.json();
    console.log("Тело ответа от OpenRouter:", JSON.stringify(data, null, 2));

    let text = "";
    if (data.choices && data.choices[0]?.message?.content) {
      text = data.choices[0].message.content;
    } else if (typeof data === "string") {
      text = data;
    } else {
      text = JSON.stringify(data);
    }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(text);

  } catch (error) {
    console.error("Ошибка на сервере:", error);
    res.status(500).send("Ошибка на сервере");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
