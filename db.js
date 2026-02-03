import pg from "pg";

const { Pool } = pg;

// Render usa DATABASE_URL. Em produção, precisa SSL.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ✅ Força UTF-8 em TODA conexão nova do pool
pool.on("connect", (client) => {
  client.query("SET client_encoding TO 'UTF8'").catch((err) => {
    console.error("Erro ao SET client_encoding UTF8:", err);
  });
});

export async function initDb() {
  // Teste simples de conexão + encoding (não mexe em schema)
  await pool.query("SELECT 1");
}

