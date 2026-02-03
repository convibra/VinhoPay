import pg from "pg";

const { Pool } = pg;

// Cria o pool de conexões
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false,
});

// 🔒 Garante UTF-8 em toda nova conexão (corrige problema do "Š")
pool.on("connect", async (client) => {
  try {
    await client.query("SET client_encoding TO 'UTF8'");
  } catch (err) {
    console.error("Erro ao definir client_encoding UTF8:", err);
  }
});

// =========================
// Inicialização do banco
// =========================
export async function initDb() {
  // 1) extensão para uuid
  await pool.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  // 2) tabela users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      phone text NOT NULL UNIQUE,
      name text,
      stage text NOT NULL DEFAULT 'NEW',
      active_reservation_id bigint,
      active_feedback_id bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // 3) índice (opcional)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
  `);

  console.log("✅ DB inicializado com UTF-8 garantido");
}
