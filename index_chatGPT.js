import express from "express";
import OpenAI from "openai";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// =======================
// OpenAI client
// =======================
const apiKey = process.env.OPENAI_API_KEY;

const client = new OpenAI({
  apiKey,
});

// =======================
// Rota raiz
// =======================
app.get("/", (req, res) => {
  res.send("ok");
});

// =======================
// Função: consulta vinícola no ChatGPT
// =======================
async function consultarVinicola(vinicola) {
  if (!apiKey) {
    const err = new Error(
      "OPENAI_API_KEY não encontrada no ambiente. Feche e abra o terminal após usar setx."
    );
    err.code = "MISSING_OPENAI_API_KEY";
    throw err;
  }

  const prompt = `
Você é um sommelier. Dada a vinícola "${vinicola}", liste os 5 melhores vinhos mais conhecidos (ou mais representativos).
Para cada vinho, entregue:
- Nome do vinho
- Tipo (tinto/branco/espumante/rosé)
- Uva(s) principal(is) (se souber)
- Estilo (seco, frutado, encorpado etc.)
- Sugestão de harmonização (1 linha)
Responda em português e de forma objetiva.
`;

  const resp = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Você é um sommelier experiente e objetivo." },
      { role: "user", content: prompt },
    ],
    temperature: 0.7,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// =======================
// GET /teste?vinicola=Miolo
// =======================
app.get("/teste", async (req, res) => {
  try {
    const vinicola = (req.query.vinicola || "").toString().trim();

    if (!vinicola) {
      return res.status(400).json({
        ok: false,
        error: "Passe a vinícola: /teste?vinicola=Miolo",
      });
    }

    const texto = await consultarVinicola(vinicola);

    if (!texto) {
      return res.status(502).json({
        ok: false,
        error: "Resposta vazia do OpenAI",
      });
    }

    return res.json({
      ok: true,
      vinicola,
      resposta: texto,
    });
  } catch (err) {
    // log completo no terminal
    console.error("Erro ao consultar a vinícola:", {
      message: err?.message,
      code: err?.code,
      status: err?.status,
      response: err?.response?.data,
    });

    return res.status(500).json({
      ok: false,
      error: "Erro ao consultar a vinícola",
      details: err?.message || String(err),
      code: err?.code || null,
    });
  }
});

// =======================
// Start
// =======================
app.listen(PORT, () => {
  console.log(`VinhoPay bot rodando 🍷 na porta ${PORT}`);
});
