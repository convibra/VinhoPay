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

  // users: feedback ativo (você já tem no banco, mas garante caso suba em outro ambiente)
  await pool.query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS active_feedback_id BIGINT;
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

  // reservations: resposta do restaurante (confirmar/recusar + motivo)
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS restaurant_response_status VARCHAR(30);
  `);
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS restaurant_response_reason TEXT;
  `);
  await pool.query(`
    ALTER TABLE reservations
    ADD COLUMN IF NOT EXISTS restaurant_responded_at TIMESTAMP;
  `);

  // reservation_feedbacks: garante tabela (caso rode em outro ambiente)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reservation_feedbacks (
      id BIGSERIAL PRIMARY KEY,
      reservation_id BIGINT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
      status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
      step   VARCHAR(30) NOT NULL DEFAULT 'ASK_WINE',
      asked_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
      started_at TIMESTAMP WITHOUT TIME ZONE,
      completed_at TIMESTAMP WITHOUT TIME ZONE,
      wine_text TEXT,
      dish_text TEXT,
      rating_1_5 INT,
      comment_text TEXT,
      created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
      updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT now(),
      send_at TIMESTAMP WITHOUT TIME ZONE,
      CONSTRAINT reservation_feedbacks_rating_chk
        CHECK (rating_1_5 IS NULL OR (rating_1_5 BETWEEN 1 AND 5))
    );
  `);

  // índices essenciais
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ux_feedback_one_per_reservation
    ON reservation_feedbacks (reservation_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_feedback_send_at_status
    ON reservation_feedbacks (status, send_at);
  `);

  // FK opcional para active_reservation_id (se já existir, ignora via try/catch)
  try {
    await pool.query(`
      ALTER TABLE users
      ADD CONSTRAINT fk_users_active_reservation
      FOREIGN KEY (active_reservation_id) REFERENCES reservations(id)
      DEFERRABLE INITIALLY DEFERRED;
    `);
  } catch (_) {}

  // FK opcional para active_feedback_id
  try {
    await pool.query(`
      ALTER TABLE users
      ADD CONSTRAINT fk_users_active_feedback
      FOREIGN KEY (active_feedback_id) REFERENCES reservation_feedbacks(id)
      DEFERRABLE INITIALLY DEFERRED;
    `);
  } catch (_) {}

  // índice recomendado para fluxo do restaurante
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_res_pending_by_restaurant
    ON reservations (restaurant_id, status, created_at DESC);
  `);
}

// =========================
// Funções de banco: USERS
// =========================
async function getUserByPhone(phone) {
  const r = await pool.query(
    "select id, phone, name, stage, active_reservation_id, active_feedback_id from users where phone = $1",
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
  await pool.query("update users set name=$1, updated_at=now() where phone=$2", [
    name,
    phone,
  ]);
}

async function setUserStage(phone, stage) {
  await pool.query("update users set stage=$1, updated_at=now() where phone=$2", [
    stage,
    phone,
  ]);
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

async function setUserActiveFeedback(phone, feedbackId) {
  await pool.query(
    "update users set active_feedback_id=$1, updated_at=now() where phone=$2",
    [feedbackId, phone]
  );
}

async function clearUserActiveFeedback(phone) {
  await pool.query(
    "update users set active_feedback_id=NULL, updated_at=now() where phone=$1",
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
async function getRestaurantByPhone(phone) {
  const r = await pool.query(
    `SELECT id, name, contact_name, phone_whatsapp
     FROM restaurants
     WHERE phone_whatsapp = $1
     LIMIT 1`,
    [phone]
  );
  return r.rows[0] ?? null;
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

// ✅ agora vira pendente do restaurante
async function confirmReservation(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET status = 'PENDING_RESTAURANT',
         step = 'WAIT_RESTAURANT',
         restaurant_response_status = NULL,
         restaurant_response_reason = NULL,
         restaurant_responded_at = NULL,
         updated_at = now()
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

// ====== fluxo restaurante ======
async function getLatestPendingReservationForRestaurant(restaurantId) {
  const r = await pool.query(
    `SELECT r.*,
            u.phone AS user_phone,
            u.name  AS user_name,
            to_char(r.reserved_date, 'DD/MM/YYYY') AS reserved_date_br
     FROM reservations r
     JOIN users u ON u.id = r.user_id
     WHERE r.restaurant_id = $1
       AND r.status = 'PENDING_RESTAURANT'
       AND (r.restaurant_response_status IS NULL
            OR r.restaurant_response_status IN ('AWAITING_REASON', 'AWAITING_REASON_TEXT'))
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [restaurantId]
  );
  return r.rows[0] ?? null;
}

