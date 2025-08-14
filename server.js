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

    const response = await fetch(targetUrl, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    let text = "";
    if (data.choices?.[0]?.message?.content) {
      text = data.choices[0].message.content;
    } else if (typeof data === "string") {
      text = data;
    } else {
      text = JSON.stringify(data);
    }

    // Явно указываем текст и кодировку
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(text);

  } catch (error) {
    console.error(error);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.status(500).send("Ошибка на сервере: " + error.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
