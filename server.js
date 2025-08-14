import express from "express";
import fetch from "node-fetch";

const app = express();

app.get("/", async (req, res) => {
  const apiUrl = req.query.url;
  if (!apiUrl) {
    return res.status(400).send("❌ Укажи параметр ?url=");
  }

  try {
    const response = await fetch(apiUrl);
    let text = await response.text();

    // Убираем все \uXXXX
    text = text.replace(/\\u[\dA-Fa-f]{4}/g, "");

    // Если JSON — превращаем в строку
    try {
      const json = JSON.parse(text);
      text = JSON.stringify(json);
    } catch {}

    res.type("text/plain").send(text);
  } catch (err) {
    res.status(500).send("Ошибка запроса: " + err.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`watbot-proxy running on port ${port}`));