async function markRestaurantConfirmed(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET restaurant_response_status = 'CONFIRMED',
         restaurant_responded_at = now(),
         status = 'CONFIRMED',
         step = 'DONE',
         updated_at = now()
     WHERE id = $1`,
    [reservationId]
  );
}

async function markRestaurantAwaitReason(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET restaurant_response_status = 'AWAITING_REASON',
         updated_at = now()
     WHERE id = $1`,
    [reservationId]
  );
}

async function markRestaurantAwaitReasonText(reservationId) {
  await pool.query(
    `UPDATE reservations
     SET restaurant_response_status = 'AWAITING_REASON_TEXT',
         updated_at = now()
     WHERE id = $1`,
    [reservationId]
  );
}

async function markRestaurantRejected(reservationId, reasonText) {
  await pool.query(
    `UPDATE reservations
     SET restaurant_response_status = 'REJECTED',
         restaurant_response_reason = $2,
         restaurant_responded_at = now(),
         status = 'REJECTED',
         step = 'DONE',
         updated_at = now()
     WHERE id = $1`,
    [reservationId, reasonText]
  );
}

function restaurantDecisionMenu() {
  return (
    "🍷 VinhoPay - Confirmação de Reserva\n\n" +
    "Responda:\n" +
    "1 - Confirmar\n" +
    "0 - Recusar"
  );
}

function restaurantRejectReasonMenu() {
  return (
    "❌ Reserva recusada. Qual o motivo?\n\n" +
    "Responda:\n" +
    "1 - Lotado\n" +
    "2 - Não funciona neste horário\n" +
    "3 - Outro motivo (vou escrever)"
  );
}

// =========================
// Funções de banco: FEEDBACK
// =========================
async function ensureFeedbackForReservation(reservationId) {
  await pool.query(
    `
    INSERT INTO reservation_feedbacks (reservation_id, status, step, send_at)
    SELECT r.id,
           'PENDING',
           'ASK_WINE',
           (r.reserved_date::timestamp + r.reserved_time) + interval '90 minutes'
    FROM reservations r
    WHERE r.id = $1
      AND r.status = 'CONFIRMED'
      AND r.reserved_date IS NOT NULL
      AND r.reserved_time IS NOT NULL
    ON CONFLICT (reservation_id) DO NOTHING
    `,
    [reservationId]
  );
}

async function getActiveFeedbackByUser(user) {
  if (!user?.active_feedback_id) return null;
  const r = await pool.query(`SELECT * FROM reservation_feedbacks WHERE id = $1`, [
    user.active_feedback_id,
  ]);
  return r.rows[0] ?? null;
}

async function setFeedbackWine(feedbackId, wineText) {
  await pool.query(
    `
    UPDATE reservation_feedbacks
    SET wine_text = $1,
        step = 'ASK_DISH',
        status = 'IN_PROGRESS',
        updated_at = now()
    WHERE id = $2
    `,
    [wineText, feedbackId]
  );
}

async function setFeedbackDish(feedbackId, dishText) {
  await pool.query(
    `
    UPDATE reservation_feedbacks
    SET dish_text = $1,
        step = 'ASK_RATING',
        status = 'IN_PROGRESS',
        updated_at = now()
    WHERE id = $2
    `,
    [dishText, feedbackId]
  );
}

