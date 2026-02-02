import express from "express";
import axios from "axios";
import { initDb, pool } from "./db.js";

const app = express();
app.use(express.json());

const META_TOKEN = process.env.META_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// =========================
// Função para enviar mensagem WhatsApp
// =========================
async function sendWhatsAppText(to, text) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    },
    {
      headers: {
        Authorization: `Bearer ${META_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
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

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
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

    const phone = msg.from; // telefone do usuário
    const text = (msg?.text?.body || "").trim();

    console.log("Mensagem recebida:", phone, text);

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
    console.error("Erro no webhook:", err);
    return res.sendStatus(200);
  }
});

// =========================
// Inicialização do servidor
// =========================
async function start() {
  try {
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
