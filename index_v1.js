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
// WhatsApp: enviar mensagem
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
// DB helpers: schema (MVP)
// =========================
async function ensureSchema() {
  // users: active_reservation_id (para saber qual rascunho está aberto)
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_reservation_id BIGINT;
  `);

  // reservations: armazenar mês/dia/ano durante o fluxo (antes de montar DATE)
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS reserved_year INT;
  `);
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS reserved_month INT;
  `);
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS reserved_day INT;
  `);
}

// =========================
// Funções de banco: USERS
// =========================
async function getUserByPhone(phone) {
  const r = await pool.query(
    "select id, phone, name, stage, active_reservation_id from users where phone = $1",
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

async function setUserName(phone, name) {
  await pool.query(
    "update users set name=$1, updated_at=now() where phone=$2",
    [name, phone]
  );
}

async function setUserStage(phone, stage) {
  await pool.query(
    "update users set stage=$1, updated_at=now() where phone=$2",
    [stage, phone]
  );
}

async function setUserActiveReservation(phone, reservationId) {
  await pool.query(
    "update users set active_reservation_id=$1, updated_at=now() where phone=$2",
    [reservationId, phone]
  );
}

async function clearUserActiveReservation(phone) {
  await pool.query(
    "update users set active_reservation_id=NULL, updated_at=now() where phone=$1",
    [phone]
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

async function getRestaurantById(id) {
  const r = await pool.query(
    `SELECT id, name, contact_name, phone_whatsapp, neighborhood, city, state, accepts_cork_waiver
     FROM restaurants
     WHERE id = $1`,
    [id]
  );
  return r.rows[0] ?? null;
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
// Funções de banco: RESERVATIONS
// =========================
async function createDraftReservation(userId, restaurantId) {
  const r = await pool.query(
    `INSERT INTO reservations (user_id, restaurant_id, status, step)
     VALUES ($1, $2, 'DRAFT', 'ASK_PARTY_SIZE')
     RETURNING id`,
    [userId, restaurantId]
  );
  return r.rows[0].id;
}

async function getActiveReservationByUser(user) {
  if (!user?.active_reservation_id) return null;
  const r = await pool.query(
    `SELECT *
     FROM reservations
     WHERE id = $1 AND user_id = $2`,
    [user.active_reservation_id, user.id]
  );
  return r.rows[0] ?? null;
}

async function setReservationPartySize(reservationId, partySize) {
  await pool.query(
    `UPDATE reservations
     SET party_size = $1, step = 'ASK_MONTH', updated_at = now()
     WHERE id = $2`,
    [partySize, reservationId]
  );
}

async function setReservationMonth(reservationId, year, month) {
  await pool.query(
    `UPDATE reservations
     SET reserved_year = $1, reserved_month = $2, step = 'ASK_DAY', updated_at = now()
     WHERE id = $3`,
    [year, month, reservationId]
  );
}

async function setReservationDayAndDate(reservationId, year, month, day) {
  await pool.query(
    `UPDATE reservations
     SET reserved_day = $1,
         reserved_date = make_date($2, $3, $1),
         step = 'ASK_TIME',
         updated_at = now()
     WHERE id = $4`,
    [day, year, month, reservationId]
  );
}

async function setReservationTime(reservationId, timeHHMM) {
  await pool.query(
    `UPDATE reservations
     SET reserved_time = $1::time, step = 'CONFIRM', updated_at = now()
     WHERE id = $2`,
    [timeHHMM, reservationId]
  );
}

async function confirmReservation(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET status = 'CONFIRMED', step = 'DONE', updated_at = now()
     WHERE id = $1`,
    [reservationId]
  );
}

async function cancelReservation(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET status = 'CANCELLED', step = 'DONE', updated_at = now()
     WHERE id = $1`,
    [reservationId]
  );
}

// =========================
// Validações de entrada
// =========================
function parsePartySize(text) {
  const n = parseInt(text, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 50) return null;
  return n;
}

function parseMonth(text) {
  const n = parseInt(text, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 12) return null;
  return n;
}

function isValidDay(year, month, day) {
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const d = new Date(Date.UTC(year, month - 1, day));
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day
  );
}

function parseDay(text) {
  const n = parseInt(text, 10);
  if (!Number.isInteger(n)) return null;
  if (n < 1 || n > 31) return null;
  return n;
}

function parseTimeHHMM(text) {
  const t = text.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23) return null;
  if (mm < 0 || mm > 59) return null;
  const hh2 = String(hh).padStart(2, "0");
  const mm2 = String(mm).padStart(2, "0");
  return `${hh2}:${mm2}`;
}

function monthMenuText() {
  return (
    "Para qual mês?\n" +
    "Digite o número:\n" +
    "1) Janeiro\n2) Fevereiro\n3) Março\n4) Abril\n5) Maio\n6) Junho\n" +
    "7) Julho\n8) Agosto\n9) Setembro\n10) Outubro\n11) Novembro\n12) Dezembro"
  );
}

function formatConfirmMessage(restaurantName, partySize, dateStr, timeStr) {
  return (
    "✅ Confirme sua reserva:\n\n" +
    `🍽 Restaurante: ${restaurantName}\n` +
    `👥 Pessoas: ${partySize}\n` +
    `📅 Data: ${dateStr}\n` +
    `⏰ Horário: ${timeStr}\n` +
    "🎁 Benefício: Isenção de rolha (VinhoPay)\n\n" +
    "Digite:\n1 - Confirmar\n0 - Cancelar"
  );
}

// =========================
// Webhook verify (GET)
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
// Webhook messages (POST)
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

    // ✅ MVP: se veio de um restaurante cadastrado, ignore por enquanto
    if (await isRestaurantPhone(phone)) {
      console.log("🏪 Mensagem de restaurante (ignorada no MVP):", phone, text);
      return res.sendStatus(200);
    }

    let user = await getUserByPhone(phone);

    // 1) Usuário não existe → pede nome
    if (!user) {
      await createUser(phone);
      await sendWhatsAppText(phone, "Oi! 😊 Qual seu nome?");
      return res.sendStatus(200);
    }

    // 2) Usuário está no estágio de nome
    if (user.stage === "ASKED_NAME" && (!user.name || user.name.trim() === "")) {
      const name = normalizeName(text);
      if (!name) {
        await sendWhatsAppText(phone, "Pode me dizer seu nome? (ex.: Luciano)");
        return res.sendStatus(200);
      }

      await setUserName(phone, name);
      await setUserStage(phone, "ACTIVE");

      const restaurants = await getPartnerRestaurants();
      if (restaurants.length === 0) {
        await sendWhatsAppText(
          phone,
          `Olá, ${name}! ✅ Cadastro concluído.\n\nAinda não temos restaurantes parceiros cadastrados 😔`
        );
        return res.sendStatus(200);
      }

      await setUserStage(phone, "CHOOSE_RESTAURANT");
      await sendWhatsAppText(phone, `Olá, ${name}! ✅`);
      await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
      return res.sendStatus(200);
    }

    // Recarrega user (pode ter mudado)
    user = await getUserByPhone(phone);

    // 3) Escolhendo restaurante
    if (user.stage === "CHOOSE_RESTAURANT") {
      const choice = parseInt(text, 10);
      if (Number.isNaN(choice)) {
        await sendWhatsAppText(phone, "Por favor, responda apenas com o número do restaurante.");
        return res.sendStatus(200);
      }

      const restaurants = await getPartnerRestaurants();
      if (restaurants.length === 0) {
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
        return res.sendStatus(200);
      }

      if (choice < 1 || choice > restaurants.length) {
        await sendWhatsAppText(phone, "Número inválido. Escolha um da lista.");
        return res.sendStatus(200);
      }

      const selected = restaurants[choice - 1];

      const reservationId = await createDraftReservation(user.id, selected.id);
      await setUserActiveReservation(phone, reservationId);

      await setUserStage(phone, "ASK_PARTY_SIZE");

      await sendWhatsAppText(
        phone,
        `✅ Você escolheu:\n${selected.name}\n\nPara quantas pessoas será a reserva?`
      );
      return res.sendStatus(200);
    }

    // 4) ASK_PARTY_SIZE
    if (user.stage === "ASK_PARTY_SIZE") {
      const resv = await getActiveReservationByUser(user);
      if (!resv) {
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Vamos recomeçar 🙂 Qual restaurante você quer reservar?");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      const partySize = parsePartySize(text);
      if (!partySize) {
        await sendWhatsAppText(phone, "Quantas pessoas? (Digite um número entre 1 e 50)");
        return res.sendStatus(200);
      }

      await setReservationPartySize(resv.id, partySize);
      await setUserStage(phone, "ASK_MONTH");

      await sendWhatsAppText(phone, monthMenuText());
      return res.sendStatus(200);
    }

    // 5) ASK_MONTH
    if (user.stage === "ASK_MONTH") {
      const resv = await getActiveReservationByUser(user);
      if (!resv) {
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, perdi sua reserva em andamento. Vamos escolher o restaurante novamente?");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      const month = parseMonth(text);
      if (!month) {
        await sendWhatsAppText(phone, "Mês inválido. Digite um número de 1 a 12.");
        await sendWhatsAppText(phone, monthMenuText());
        return res.sendStatus(200);
      }

      const now = new Date();
      const currentMonth = now.getMonth() + 1;
      const currentYear = now.getFullYear();
      const year = month < currentMonth ? currentYear + 1 : currentYear;

      await setReservationMonth(resv.id, year, month);
      await setUserStage(phone, "ASK_DAY");

      await sendWhatsAppText(phone, "Qual o dia do mês? (1 a 31)");
      return res.sendStatus(200);
    }

    // 6) ASK_DAY
    if (user.stage === "ASK_DAY") {
      const resv = await getActiveReservationByUser(user);
      if (!resv) {
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, perdi sua reserva em andamento. Vamos escolher o restaurante novamente?");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      const day = parseDay(text);
      const year = resv.reserved_year;
      const month = resv.reserved_month;

      if (!day || !year || !month || !isValidDay(year, month, day)) {
        await sendWhatsAppText(phone, "Dia inválido para esse mês. Digite novamente (ex: 15).");
        return res.sendStatus(200);
      }

      await setReservationDayAndDate(resv.id, year, month, day);
      await setUserStage(phone, "ASK_TIME");

      await sendWhatsAppText(phone, "Qual o horário desejado? (ex: 19:30)");
      return res.sendStatus(200);
    }

    // 7) ASK_TIME (timezone-safe)
    if (user.stage === "ASK_TIME") {
      const resv = await getActiveReservationByUser(user);
      if (!resv) {
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, perdi sua reserva em andamento. Vamos escolher o restaurante novamente?");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      const timeHHMM = parseTimeHHMM(text);
      if (!timeHHMM) {
        await sendWhatsAppText(phone, "Horário inválido. Use o formato HH:MM (ex: 19:30).");
        return res.sendStatus(200);
      }

      await setReservationTime(resv.id, timeHHMM);
      await setUserStage(phone, "CONFIRM");

      const restaurant = await getRestaurantById(resv.restaurant_id);

      // Pega dados atualizados e formata data no Postgres (evita bug de fuso)
      const r2 = await pool.query(
        `SELECT party_size,
                to_char(reserved_date, 'DD/MM/YYYY') AS date_br
         FROM reservations
         WHERE id = $1`,
        [resv.id]
      );

      const partySize = r2.rows[0]?.party_size;
      const dateStr = r2.rows[0]?.date_br || "(data)";

      const msg = formatConfirmMessage(
        restaurant?.name || "Restaurante",
        partySize,
        dateStr,
        timeHHMM
      );

      await sendWhatsAppText(phone, msg);
      return res.sendStatus(200);
    }

    // 8) CONFIRM
    if (user.stage === "CONFIRM") {
      const resv = await getActiveReservationByUser(user);
      if (!resv) {
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Não encontrei sua reserva em andamento. Vamos começar de novo?");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      if (text === "0") {
        await cancelReservation(resv.id);
        await clearUserActiveReservation(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "❌ Reserva cancelada. Se quiser, escolha outro restaurante.");
        await setUserStage(phone, "CHOOSE_RESTAURANT");
        const restaurants = await getPartnerRestaurants();
        if (restaurants.length) await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
        return res.sendStatus(200);
      }

      if (text !== "1") {
        await sendWhatsAppText(phone, "Digite 1 para Confirmar ou 0 para Cancelar.");
        return res.sendStatus(200);
      }

      await confirmReservation(resv.id);

      // Recarrega dados completos + data BR formatada no Postgres
      const rr = await pool.query(
        `SELECT r.*, 
                u.name as user_name, 
                u.phone as user_phone,
                to_char(r.reserved_date, 'DD/MM/YYYY') as reserved_date_br
         FROM reservations r
         JOIN users u ON u.id = r.user_id
         WHERE r.id = $1`,
        [resv.id]
      );

      const full = rr.rows[0];
      const restaurant = await getRestaurantById(full.restaurant_id);

      const msgToRestaurant =
        `🍷 VinhoPay - Reserva\n\n` +
        `Cliente: ${full.user_name || "Cliente"}\n` +
        `WhatsApp: ${full.user_phone}\n\n` +
        `Reserva:\n` +
        `👥 Pessoas: ${full.party_size}\n` +
        `📅 Data: ${full.reserved_date_br || full.reserved_date}\n` +
        `⏰ Horário: ${String(full.reserved_time).slice(0, 5)}\n` +
        `🎁 Benefício: Isenção de rolha (VinhoPay)\n\n` +
        `Contato do responsável: ${restaurant?.contact_name || "-"}\n`;

      if (restaurant?.phone_whatsapp) {
        await sendWhatsAppText(restaurant.phone_whatsapp, msgToRestaurant);
      }

      await clearUserActiveReservation(phone);
      await setUserStage(phone, "ACTIVE");

      await sendWhatsAppText(
        phone,
        `✅ Reserva confirmada! Enviei os detalhes para o restaurante *${restaurant?.name || ""}*.\n\nSe quiser fazer outra reserva, é só me chamar.`
      );
      return res.sendStatus(200);
    }

    // 9) ACTIVE → mostra menu
    if (user.stage === "ACTIVE") {
      const restaurants = await getPartnerRestaurants();
      if (restaurants.length === 0) {
        await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
        return res.sendStatus(200);
      }
      await setUserStage(phone, "CHOOSE_RESTAURANT");
      await sendWhatsAppText(phone, formatRestaurantMenu(restaurants));
      return res.sendStatus(200);
    }

    // Fallback: reseta
    await setUserStage(phone, "ACTIVE");
    const restaurants = await getPartnerRestaurants();
    if (restaurants.length === 0) {
      await sendWhatsAppText(phone, "Ainda não temos restaurantes parceiros cadastrados 😔");
      return res.sendStatus(200);
    }
    await setUserStage(phone, "CHOOSE_RESTAURANT");
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
    await ensureSchema();
    console.log("✅ Banco inicializado + schema garantido");
  } catch (err) {
    console.error("❌ Erro ao inicializar DB:", err);
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server rodando na porta ${port}`));
}

start();
