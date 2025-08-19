import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// ===================== ПАРСИНГ ВИКИТЕКСТА =====================

function extractRuSection(text) {
  const m = text.match(/==Русский==([\s\S]*?)(\n==|$)/);
  return m ? m[1].trim() : "";
}

function firstPos(section) {
  const m = section.match(/===\s*([А-Яа-яЁёA-Za-z-]+)\s*===/);
  return m ? m[1].trim() : "";
}

function extractDefinition(section) {
  const m = section.match(/^[#]\s*(.+)/m);
  return m ? cleanWikitext(m[1]) : "";
}

function extractSynonyms(section) {
  const synSection = section.match(/====\s*Синонимы\s*====([\s\S]*?)(\n====|\n===|$)/);
  if (!synSection) return "";
  const syns = synSection[1]
    .split("\n")
    .map(line => line.replace(/^\*+\s*/, "").trim())
    .filter(Boolean);
  return syns.length ? syns.join(", ") : "";
}

function extractExamples(section) {
  const matches = [...section.matchAll(/^#\*\s*(.+)/gm)].map(m => cleanWikitext(m[1]));
  return matches.slice(0, 2);
}

// чистим {{шаблоны}}, [[ссылки]], HTML
function cleanWikitext(str) {
  return str
    .replace(/\{\{.*?\}\}/g, "")         // {{...}}
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, "$1") // [[...|...]]
    .replace(/<\/?[^>]+>/g, "")          // <...>
    .replace(/\s+/g, " ")
    .trim();
}

// ===================== ОБРАБОТЧИК =====================

async function wikidictHandler(req, res) {
  try {
    const word = (req.query.word ?? "").toString().trim();
    if (!word) {
      return res.status(400).type("text/plain; charset=utf-8").send("Ошибка: передай ?word=слово");
    }

    const url = `https://ru.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(
      word
    )}&prop=wikitext&format=json&redirects=1`;

    const r = await fetch(url, { headers: { "User-Agent": "watbot-proxy/1.0" } });
    const txt = await r.text();
    if (!r.ok) {
      return res.status(r.status).type("text/plain; charset=utf-8").send("Не удалось получить данные.");
    }

    let wiki = "";
    try {
      wiki = JSON.parse(txt)?.parse?.wikitext?.["*"] || "";
    } catch {}

    if (!wiki) {
      return res
        .type("text/plain; charset=utf-8")
        .send(`📚 ${word}\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`);
    }

    const ru = extractRuSection(wiki);
    if (!ru) {
      return res
        .type("text/plain; charset=utf-8")
        .send(`📚 ${word}\nЧасть речи: -\nТолкование: -\nСинонимы: -\nПример 1: -\nПример 2: -`);
    }

    const pos = firstPos(ru) || "-";
    const def = extractDefinition(ru) || "-";
    const syn = extractSynonyms(ru) || "-";
    const [ex1, ex2] = extractExamples(ru);

    const out = `📚 ${word}\nЧасть речи: ${pos}\nТолкование: ${def}\nСинонимы: ${syn}\nПример 1: ${
      ex1 || "-"
    }\nПример 2: ${ex2 || "-"}`;

    res.type("text/plain; charset=utf-8").set("Cache-Control", "no-store").send(out);
  } catch (e) {
    console.error("💥 WIKIDICT ERROR:", e);
    res.status(500).type("text/plain; charset=utf-8").send("Ошибка при запросе к Викисловарю");
  }
}

// ===================== РОУТЫ =====================

app.get("/wikidict", wikidictHandler);
app.get("/dict", wikidictHandler); // алиас для твоего бота
app.get("/health", (req, res) => res.send("ok"));

// ===================== СТАРТ =====================

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

