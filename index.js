// index.js
import express from "express";
import axios from "axios";
import { initDb, pool } from "./db.js";

const app = express();
app.use(express.json());

// 🔑 Variáveis do Render
const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;

const ADMIN_PASS = process.env.ADMIN_PASS;

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
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${WA_TOKEN}`,
          "Content-Type": "application/json",
        },
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
      status: err?.response?.status,
    });
    throw err;
  }
}

// =========================
// Funções de banco: USERS
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
// Funções de banco: RESTAURANTS
// =========================
async function isRestaurantPhone(phone) {
  const r = await pool.query(
    "select 1 from restaurants where phone_whatsapp = $1 limit 1",
    [phone]
  );
  return r.rowCount > 0;
}

async function getPartnerRestaurants() {
  const r = await pool.query(`
    SELECT id, name, contact_name, phone_whatsapp, neighborhood, city, state, accepts_cork_waiver
    FROM restaurants
    WHERE is_partner = true
    ORDER BY name ASC
  `);
  return r.rows;
}

function formatRestaurantMenu(restaurants) {
  let msg = "🍷 Qual restaurante você quer reservar?\n\n";
  restaurants.forEach((r, i) => {
    const place = [r.neighborhood, r.city].filter(Boolean).join(" - ");
    msg += `${i + 1}) ${r.name}${place ? ` (${place})` : ""}\n`;
  });
  msg += "\nResponda apenas com o número.";
  return msg;
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

    // ✅ MVP: se quem falou é um restaurante cadastrado, ignore por enquanto
    if (await isRestaurantPhone(phone)) {
      console.log("🏪 Mensagem de restaurante (ignorada no MVP):", phone, text);
      return res.sendStatus(200);
    }

    let user = await getUserByPhone(phone);

    // 1) Usuário não existe
    if (!user) {
      await createUser(phone);
      await sendWhatsAppText(phone, "Oi! 😊 Qual seu nome?");
      return res.sendStatus(200);
    }

    // 2) Usuário existe mas ainda não tem nome
    if (user.stage === "ASKED_NAME" && (!user.name || user.name.trim() === "")) {
      const name = normalizeName(text);

      if (!name) {
        await sendWhatsAppText(phone, "Pode me dizer seu nome? (ex.: Luciano)");
        return res.sendStatus(200);
      }

      await setUserNameActive(phone, name);

      // Após cadastrar, já manda a pergunta do restaurante
      const restaurants = await getPartnerRestaurants();
      if (restaurants.length === 0) {
        await sendWhatsAppText(
          phone,
          `Olá, ${name}! ✅ Cadastro concluído.\n\nAinda não temos restaurantes parceiros cadastrados 😔`
        );
        return res.sendStatus(200);
      }

      await pool.query(
        "update users set stage='CHOOSE_RESTAURANT', updated_at=now() where phone=$1",
        [phone]
      );

      await sendWhatsAppText(phone, `Olá, ${name}! ✅`);
      await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
      return res.sendStatus(200);
    }

    // 3) Usuário escolhendo restaurante
    if (user.stage === "CHOOSE_RESTAURANT") {
      const choice = parseInt(text, 10);

      if (Number.isNaN(choice)) {
        await sendWhatsAppText(phone, "Por favor, responda apenas com o número do restaurante.");
        return res.sendStatus(200);
      }

      const restaurants = await getPartnerRestaurants();

      if (restaurants.length === 0) {
        await pool.query(
          "update users set stage='ACTIVE', updated_at=now() where phone=$1",
          [phone]
        );
        await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
        return res.sendStatus(200);
      }

      if (choice < 1 || choice > restaurants.length) {
        await sendWhatsAppText(phone, "Número inválido. Escolha um da lista.");
        return res.sendStatus(200);
      }

      const selected = restaurants[choice - 1];

      // Envia para o restaurante (pré-reserva)
      const msgToRestaurant =
        `🍷 VinhoPay - Pré-reserva\n\n` +
        `Cliente: ${user.name || "Cliente"}\n` +
        `WhatsApp: ${phone}\n` +
        `Restaurante: ${selected.name}\n` +
        `Benefício: Isenção de rolha (VinhoPay)\n\n` +
        `Em breve enviaremos data/horário e nº de pessoas.\n` +
        `Se quiser falar com o cliente, responda para este número.`;

      await sendWhatsAppText(selected.phone_whatsapp, msgToRestaurant);

      // Por enquanto, volta o usuário para ACTIVE
      await pool.query(
        "update users set stage='ACTIVE', updated_at=now() where phone=$1",
        [phone]
      );

      await sendWhatsAppText(
        phone,
        `✅ Ok, ${user.name}! Enviei sua solicitação para o restaurante *${selected.name}*.\n` +
          `Já já seguimos com número de pessoas e data.`
      );

      return res.sendStatus(200);
    }

    // 4) Usuário ativo: mostrar lista de restaurantes
    if (user.stage === "ACTIVE") {
      const restaurants = await getPartnerRestaurants();

      if (restaurants.length === 0) {
        await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
        return res.sendStatus(200);
      }

      await pool.query(
        "update users set stage='CHOOSE_RESTAURANT', updated_at=now() where phone=$1",
        [phone]
      );

      await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
      return res.sendStatus(200);
    }

    // Fallback: se stage desconhecido, reseta para ACTIVE e mostra menu
    await pool.query("update users set stage='ACTIVE', updated_at=now() where phone=$1", [
      phone,
    ]);
    const restaurants = await getPartnerRestaurants();
    if (restaurants.length === 0) {
      await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
      return res.sendStatus(200);
    }
    await pool.query(
      "update users set stage='CHOOSE_RESTAURANT', updated_at=now() where phone=$1",
      [phone]
    );
    await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no webhook:", err?.response?.data || err);
    return res.sendStatus(200);
  }
});

// =========================
// Endpoint util: listar usuários
// =========================
app.get("/users", async (req, res) => {
  try {
    const r = await pool.query("select * from users order by created_at desc");
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erro ao buscar usuários" });
  }
});

// =========================
// Endpoint admin: set-name
// =========================
app.get("/set-name", async (req, res) => {
  try {
    const { phone, name, pass } = req.query;

    if (pass !== ADMIN_PASS) {
      return res.status(403).send("❌ Acesso negado: senha inválida");
    }

    if (!phone || !name) {
      return res.status(400).send("Use ?phone=...&name=...");
    }

    await pool.query(
      "update users set name=$1, stage='ACTIVE', updated_at=now() where phone=$2",
      [name, phone]
    );

    res.send(`✅ OK! Usuário ${phone} atualizado para nome=${name}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao atualizar usuário");
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
