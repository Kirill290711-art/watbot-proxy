import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.post("/", async (req, res) => {
  try {
    // URL для запроса к OpenAI / OpenRouter
    const targetUrl = req.query.url;
    if (!targetUrl) {
      return res.status(400).send("Ошибка: не указан параметр ?url=");
    }

    // Запрос к API
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: req.headers, // Передаем те же заголовки, что и в Watbot
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    // Достаём только текст ответа
    let text = "";
    if (data.choices && data.choices[0]?.message?.content) {
      text = data.choices[0].message.content;
    } else if (typeof data === "string") {
      text = data;
    } else {
      text = JSON.stringify(data);
    }

    // Отдаём только чистый текст
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
