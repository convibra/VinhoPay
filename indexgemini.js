import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =======================
// Health
// =======================
app.get("/", (req, res) => {
  res.send("VinhoPay (Gemini) rodando 🍷");
});

// =======================
// Utils: dividir texto em blocos p/ WhatsApp
// (WhatsApp costuma aceitar bem até ~3500 chars, mas vamos ser conservadores)
// =======================
function splitForWhatsApp(text, maxLen = 1200) {
  const lines = text.split("\n");
  const chunks = [];
  let buf = "";

  for (const line of lines) {
    const next = (buf ? buf + "\n" : "") + line;
    if (next.length > maxLen) {
      if (buf) chunks.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// =======================
// Gemini (REST)
// =======================
async function askGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Faltou GEMINI_API_KEY nas variáveis de ambiente.");

  // Modelo estável e rápido (você pode trocar depois)
  const model = "gemini-1.5-flash";

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.6,
        maxOutputTokens: 700,
      },
    }),
  });

  const data = await resp.json();

  if (!resp.ok) {
    const msg = data?.error?.message || `Gemini HTTP ${resp.status}`;
    throw new Error(msg);
  }

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("")?.trim() || "";

  if (!text) throw new Error("Gemini retornou resposta vazia.");
  return text;
}

// =======================
// Prompt: curto, 5 itens, formato WhatsApp
// =======================
function buildWineryPrompt(vinicola) {
  return `
Você é um sommelier. Gere uma lista CURTA para WhatsApp.

Vinícola: "${vinicola}"

Quero EXATAMENTE 5 vinhos (os mais icônicos/recomendados da vinícola).
Para cada vinho, escreva em 3 linhas no máximo:
1) Nome do vinho (com emoji 🍷)
2) Descrição curtíssima (máx 120 caracteres)
3) Harmonização (máx 90 caracteres)

Regras:
- PT-BR.
- Lista numerada 1–5.
- Nada de introdução longa. Comece direto no item 1.
- Se algum rótulo não for certo, prefixe com "Sugestão:".
`.trim();
}

// =======================
// WhatsApp: enviar mensagem
// =======================
async function sendWhatsAppMessage(to, text) {
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const token = process.env.WA_TOKEN;

  if (!phoneNumberId || !token) {
    throw new Error("Faltou WA_PHONE_NUMBER_ID ou WA_TOKEN nas variáveis de ambiente.");
  }

  const url = `https://graph.facebook.com/v22.0/${phoneNumberId}/messages`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
}

// =======================
// Webhook GET (verificação Meta)
// =======================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =======================
// Webhook POST (recebe mensagens)
// =======================
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const msg = value?.messages?.[0];
    if (!msg || msg.type !== "text") return;

    const from = msg.from;
    const text = msg?.text?.body?.trim();

    console.log("Mensagem recebida:", JSON.stringify(req.body, null, 2));

    if (!text) {
      await sendWhatsAppMessage(from, "Envie o nome de uma vinícola. Ex: Miolo, Salton, Casa Valduga.");
      return;
    }

    const vinicola = text.slice(0, 60).trim();
    if (vinicola.length < 2) {
      await sendWhatsAppMessage(from, "Envie um nome de vinícola válido. Ex: Miolo.");
      return;
    }

    const resposta = await askGemini(buildWineryPrompt(vinicola));

    // Divide em partes para garantir entrega no WhatsApp
    const parts = splitForWhatsApp(resposta, 1200);

    // Se quiser, envia um cabeçalho curto
    await sendWhatsAppMessage(from, `🍷 Top 5 – ${vinicola}`);

    for (const part of parts) {
      await sendWhatsAppMessage(from, part);
    }
  } catch (err) {
    console.error("Erro no webhook:", err?.message || err);
  }
});

// =======================
// Rota de teste (sem WhatsApp)
// =======================
app.get("/teste", async (req, res) => {
  try {
    const vinicola = (req.query.vinicola || "Miolo").toString();
    const resposta = await askGemini(buildWineryPrompt(vinicola));
    res.type("text/plain").send(resposta);
  } catch (err) {
    console.error("Erro /teste:", err?.message || err);
    res.status(500).send(`Erro: ${err?.message || err}`);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
