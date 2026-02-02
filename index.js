import express from "express";
import axios from "axios";
import { initDb, pool } from "./db.js";

const app = express();
app.use(express.json());

// 🔑 Agora usando os nomes corretos do Render
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

// =========================
// Função para enviar mensagem WhatsApp
// =========================
async function sendWhatsAppText(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text }
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    const e = err?.response?.data?.error;
    console.error("❌ Erro ao enviar WhatsApp (detalhado):", {
      message: e?.message,
      type: e?.type,
      code: e?.code,
      error_subcode: e?.error_subcode,
      fbtrace_id: e?.fbtrace_id,
      status: err?.response?.status
    });
    throw err;
  }
}

// =========================
// Funções de banco
// =========================
async function getUserByPhone(phone) {
  const r = await pool.query(
    "select id, phone, name, stage from users where phone = $1",
    [phone]
  );
  return r.rows[0] ?? null;
}

async function createUser(phone) {
  await pool.query(
    "insert into users (phone, stage) values ($1, 'ASKED_NAME') on conflict (phone) do nothing",
    [phone]
  );
}

async function setUserNameActive(phone, name) {
  await pool.query(
    "update users set name=$1, stage='ACTIVE', updated_at=now() where phone=$2",
    [name, phone]
  );
}

function normalizeName(raw) {
  if (!raw) return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 60) return null;
  return name;
}

// =========================
// Webhook de verificação (GET)
// =========================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// =========================
// Webhook de mensagens (POST)
// =========================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const phone = msg.from;
    const text = (msg?.text?.body || "").trim();

    console.log("📩 Mensagem recebida:", phone, text);

    let user = await getUserByPhone(phone);

    // Usuário não existe
    if (!user) {
      await createUser(phone);
      await sendWhatsAppText(phone, "Oi! 😊 Qual seu nome?");
      return res.sendStatus(200);
    }

    // Usuário existe mas ainda não tem nome
    if (user.stage === "ASKED_NAME" && (!user.name || user.name.trim() === "")) {
      const name = normalizeName(text);

      if (!name) {
        await sendWhatsAppText(phone, "Pode me dizer seu nome? (ex.: Luciano)");
        return res.sendStatus(200);
      }

      await setUserNameActive(phone, name);
      await sendWhatsAppText(phone, `Olá, ${name}! Como posso te ajudar?`);
      return res.sendStatus(200);
    }

    // Usuário já cadastrado
    await sendWhatsAppText(phone, `Olá, ${user.name}! Como posso te ajudar?`);
    return res.sendStatus(200);

  } catch (err) {
    console.error("❌ Erro no webhook:", err?.response?.data || err);
    return res.sendStatus(200);
  }
});

app.get("/users", async (req, res) => {
  try {
    const r = await pool.query("select * from users order by created_at desc");
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

app.put("/user/:phone", async (req, res) => {
  try {
    const { name } = req.body;
    const phone = req.params.phone;

    await pool.query(
      "update users set name=$1, stage='ACTIVE', updated_at=now() where phone=$2",
      [name, phone]
    );

    res.json({ ok: true, phone, name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao atualizar usuário" });
  }
});

// =========================
// Inicialização do servidor
// =========================
async function start() {
  try {
    console.log("WA_TOKEN length:", (WA_TOKEN || "").length);
    console.log("WA_PHONE_NUMBER_ID:", WA_PHONE_NUMBER_ID);

    await initDb();
    console.log("✅ Banco inicializado (tabelas OK)");
  } catch (err) {
    console.error("❌ Erro ao inicializar DB:", err);
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server rodando na porta ${port}`));
}

start();
