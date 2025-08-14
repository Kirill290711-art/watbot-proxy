const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

app.all('/', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('Укажи параметр ?url=');

  try {
    const fetchRes = await fetch(targetUrl, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body),
    });

    let text = await fetchRes.text();

    // Декодим Unicode-последовательности
    text = text.replace(/\\u[\dA-Fa-f]{4}/g, match =>
      String.fromCharCode(parseInt(match.replace('\\u', ''), 16))
    );

    res.set('Content-Type', fetchRes.headers.get('content-type') || 'application/json');
    res.send(text);
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

app.listen(3000, () => console.log('Proxy running on port 3000'))
