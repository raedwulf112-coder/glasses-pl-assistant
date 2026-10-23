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
// Frontend: najpierw ./<name>.html (płaski układ repo na hostingu),
// potem ../webapp/<name>.html (lokalny układ roboczy).
function webappCandidates(name) {
  return [
    path.join(__dirname, name + ".html"),
    path.join(__dirname, "..", "webapp", name + ".html"),
  ];
}
function readWebapp(name) {
  for (const p of webappCandidates(name)) {
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

// Pytania wysłane z telefonu (POST /api/ask); okulary odbierają je przez GET /api/pending.
let pendingAsk = null; // { message, ts }
const PENDING_TTL_MS = 10 * 60 * 1000; // po 10 minutach nieodebrane pytanie wygasa

// --- Lista zakupów ---
// Jeden wspólny list: telefon dodaje pozycje, okulary odhaczają je w sklepie.
const LIST_FILE = path.join(__dirname, "shopping-list.json");
let listItems = []; // { id, text, done, ts }
let nextId = 1;

function loadList() {
  try {
    const raw = fs.readFileSync(LIST_FILE, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.items)) listItems = data.items;
    if (typeof data.nextId === "number") nextId = data.nextId;
  } catch {
    listItems = [];
    nextId = 1;
  }
  // porządek: niekupione najpierw, potem odhaczone (najpierw najstarsze)
  listItems.sort((a, b) => (a.done - b.done) || (a.ts - b.ts));
}
function saveList() {
  try {
    fs.writeFileSync(LIST_FILE, JSON.stringify({ items: listItems, nextId }), "utf-8");
  } catch {
    /* dysk tylko do odczytu — lista żyje w pamięci do restartu */
  }
}
loadList();

function handleListGet(req, res) {
  listItems.sort((a, b) => (a.done - b.done) || (a.ts - b.ts));
  return json(res, 200, { items: listItems });
}

async function handleListAdd(req, res) {
  let text = "";
  try {
    text = String(JSON.parse(await readBody(req) || "{}").text || "").trim().slice(0, 120);
  } catch { /* nieprawidłowy JSON */ }
  if (!text) return json(res, 400, { error: "Brak nazwy produktu" });
  const item = { id: nextId++, text, done: false, ts: Date.now() };
  listItems.push(item);
  saveList();
  return json(res, 200, { item, items: listItems });
}

async function handleListToggle(req, res) {
  let id = 0;
  try {
    id = Number(JSON.parse(await readBody(req) || "{}").id) || 0;
  } catch { /* nieprawidłowy JSON */ }
  const item = listItems.find((i) => i.id === id);
  if (!item) return json(res, 404, { error: "Nie znaleziono pozycji" });
  item.done = !item.done;
  saveList();
  return json(res, 200, { item, items: listItems });
}

async function handleListDelete(req, res) {
  let id = 0;
  try {
    id = Number(JSON.parse(await readBody(req) || "{}").id) || 0;
  } catch { /* nieprawidłowy JSON */ }
  const before = listItems.length;
  listItems = listItems.filter((i) => i.id !== id);
  if (listItems.length === before) return json(res, 404, { error: "Nie znaleziono pozycji" });
  saveList();
  return json(res, 200, { ok: true, items: listItems });
}

// Usuwa pozycje już odhaczone (po zakupach).
function handleListClearDone(req, res) {
  const removed = listItems.filter((i) => i.done).length;
  listItems = listItems.filter((i) => !i.done);
  saveList();
  return json(res, 200, { ok: true, removed, items: listItems });
}

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

async function readBody(req) {
  let body = "";
  for await (const ch of req) body += ch;
  return body;
}

function parseMessage(body) {
  let message = "";
  try {
    message = JSON.parse(body || "{}").message || "";
  } catch {
    /* pusty / nieprawidłowy JSON */
  }
  return String(message).trim().slice(0, 1000);
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

// Telefon wysyła pytanie, które okulary odbiorą przy następnym odpytaniu.
async function handleAsk(req, res) {
  const message = parseMessage(await readBody(req));
  if (!message) return json(res, 400, { error: "Brak pytania" });
  pendingAsk = { message, ts: Date.now() };
  return json(res, 200, { ok: true });
}

// Okulary odpytują co kilka sekund; jedno pytanie = jedna odpowiedź.
function handlePending(req, res) {
  let message = null;
  if (pendingAsk) {
    if (Date.now() - pendingAsk.ts < PENDING_TTL_MS) message = pendingAsk.message;
    pendingAsk = null;
  }
  return json(res, 200, { message });
}

const server = http.createServer((req, res) => {
  (async () => {
    const pathname = (req.url || "/").split("?")[0];
    if (req.method === "OPTIONS") return json(res, 204, {});
    if (pathname === "/api/chat" && req.method === "POST") return handleChat(req, res);
    if (pathname === "/api/ask" && req.method === "POST") return handleAsk(req, res);
    if (pathname === "/api/pending" && req.method === "GET") return handlePending(req, res);
    if (pathname === "/api/list" && req.method === "GET") return handleListGet(req, res);
    if (pathname === "/api/list/add" && req.method === "POST") return handleListAdd(req, res);
    if (pathname === "/api/list/toggle" && req.method === "POST") return handleListToggle(req, res);
    if (pathname === "/api/list/delete" && req.method === "POST") return handleListDelete(req, res);
    if (pathname === "/api/list/clear-done" && req.method === "POST") return handleListClearDone(req, res);
    if (pathname === "/" || pathname === "/index.html") {
      const html = readWebapp("index");
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      res.writeHead(500);
      return res.end("Brak pliku index.html z aplikacją");
    }
    if (pathname === "/lista" || pathname === "/lista.html") {
      const html = readWebapp("lista");
      if (html) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      res.writeHead(500);
      return res.end("Brak pliku lista.html z aplikacją");
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
