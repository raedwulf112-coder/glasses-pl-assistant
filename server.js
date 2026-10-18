// Asystent PL — backend: przekazuje pytania z okularów do modelu językowego.
// Wymaga Node.js 18+. Bez zależności (npm install niepotrzebny).
//
// Zmienne środowiskowe:
//   LLM_API_KEY  – klucz API (wymagany)
//   LLM_API_URL  – endpoint w formacie OpenAI chat completions
//                  (domyślnie https://api.openai.com/v1/chat/completions)
//   LLM_MODEL    – model (domyślnie gpt-4o-mini)
//   PORT         – port (domyślnie 3000)
//
// Start:  LLM_API_KEY=sk-... node server.js
// Serwer serwuje też frontend (../webapp/index.html) pod "/",
// więc aplikacja na okulary i API mieszkają pod jednym adresem.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Frontend: najpierw ./index.html (płaski układ repo na hostingu),
// potem ../webapp/index.html (lokalny układ roboczy).
const WEBAPP_CANDIDATES = [
  path.join(__dirname, "index.html"),
  path.join(__dirname, "..", "webapp", "index.html"),
];
function readWebapp() {
  for (const p of WEBAPP_CANDIDATES) {
    try {
      return fs.readFileSync(p, "utf-8");
    } catch {
      /* próbuj dalej */
    }
  }
  return null;
}

const API_URL = process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions";
const API_KEY = process.env.LLM_API_KEY || "";
const MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const PORT = Number(process.env.PORT || 3000);

const SYSTEM_PL = [
  "Jesteś Asystentem PL — zwięzłym polskim asystentem na inteligentnych okularach.",
  "Odpowiadasz ZAWSZE po polsku, krótko (1–3 zdania), bo tekst widać na małym wyświetlaczu.",
  "Bez formatowania markdown, bez list — zwykłe zdania.",
].join(" ");

function json(res, code, obj) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(obj));
}

async function handleChat(req, res) {
  let body = "";
  for await (const ch of req) body += ch;
  let message = "";
  try {
    message = JSON.parse(body || "{}").message || "";
  } catch {
    /* pusty / nieprawidłowy JSON */
  }
  message = String(message).trim().slice(0, 1000);
  if (!message) return json(res, 400, { error: "Brak pytania" });
  if (!API_KEY) return json(res, 500, { error: "Serwer: brak klucza LLM_API_KEY" });

  const r = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      messages: [
        { role: "system", content: SYSTEM_PL },
        { role: "user", content: message },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    return json(res, 502, { error: `LLM ${r.status}: ${t.slice(0, 200)}` });
  }
  const data = await r.json();
  const reply = data.choices?.[0]?.message?.content?.trim() || "(pusta odpowiedź modelu)";
  return json(res, 200, { reply });
}

const server = http.createServer((req, res) => {
  (async () => {
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (req.url === "/api/chat" && req.method === "POST") return handleChat(req, res);
    if (req.url === "/" || req.url === "/index.html") {
      const html = readWebapp();
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      res.writeHead(500);
      return res.end("Brak pliku index.html z aplikacją");
    }
    res.writeHead(404);
    res.end("Nie znaleziono");
  })().catch((e) => {
    try {
      json(res, 500, { error: String(e).slice(0, 200) });
    } catch {
      /* połączenie już zamknięte */
    }
  });
});

server.listen(PORT, () => console.log(`Asystent PL backend: http://localhost:${PORT}`));
