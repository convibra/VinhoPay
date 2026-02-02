import express from "express";
import { initDb } from "./db.js";

const app = express();
app.use(express.json());

async function start() {
  try {
    await initDb();
    console.log("✅ Banco inicializado (tabelas OK)");
  } catch (err) {
    console.error("❌ Erro ao inicializar DB:", err);
    // não derruba o servidor necessariamente, mas eu recomendo derrubar:
    process.exit(1);
  }

  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server rodando na porta ${port}`));
}

start();
