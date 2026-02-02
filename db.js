import pg from "pg";

const { Pool } = pg;

// Render usa DATABASE_URL. Em produção, precisa SSL.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

export async function initDb() {
  // 1) extensão para uuid (se não quiser uuid, eu simplifico depois)
  await pool.query(`create extension if not exists "uuid-ossp";`);

  // 2) tabela users
  await pool.query(`
    create table if not exists users (
      id uuid primary key default uuid_generate_v4(),
      phone text not null unique,
      name text,
      stage text not null default 'NEW',
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
  `);

  // 3) índice (opcional, mas bom)
  await pool.query(`create index if not exists idx_users_phone on users(phone);`);
}