async function setFeedbackRating(feedbackId, rating) {
  await pool.query(
    `
    UPDATE reservation_feedbacks
    SET rating_1_5 = $1,
        step = 'ASK_COMMENT',
        status = 'IN_PROGRESS',
        updated_at = now()
    WHERE id = $2
    `,
    [rating, feedbackId]
  );
}

async function finishFeedback(feedbackId, commentText) {
  await pool.query(
    `
    UPDATE reservation_feedbacks
    SET comment_text = $1,
        step = 'DONE',
        status = 'DONE',
        completed_at = now(),
        updated_at = now()
    WHERE id = $2
    `,
    [commentText, feedbackId]
  );
}

// =========================
// Endpoint Cron: enviar feedbacks vencidos
// GET /jobs/send-due-feedbacks?pass=...
// =========================
app.get("/jobs/send-due-feedbacks", async (req, res) => {
  try {
    const pass = req.query.pass;
    if (pass !== ADMIN_PASS) return res.status(403).send("forbidden");

    const locked = await pool.query(`
      WITH due AS (
        SELECT f.id
        FROM reservation_feedbacks f
        WHERE f.status = 'PENDING'
          AND f.send_at IS NOT NULL
          AND f.send_at <= now()
        ORDER BY f.send_at ASC
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      UPDATE reservation_feedbacks f
      SET status = 'IN_PROGRESS',
          step = 'ASK_WINE',
          started_at = COALESCE(f.started_at, now()),
          updated_at = now()
      FROM due
      WHERE f.id = due.id
      RETURNING f.id, f.reservation_id
    `);

    let sent = 0;

    for (const row of locked.rows) {
      const rr = await pool.query(
        `
        SELECT f.id AS feedback_id,
               u.id AS user_id,
               u.phone AS user_phone,
               u.name AS user_name,
               rt.name AS restaurant_name
        FROM reservation_feedbacks f
        JOIN reservations r ON r.id = f.reservation_id
        JOIN users u ON u.id = r.user_id
        JOIN restaurants rt ON rt.id = r.restaurant_id
        WHERE f.id = $1
        LIMIT 1
        `,
        [row.id]
      );

      const item = rr.rows[0];
      if (!item?.user_phone) continue;

      await pool.query(
        `
        UPDATE users
        SET active_feedback_id = $1,
            stage = 'FEEDBACK_WINE',
            updated_at = now()
        WHERE id = $2
        `,
        [item.feedback_id, item.user_id]
      );

      await sendWhatsAppText(
        item.user_phone,
        `🍷 Oi${userName}! Gostaria de saber como foi sua experiência no *${restaurantName}* 😊\n\n` +`Qual vinho você levou? (Responda 0 para pular)`
      );

      sent++;
    }

    return res.json({ ok: true, locked: locked.rowCount, sent });
  } catch (err) {
    console.error("❌ job send-due-feedbacks:", err?.response?.data || err);
    return res.status(500).json({ ok: false });
  }
});

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
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
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
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
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

    // =========================
    // FLUXO DO RESTAURANTE
    // =========================
    const restaurantByPhone = await getRestaurantByPhone(phone);
    if (restaurantByPhone) {
      console.log("🏪 Mensagem do restaurante:", restaurantByPhone.name, phone, text);

      const pending = await getLatestPendingReservationForRestaurant(restaurantByPhone.id);

      if (!pending) {
        await sendWhatsAppText(phone, "Não encontrei nenhuma reserva pendente para confirmar/recusar no momento.");
        return res.sendStatus(200);
      }

      const rStatus = pending.restaurant_response_status;

      if (!rStatus) {
        if (text === "1") {
          await markRestaurantConfirmed(pending.id);

          // ✅ cria feedback agendado (+90min)
          await ensureFeedbackForReservation(pending.id);

          const timeStr = String(pending.reserved_time).slice(0, 5);
          await sendWhatsAppText(
            pending.user_phone,
            `✅ O restaurante *${restaurantByPhone.name}* confirmou sua reserva!\n\n` +
              `👥 Pessoas: ${pending.party_size}\n` +
              `📅 Data: ${pending.reserved_date_br}\n` +
              `⏰ Horário: ${timeStr}\n\n` +
              `Qualquer coisa, é só me chamar. 🍷`
          );

          await sendWhatsAppText(phone, "✅ Confirmado! Já avisei o cliente no WhatsApp.");
          return res.sendStatus(200);
        }

        if (text === "0") {
          await markRestaurantAwaitReason(pending.id);
          await sendWhatsAppText(phone, restaurantRejectReasonMenu());
          return res.sendStatus(200);
        }

        await sendWhatsAppText(phone, restaurantDecisionMenu());
        return res.sendStatus(200);
      }

      if (rStatus === "AWAITING_REASON") {
        if (text === "1") {
          await markRestaurantRejected(pending.id, "Lotado");
          await sendWhatsAppText(
            pending.user_phone,
            `❌ O restaurante *${restaurantByPhone.name}* não conseguiu confirmar sua reserva.\n` +
              `Motivo: Lotado.\n\n` +
              `Quer tentar outro restaurante? 🍷`
          );
          await sendWhatsAppText(phone, "OK. Registrei como *Lotado* e avisei o cliente.");
          return res.sendStatus(200);
        }

        if (text === "2") {
          await markRestaurantRejected(pending.id, "Não funciona neste horário");
          await sendWhatsAppText(
            pending.user_phone,
            `❌ O restaurante *${restaurantByPhone.name}* não conseguiu confirmar sua reserva.\n` +
              `Motivo: Não funciona neste horário.\n\n` +
              `Quer tentar outro restaurante? 🍷`
          );
          await sendWhatsAppText(phone, "OK. Registrei o motivo e avisei o cliente.");
          return res.sendStatus(200);
        }

        if (text === "3") {
          await markRestaurantAwaitReasonText(pending.id);
          await sendWhatsAppText(phone, "Por favor, escreva o motivo da recusa:");
          return res.sendStatus(200);
        }

        await sendWhatsAppText(phone, restaurantRejectReasonMenu());
        return res.sendStatus(200);
      }

      if (rStatus === "AWAITING_REASON_TEXT") {
        const reason = (text || "").trim();
        if (reason.length < 3) {
          await sendWhatsAppText(phone, "Motivo muito curto. Escreva uma frase, por favor:");
          return res.sendStatus(200);
        }

        await markRestaurantRejected(pending.id, reason);

        await sendWhatsAppText(
          pending.user_phone,
          `❌ O restaurante *${restaurantByPhone.name}* não conseguiu confirmar sua reserva.\n` +
            `Motivo: ${reason}\n\n` +
            `Quer tentar outro restaurante? 🍷`
        );

        await sendWhatsAppText(phone, "OK. Registrei o motivo e avisei o cliente.");
        return res.sendStatus(200);
      }

      await sendWhatsAppText(phone, "Essa reserva já foi respondida. Se houver outra pendente, eu aviso.");
      return res.sendStatus(200);
    }

    // =========================
    // FLUXO DO USUÁRIO
    // =========================
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

    // =========================
    // FLUXO DE FEEDBACK (usuário)
    // =========================
    if (user.stage === "FEEDBACK_WINE") {
      const fb = await getActiveFeedbackByUser(user);
      if (!fb) {
        await clearUserActiveFeedback(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, não encontrei seu feedback em andamento. 🙂");
        return res.sendStatus(200);
      }

      const wine = (text || "").trim();
      await setFeedbackWine(fb.id, wine === "0" ? null : wine);

      await setUserStage(phone, "FEEDBACK_DISH");
      await sendWhatsAppText(phone, "🍽️ E qual prato você pediu para acompanhar o vinho? (Responda 0 para pular)");
      return res.sendStatus(200);
    }

    if (user.stage === "FEEDBACK_DISH") {
      const fb = await getActiveFeedbackByUser(user);
      if (!fb) {
        await clearUserActiveFeedback(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, não encontrei seu feedback em andamento. 🙂");
        return res.sendStatus(200);
      }

      const dish = (text || "").trim();
      await setFeedbackDish(fb.id, dish === "0" ? null : dish);

      await setUserStage(phone, "FEEDBACK_RATING");
      await sendWhatsAppText(phone, "⭐ De 1 a 5, que nota você dá para o restaurante? (1 = ruim, 5 = excelente)");
      return res.sendStatus(200);
    }

    if (user.stage === "FEEDBACK_RATING") {
      const fb = await getActiveFeedbackByUser(user);
      if (!fb) {
        await clearUserActiveFeedback(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, não encontrei seu feedback em andamento. 🙂");
        return res.sendStatus(200);
      }

      const rating = parseInt(text, 10);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        await sendWhatsAppText(phone, "Por favor, digite uma nota de 1 a 5.");
        return res.sendStatus(200);
      }

      await setFeedbackRating(fb.id, rating);

      await setUserStage(phone, "FEEDBACK_COMMENT");
      await sendWhatsAppText(phone, "💬 Quer deixar um comentário rápido sobre a experiência? (Responda 0 para finalizar)");
      return res.sendStatus(200);
    }

    if (user.stage === "FEEDBACK_COMMENT") {
      const fb = await getActiveFeedbackByUser(user);
      if (!fb) {
        await clearUserActiveFeedback(phone);
        await setUserStage(phone, "ACTIVE");
        await sendWhatsAppText(phone, "Ops, não encontrei seu feedback em andamento. 🙂");
        return res.sendStatus(200);
      }

      const comment = (text || "").trim();
      await finishFeedback(fb.id, comment === "0" ? null : comment);

      await clearUserActiveFeedback(phone);
      await setUserStage(phone, "ACTIVE");

      await sendWhatsAppText(phone, "✅ Obrigado! Seu feedback foi registrado. 🍷");
      return res.sendStatus(200);
    }

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

      await sendWhatsAppText(phone, `✅ Você escolheu:\n${selected.name}\n\nPara quantas pessoas será a reserva?`);
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

    // 7) ASK_TIME
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

      const r2 = await pool.query(
        `SELECT party_size, to_char(reserved_date, 'DD/MM/YYYY') AS date_br
         FROM reservations
         WHERE id = $1`,
        [resv.id]
      );

      const partySize = r2.rows[0]?.party_size;
      const dateStr = r2.rows[0]?.date_br || "(data)";

      const msg2 = formatConfirmMessage(restaurant?.name || "Restaurante", partySize, dateStr, timeHHMM);
      await sendWhatsAppText(phone, msg2);
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
        `🍷 VinhoPay - Nova reserva (pendente)\n\n` +
        `Cliente: ${full.user_name || "Cliente"}\n` +
        `WhatsApp: ${full.user_phone}\n\n` +
        `Reserva:\n` +
        `👥 Pessoas: ${full.party_size}\n` +
        `📅 Data: ${full.reserved_date_br || full.reserved_date}\n` +
        `⏰ Horário: ${String(full.reserved_time).slice(0, 5)}\n` +
        `🎁 Benefício: Isenção de rolha (VinhoPay)\n\n` +
        `Responda:\n1 - Confirmar\n0 - Recusar`;

      if (restaurant?.phone_whatsapp) {
        await sendWhatsAppText(restaurant.phone_whatsapp, msgToRestaurant);
      }

      await setUserStage(phone, "WAIT_RESTAURANT");

      await sendWhatsAppText(
        phone,
        `⏳ Pedido enviado! Agora o restaurante *${restaurant?.name || ""}* precisa confirmar.\n\nAssim que eles responderem, eu te aviso aqui no WhatsApp. 🍷`
      );
      return res.sendStatus(200);
    }

    // 9) WAIT_RESTAURANT
    if (user.stage === "WAIT_RESTAURANT") {
      await sendWhatsAppText(
        phone,
        "⏳ Sua reserva ainda está aguardando confirmação do restaurante.\n\nAssim que eles responderem, eu te aviso aqui."
      );
      return res.sendStatus(200);
    }

    // 10) ACTIVE → mostra menu
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

    await pool.query("update users set name=$1, stage='ACTIVE', updated_at=now() where phone=$2", [name, phone]);

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
