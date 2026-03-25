import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import mongoose from "mongoose";
import rateLimit from "express-rate-limit";
import nodemailer from "nodemailer";

dotenv.config();

// ---------------- Email (Nodemailer) ----------------
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

async function enviarCodigoEmail(destinatario, codigo) {
  const mailOptions = {
    from: `"Esfera" <${process.env.EMAIL_USER}>`,
    to: destinatario,
    subject: "Código de Verificação - Esfera",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">Bem-vindo ao clube</h2>
        <p>O teu código de verificação é:</p>
        <div style="background: #e68a00; padding: 15px; text-align: center; 
                    font-size: 28px; font-weight: bold; letter-spacing: 6px; 
                    border-radius: 8px; margin: 20px 0;">
          ${codigo}
        </div>
        <p style="color: #666; font-size: 14px;">
          Se não pediste este código, ignora este email.
        </p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MONGO_URI = process.env.MONGO_URI;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

await mongoose.connect(MONGO_URI);
console.log("✅ Ligado ao MongoDB");

// ---------------- Helpers ----------------
function hojeYYYYMMDD() {
  return new Date().toISOString().slice(0, 10);
}

function passwordIsStrong(password) {
  const p = (password || "").trim();
  if (!p || p.length < 8) return false;
  return /[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);
}

function gerarNumeroNormal() {
  return 500 + Math.floor(Math.random() * 500); // 500-999
}
function gerarNumeroPremium() {
  return Math.floor(Math.random() * 499) + 1; // 1-499
}

function gerarCodigoSeguranca() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function verificarCodigoSeguranca(user, codigo) {
  if (!codigo) return false;
  return bcrypt.compare(String(codigo).trim(), user.codigoSegurancaHash);
}

function quotaValorPorTipo(tipo) {
  if (tipo === "Normal") return 5;
  if (tipo === "Premium") return 10;
  return 0;
}

// ---- Quotas: helpers profissionais ----
function ymToInt(ano, mes) { return (Number(ano) * 12) + (Number(mes) - 1); }
function intToYM(v) { return { ano: Math.floor(v / 12), mes: (v % 12) + 1 }; }

function parseYYYYMMDD(s) {
  if (!s || typeof s !== "string") return null;
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(Date.UTC(y, m - 1, d));
}

function endOfMonthUTC(ano, mes) {
  // último dia do mês (UTC)
  return new Date(Date.UTC(ano, mes, 0, 23, 59, 59, 999)); // mes aqui é 1-12, e "0" dá o último do anterior; por isso usamos mes e 0 para último do mês pretendido
}

function daysBetweenUTC(a, b) {
  const ms = 24 * 60 * 60 * 1000;
  const da = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const db = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.floor((db - da) / ms);
}

async function getQuotaStatus(email) {
  const user = await User.findOne({ email }).lean();
  if (!user) return { ok: false, error: "Utilizador não encontrado." };
  if (user.tipo === "Adepto") return { ok: false, error: "Apenas sócios podem ver/pagar quotas.", code: 403 };

  const valorMensal = quotaValorPorTipo(user.tipo);

  // define o “início de quotas”
  let inicio = user.socioDesde;
  if (!inicio) {
    // fallback: se não existir, considera hoje (evita crash)
    inicio = hojeYYYYMMDD();
  }
  const d0 = parseYYYYMMDD(inicio);
  const startYM = ymToInt(d0.getUTCFullYear(), d0.getUTCMonth() + 1);

  const now = new Date();
  const nowYM = ymToInt(now.getUTCFullYear(), now.getUTCMonth() + 1);

  // meses pagos
  const pagos = await QuotaPayment.find({ email }).sort({ ano: 1, mes: 1 }).lean();
  const paidSet = new Set(pagos.map(p => ymToInt(p.ano, p.mes)));

  // encontra o próximo mês por pagar (a partir do início)
  let nextUnpaid = startYM;
  while (paidSet.has(nextUnpaid)) nextUnpaid++;

  // “em atraso”: meses por pagar até ao mês atual
  const overdueMonths = Math.max(0, (nowYM - nextUnpaid) + 1); // se nextUnpaid <= nowYM, existe atraso

  // validade: se está tudo pago até ao mês atual, calcula até quando está pago (paidUntil = último mês pago consecutivo a partir do início)
  let paidUntil = startYM - 1;
  while (paidSet.has(paidUntil + 1)) paidUntil++;

  // dias restantes: até ao fim do mês paidUntil (se paidUntil >= nowYM, tem cobertura)
  let diasRestantes = 0;
  let validadeAte = null;

  if (paidUntil >= nowYM) {
    const { ano, mes } = intToYM(paidUntil);
    const fim = endOfMonthUTC(ano, mes);
    diasRestantes = Math.max(0, daysBetweenUTC(new Date(), fim));
    validadeAte = `${ano}-${String(mes).padStart(2, "0")}-${String(new Date(Date.UTC(ano, mes, 0)).getUTCDate()).padStart(2, "0")}`;
  } else {
    diasRestantes = 0;
    validadeAte = null;
  }

  const next = intToYM(nextUnpaid);

  return {
    ok: true,
    userTipo: user.tipo,
    valorMensal,
    socioDesde: inicio,
    nextUnpaid: next, // {ano, mes}
    overdueMonths,
    paidUntil: (paidUntil >= startYM ? intToYM(paidUntil) : null),
    diasRestantes,
    validadeAte,
    pagos,
  };
}

// ---- Bilhetes: preços no servidor ----
function ticketPriceTable() {
  // ajusta como quiseres, mas fica consistente e “à prova de bugs”
  return {
    "Central_A1": 3.00,
    "Central_A2": 3.00,
    "Laterais": 2.00,
    "Zona VIP" :5
  };
}
function calcTicketUnitPrice(setor, user) {
  const base = ticketPriceTable()[setor];
  if (!base) return null;

  // VIP: preço fixo
  if (setor === "Zona VIP") return base;

  // descontos simples
  if (user.tipo === "Premium") return Number((base * 0.8).toFixed(2)); // -20%
  if (user.tipo === "Normal") return Number((base * 0.9).toFixed(2));  // -10%
  return base; // Adepto
}

// ---------------- Segurança: Rate Limiter ---------------- 
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 7, // Limite de 7 tentativas por IP
  standardHeaders: true, // Retorna info nos headers `RateLimit-*`
  legacyHeaders: false, // Desativa os headers `X-RateLimit-*`
  message: { 
    error: "Muitas tentativas de login incorretas. Por segurança, tente novamente daqui a 15 minutos." 
  }, // Mensagem JSON compatível com o teu frontend
});

// ---------------- DB: Jogos ----------------
const gameSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    titulo: { type: String, required: true },
    data: { type: String, required: true }, // YYYY-MM-DD
    hora: { type: String, required: true },
    local: { type: String, required: true },
    competicao: { type: String, required: true },
    adversario: { type: String, required: true },
    resultado: { type: String, default: "" },
    status: { type: String, default: "agendado" },
    pontos: { type: String, default: "" },
    attendanceCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);
const Game = mongoose.model("Jogos", gameSchema , "Jogos");

const seedGames = [
  { slug: "esfera-vs-boa-vista-2026-02-15", titulo: "Esfera vs Boa Vista", data: "2026-02-15", hora: "18:00", local: "Pavilhão Desportivo da Ajuda", competicao: "Segunda Divisão", adversario: "Boa Vista", resultado: "32 - 45", pontos: "2", status: "vitoria" },
  { slug: "esfera-vs-sporting-b-2026-02-22", titulo: "Esfera vs Sporting B", data: "2026-02-22", hora: "21:00", local: "Pavilhao Joao Rocha", competicao: "Segunda Divisão", adversario: "Sporting B", resultado: "28 - 28", pontos: "1", status: "empate" },
  { slug: "esfera-vs-sao-joao-da-madeira-2026-03-01", titulo: "Esfera vs São joao da Madeira", data: "2026-03-01", hora: "20:00", local: "Pavilhão Municipal das Travessas", competicao: "Segunda Divisão", adversario: "São joao da Madeira", resultado: "26 - 31", pontos: "2", status: "vitoria" },
  { slug: "esfera-vs-CD-Feirense-2026-03-15", titulo: "Esfera vs CD Feirense", data: "2026-03-15", hora: "20:15", local: "Pavilhão ginasio sao joão de ver", competicao: "Segunda Divisão", adversario: "CD Feirense", resultado: "28 - 23", pontos: "2", status: "vitoria" },
  { slug: "esfera-vs-almada-2026-03-18", titulo: "Esfera vs Almada", data: "2026-03-18", hora: "20:00", local: "Pavilhão Desportivo da Ajuda", competicao: "Segunda Divisão", adversario: "Almada", resultado: "29 - 32", pontos: "0", status: "derrota" },
  { slug: "porto-b-vs-esfera-2026-03-22", titulo: "Porto B vs Esfera", data: "2026-03-22", hora: "18:00", local: "Pavilhão Municipal da Lavandeira", competicao: "Segunda Divisão", adversario: "Porto B", resultado: "por defenir", pontos: "por definir", status: "agendado" },
  { slug: "esfera-vs-boa-hora-2026-03-15", titulo: "Esfera vs Boa-Hora", data: "2026-03-28", hora: "20:15", local: "Pavilhão desportivo da Ajuda", competicao: "Taça de Portugal", adversario: "Boa-Hora", resultado: "por defenir", pontos: "por defenir", status: "agendado" },
];

async function ensureGamesSeeded() {
  const count = await Game.countDocuments();
  if (count > 0) return;
  await Game.insertMany(seedGames);
  console.log("✅ Jogos inseridos na BD (seed).");
}
await ensureGamesSeeded();

// ---------------- DB: Bilhetes ----------------
const ticketPurchaseSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    gameSlug: { type: String, required: true, index: true },
    quantidade: { type: Number, required: true },
    setor: { type: String, required: true },
    precoUnitario: { type: Number, required: true },
    precoTotal: { type: Number, required: true },
    dataCompra: { type: String, required: true },
  },
  { timestamps: true }
);
const TicketPurchase = mongoose.model("Bilhetes_Compras", ticketPurchaseSchema , "Bilhetes_Compras");

// ---------------- DB: Inscrições ----------------
const registrationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    nome: { type: String, required: true },
    nome_atleta: { type: String, required: true },
    numeroSocio: { type: Number, required: true },
    escalao: { type: String, required: true },
    mensalidade: { type: String, required: true },
    dataInscricao: { type: String, required: true },
    estado: { type: String, default: "Pendente" },
  },
  { timestamps: true }
);
const Registration = mongoose.model("Inscricoes", registrationSchema , "Inscricoes");

// ---------------- DB: Loja ----------------
const shopProductSchema = new mongoose.Schema(
  {
    sku: { type: String, required: true, unique: true, index: true },
    nome: { type: String, required: true },
    categoria: { type: String, required: true },
    preco: { type: Number, required: true },
  },
  { timestamps: true }
);
const ShopProduct = mongoose.model("Produtos_Loja", shopProductSchema , "Produtos_Loja");

const shopPurchaseSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    sku: { type: String, required: true },
    produto: { type: String, required: true },
    quantidade: { type: Number, required: true },
    total: { type: Number, required: true },
    dataCompra: { type: String, required: true },
  },
  { timestamps: true }
);
const ShopPurchase = mongoose.model("Compras_Loja", shopPurchaseSchema , "Compras_Loja");

const seedProducts = [
  { sku: "EQ-001", nome: "Equipamento Principal", categoria: "loja1", preco: 39.99 },
  { sku: "EQ-002", nome: "Equipamento Alternativo", categoria: "loja1", preco: 39.99 },
  { sku: "EQ-003", nome: "Calções de Jogo", categoria: "loja1", preco: 14.99 },
  { sku: "GK-001", nome: "Equipamento Principal Guarda Redes", categoria: "loja1", preco: 29.99 },
  { sku: "GK-002", nome: "Calções de Jogo Guarda Redes", categoria: "loja1", preco: 29.99 },
  { sku: "SW-001", nome: "Sweat  Preta Oficial", categoria: "loja2", preco: 14.99 },
  { sku: "SW-002", nome: "Sweat Laranja Oficial", categoria: "loja2", preco: 29.99 },
  { sku: "CM-001", nome: "Camisa Polo", categoria: "loja3", preco: 24.99 },
  { sku: "AC-001", nome: "Cachecol", categoria: "loja4", preco: 14.99 },
];

async function ensureProductsSeeded() {
  const count = await ShopProduct.countDocuments();
  if (count > 0) return;
  await ShopProduct.insertMany(seedProducts);
  console.log("✅ Produtos da loja inseridos na Base de dados.");
}
await ensureProductsSeeded();

// ---------------- Users + Históricos ----------------
const bilheteHistoricoSchema = new mongoose.Schema(
  { dataCompra: String, jogo: String, competicao: String, local: String, dataJogo: String, horaJogo: String, setor: String, preco: String },
  { _id: true }
);

const inscricaoHistoricoSchema = new mongoose.Schema(
  { dataInscricao: String, escalao: String, mensalidade: String, estado: String },
  { _id: true }
);

const lojaHistoricoSchema = new mongoose.Schema(
  { dataCompra: String, produto: String, quantidade: Number, total: String },
  { _id: true }
);

const quotaHistoricoSchema = new mongoose.Schema(
  { dataPagamento: String, mes: Number, ano: Number, valor: String, tipo: String },
  { _id: true }
);

const userSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true },
    email: { type: String, required: true, unique: true, index: true },
    morada: { type: String, required: true },
    telefone: { type: String, required: true },
    nacionalidade: { type: String, required: true },
    genero: { type: String, required: true },

    passwordHash: { type: String, required: true },

    codigoSegurancaHash: { type: String, required: true },
    codigoSegurancaHint: { type: String, required: true },

    isVerified: { type: Boolean, default: false }, // Começa falso
    emailCodeHash: { type: String, default: null }, // Guarda o código temporário

    resetPasswordHash: { type: String, default: null },
    resetPasswordExpiry: { type: Date, default: null },

    numeroSocio: { type: Number, default: 0 },
    tipo: { type: String, enum: ["Adepto", "Normal", "Premium"], required: true },

    socioDesde: { type: String, default: null },

    historicoBilhetes: { type: [bilheteHistoricoSchema], default: [] },
    historicoInscricoes: { type: [inscricaoHistoricoSchema], default: [] },
    historicoLoja: { type: [lojaHistoricoSchema], default: [] },
    historicoQuotas: { type: [quotaHistoricoSchema], default: [] },
    deleteAccountCodeHash: { type: String, default: null },
    deleteAccountCodeExpiry: { type: Date, default: null },
  },
  { timestamps: true }
);
const User = mongoose.model("Utilizadores", userSchema , "Utilizadores"); //METER DUAS VEZES POIS O MONGO DB METE UM (S) A MAIS POR DEFEITO

// ---------------- Quotas Payments (dedicado) ----------------
const quotaPaymentSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, index: true },
    mes: { type: Number, required: true }, // 1-12
    ano: { type: Number, required: true },
    valor: { type: Number, required: true },
    tipo: { type: String, enum: ["Normal", "Premium"], required: true },
    dataPagamento: { type: String, required: true },
  },
  { timestamps: true }
);
quotaPaymentSchema.index({ email: 1, mes: 1, ano: 1 }, { unique: true });
const QuotaPayment = mongoose.model("Pagamento_Quotas", quotaPaymentSchema , "Pagamento_Quotas");

// ---------------- DB: Treinadores ----------------
const treinadorSchema = new mongoose.Schema(
  {
    nome: { type: String, required: true },
    email: { type: String, required: true },
    telefone: { type: String, default: "" },
    escalao: { type: String, required: true },
    funcao: { type: String, required: true },
    dataInicio: { type: String, default: "" },
    estado: { type: String, enum: ["Ativo", "Inativo"], default: "Ativo" },
  },
  { timestamps: true }
);
const Treinador = mongoose.model("Treinadores", treinadorSchema, "Treinadores");

// ---------------- ROTAS ----------------

// Jogos
app.get("/api/jogos", async (req, res) => {
  const jogos = await Game.find().sort({ data: 1, hora: 1 }).lean();
  return res.json({ jogos });
});
app.get("/api/jogos/slug/:slug", async (req, res) => {
  const jogo = await Game.findOne({ slug: req.params.slug }).lean();
  if (!jogo) return res.status(404).json({ error: "Jogo não encontrado." });
  return res.json({ jogo });
});

//Loja
app.get("/api/loja/produtos", async (req, res) => {
  const produtos = await ShopProduct.find().lean();
  return res.json({ produtos });
});

// ✅ ÚNICA rota comprar (com password + código)
app.post("/api/loja/comprar", async (req, res) => {
  try {
    const { email, password, codigoSeguranca, sku, quantidade } = req.body;

    if (!email || !password || !codigoSeguranca || !sku || !quantidade) {
      return res.status(400).json({ error: "Dados em falta." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const okPass = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!okPass) return res.status(401).json({ error: "Password incorreta." });

    const okCod = await verificarCodigoSeguranca(user, codigoSeguranca);
    if (!okCod) return res.status(401).json({ error: "Código de segurança inválido." });

    const prod = await ShopProduct.findOne({ sku }).lean();
    if (!prod) return res.status(404).json({ error: "Produto não encontrado." });

    const q = Number(quantidade);
    if (!Number.isFinite(q) || q < 1 || q > 10) {
      return res.status(400).json({ error: "Quantidade inválida (1-10)." });
    }

    const total = Number((prod.preco * q).toFixed(2));

    await ShopPurchase.create({
      email, sku: prod.sku, produto: prod.nome,
      quantidade: q, total, dataCompra: hojeYYYYMMDD()
    });

    user.historicoLoja.push({
      dataCompra: hojeYYYYMMDD(),
      produto: prod.nome,
      quantidade: q,
      total: `${total.toFixed(2)}€`,
    });

    await user.save();

    return res.json({ message: "Compra na loja registada no histórico.", total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao comprar na loja." });
  }
});


// Users
app.post("/api/registar", async (req, res) => {
  try {
    const { nome, email, morada, telefone, nacionalidade, genero, password } = req.body;
    
    if (!nome || !email || !morada || !telefone || !nacionalidade || !genero || !password) {
      return res.status(400).json({ error: "Faltam campos obrigatórios." });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(409).json({ error: "Já existe uma conta com esse email." });

    if (!passwordIsStrong(password)) {
      return res.status(400).json({ error: "A palavra-passe é fraca." });
    }

    const passwordHash = await bcrypt.hash(password.trim(), 10);

    // Código Permanente (para compras)
    const codigoSeguranca = gerarCodigoSeguranca();
    const codigoSegurancaHash = await bcrypt.hash(codigoSeguranca, 10);
    const codigoSegurancaHint = codigoSeguranca.slice(-4);

    // NOVO: Código Temporário (para email) - 6 dígitos
    const codigoEmail = Math.floor(100000 + Math.random() * 900000).toString();
    const emailCodeHash = await bcrypt.hash(codigoEmail, 10);

    const user = await User.create({
      nome, email, morada, telefone, nacionalidade, genero,
      passwordHash,
      codigoSegurancaHash, codigoSegurancaHint,
      
      // Conta criada como INATIVA e com o código guardado
      isVerified: false,
      emailCodeHash: emailCodeHash,

      tipo: "Adepto",
      numeroSocio: 0,
      socioDesde: null,
    });

    // Enviar o código por email real
    try {
      await enviarCodigoEmail(email, codigoEmail);
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email:", emailErr);
      // Se o email falhar, apagamos o user para ele poder tentar de novo
      await User.findByIdAndDelete(user._id);
      return res.status(500).json({ error: "Erro ao enviar email de verificação. Tenta novamente." });
    }

    return res.status(201).json({
      message: "Conta criada. Verifique o email.",
      user: { email: user.email }
    });

  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return res.status(409).json({ error: "Email duplicado." });
    return res.status(500).json({ error: "Erro ao criar conta." });
  }
});

app.post("/api/confirmar", async (req, res) => {
  try {
    const { email, codigo } = req.body;

    if (!email || !codigo) return res.status(400).json({ error: "Dados em falta." });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    if (user.isVerified) return res.status(400).json({ error: "Conta já está verificada." });

    // Verificar se o código bate certo com o hash guardado
    const match = await bcrypt.compare(String(codigo).trim(), user.emailCodeHash || "");
    
    if (!match) {
      return res.status(400).json({ error: "Código de verificação incorreto." });
    }

    // Sucesso: ativar conta e limpar o código temporário
    // Sucesso: ativar conta e limpar o código temporário
    user.isVerified = true;
    user.emailCodeHash = null; // Já não precisamos disto
    await user.save();

    // Enviar email de boas-vindas
    try {
      await transporter.sendMail({
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Bem-vindo ao Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #e68a00;">Bem-vindo ao Esfera, ${user.nome}!</h2>
            <p>A tua conta foi verificada com sucesso. Já fazes parte do clube!</p>
            <p>Agora podes:</p>
            <ul style="color: #333; line-height: 1.8;">
              <li>Comprar bilhetes para os jogos</li>
              <li>Explorar a nossa loja oficial</li>
              <li>Tornar-te sócio e apoiar o clube</li>
              <li>Inscrever atletas nos escalões</li>
            </ul>
            <p style="margin-top: 20px;">Obrigado por te juntares a nós!</p>
            <p style="color: #666; font-size: 13px; margin-top: 15px;">
              — Equipa Esfera Andebol Masters
            </p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de boas-vindas:", emailErr);
    }

    return res.json({ message: "Conta verificada com sucesso!" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao verificar conta." });
  }
});

app.post("/api/login", loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email e palavra-passe são obrigatórios." });

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Credenciais inválidas." });

    // 1. Verificamos a password PRIMEIRO
    const ok = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Credenciais inválidas." });

    // 2. Se a password está certa, mas a conta NÃO está verificada
    if (!user.isVerified) {
      
      // Gera um NOVO código de validação (para o caso de o antigo ter sido perdido)
      const novoCodigo = Math.floor(100000 + Math.random() * 900000).toString();
      user.emailCodeHash = await bcrypt.hash(novoCodigo, 10);
      await user.save();

      // Enviar o novo código por email real
      try {
        await enviarCodigoEmail(user.email, novoCodigo);
      } catch (emailErr) {
        console.error("❌ Erro ao reenviar email:", emailErr);
      }

      // Devolve erro 403, mas com os dados para o utilizador validar agora
      return res.status(403).json({ 
        error: "Conta não verificada. Enviámos um novo código para o teu email.",
        needVerification: true, 
        email: user.email
      });
    }

    // 3. Se passou tudo, login normal
    return res.json({
      message: "Login efetuado com sucesso.",
      user: { 
        id: user._id, 
        nome: user.nome, 
        email: user.email, 
        tipo: user.tipo, 
        numeroSocio: user.numeroSocio 
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro no servidor ao fazer login." });
  }
});

// ===============================
// ✅ RECUPERAR PASSWORD: Enviar código
// ===============================
app.post("/api/recuperar-password", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: "Muitos pedidos. Tenta novamente daqui a 15 minutos." },
}), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email é obrigatório." });

    const user = await User.findOne({ email });
    // Por segurança, não revelamos se o email existe ou não
    if (!user) {
      return res.json({ message: "Se o email existir, receberás um código de recuperação." });
    }

    // Gerar código de 6 dígitos
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();
    user.resetPasswordHash = await bcrypt.hash(codigo, 10);
    user.resetPasswordExpiry = new Date(Date.now() + 15 * 60 * 1000); // expira em 15 minutos
    await user.save();

    // Enviar email
    try {
      const mailOptions = {
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Recuperação de Palavra-passe - Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333;">Recuperação de Palavra-passe</h2>
            <p>Recebemos um pedido para redefinir a tua palavra-passe. O teu código é:</p>
            <div style="background: #e68a00; padding: 15px; text-align: center; noid
                        font-size: 28px; font-weight: bold; letter-spacing: 6px; 
                        border-radius: 8px; margin: 20px 0;">
              ${codigo}
            </div>
            <p style="color: #666; font-size: 14px;">
              Este código expira em 15 minutos.<br>
              Se não pediste esta recuperação, ignora este email.
            </p>
          </div>
        `,
      };
      await transporter.sendMail(mailOptions);
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de recuperação:", emailErr);
      return res.status(500).json({ error: "Erro ao enviar email. Tenta novamente." });
    }

    return res.json({ message: "Se o email existir, receberás um código de recuperação." });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro no servidor." });
  }
});

// ===============================
// ✅ RESET PASSWORD: Validar código e definir nova password
// ===============================
app.post("/api/reset-password", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Muitas tentativas. Tenta novamente daqui a 15 minutos." },
}), async (req, res) => {
  try {
    const { email, codigo, novaPassword } = req.body;
    if (!email || !codigo || !novaPassword) {
      return res.status(400).json({ error: "Todos os campos são obrigatórios." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "Pedido inválido." });

    // Verificar se há código de reset e se não expirou
    if (!user.resetPasswordHash || !user.resetPasswordExpiry) {
      return res.status(400).json({ error: "Nenhum pedido de recuperação ativo. Pede um novo código." });
    }

    if (new Date() > user.resetPasswordExpiry) {
      user.resetPasswordHash = null;
      user.resetPasswordExpiry = null;
      await user.save();
      return res.status(400).json({ error: "Código expirado. Pede um novo código." });
    }

    // Verificar código
    const match = await bcrypt.compare(String(codigo).trim(), user.resetPasswordHash);
    if (!match) {
      return res.status(400).json({ error: "Código incorreto." });
    }

    // Validar força da nova password
    if (!passwordIsStrong(novaPassword)) {
      return res.status(400).json({ error: "A nova palavra-passe é fraca (8+, maiúsc/minúsc, número e símbolo)." });
    }

    // Atualizar password
    user.passwordHash = await bcrypt.hash(novaPassword.trim(), 10);
    user.resetPasswordHash = null;
    user.resetPasswordExpiry = null;
    await user.save();

    // Enviar email de confirmação
    try {
      const mailOptions = {
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Palavra-passe Alterada - Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333;">Palavra-passe Alterada</h2>
            <p>A tua palavra-passe foi alterada com sucesso em <strong>${new Date().toLocaleString("pt-PT", { dateStyle: "long", timeStyle: "short" })}</strong>.</p>
            <p style="color: #cc0000; font-size: 14px; margin-top: 20px;">
              ⚠️ Se não foste tu que fizeste esta alteração, contacta-nos imediatamente ou tenta recuperar a tua conta.
            </p>
            <p style="color: #666; font-size: 13px; margin-top: 15px;">
              — Equipa Esfera Andebol Masters
            </p>
          </div>
        `,
      };
      await transporter.sendMail(mailOptions);
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de confirmação de alteração:", emailErr);
      // Não bloqueamos — a password já foi alterada com sucesso
    }

    return res.json({ message: "Palavra-passe alterada com sucesso!" });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao redefinir password." });
  }
});

// ===============================
// ✅ CONTA: MUDAR NOME
// ===============================
app.post("/api/conta/mudar-nome", async (req, res) => {
  try {
    const { email, password, novoNome } = req.body;

    if (!email || !password || !novoNome) {
      return res.status(400).json({ error: "Email, password e novo nome são obrigatórios." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Password incorreta." });

    const nomeLimpo = String(novoNome).trim();
    if (nomeLimpo.length < 2) return res.status(400).json({ error: "Nome inválido." });

    user.nome = nomeLimpo;
    await user.save();

    return res.json({ message: "Nome atualizado com sucesso.", nome: user.nome });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar nome." });
  }
});

// ===============================
// ✅ CONTA: MUDAR PASSWORD
// ===============================
app.post("/api/conta/mudar-password", async (req, res) => {
  try {
    const { email, passwordAtual, novaPassword } = req.body;

    if (!email || !passwordAtual || !novaPassword) {
      return res.status(400).json({ error: "Email, password atual e nova password são obrigatórios." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await bcrypt.compare(passwordAtual.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Password atual incorreta." });

    // usa a tua função existente
    if (!passwordIsStrong(novaPassword)) {
      return res.status(400).json({ error: "A nova palavra-passe é fraca (8+, maiúsc/minúsc, número e símbolo)." });
    }

    // impedir repetir
    const same = await bcrypt.compare(novaPassword.trim(), user.passwordHash);
    if (same) return res.status(400).json({ error: "A nova password tem de ser diferente da atual." });

    user.passwordHash = await bcrypt.hash(novaPassword.trim(), 10);
    await user.save();

    // Enviar email de confirmação
    try {
      const mailOptions = {
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Palavra-passe Alterada - Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333;">Palavra-passe Alterada</h2>
            <p>A tua palavra-passe foi alterada com sucesso em <strong>${new Date().toLocaleString("pt-PT", { dateStyle: "long", timeStyle: "short" })}</strong>.</p>
            <p style="color: #cc0000; font-size: 14px; margin-top: 20px;">
              ⚠️ Se não foste tu que fizeste esta alteração, contacta-nos imediatamente ou tenta recuperar a tua conta.
            </p>
            <p style="color: #666; font-size: 13px; margin-top: 15px;">
              — Equipa Esfera Andebol Masters
            </p>
          </div>
        `,
      };
      await transporter.sendMail(mailOptions);
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de confirmação de alteração:", emailErr);
    }

    return res.json({ message: "Password alterada com sucesso." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao alterar password." });
  }
});

// ===============================
// ✅ LOJA: COMPRAR (AGORA EXIGE PASSWORD + CÓDIGO)
// (SUBSTITUI a tua rota /api/loja/comprar por esta)
// ===============================
app.post("/api/loja/comprar", async (req, res) => {
  try {
    const { email, password, codigoSeguranca, sku, quantidade } = req.body;

    if (!email || !password || !codigoSeguranca || !sku || !quantidade) {
      return res.status(400).json({ error: "Dados em falta." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const okPass = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!okPass) return res.status(401).json({ error: "Password incorreta." });

    const okCod = await verificarCodigoSeguranca(user, codigoSeguranca);
    if (!okCod) return res.status(401).json({ error: "Código de segurança inválido." });

    const prod = await ShopProduct.findOne({ sku }).lean();
    if (!prod) return res.status(404).json({ error: "Produto não encontrado." });

    const q = Number(quantidade);
    if (!Number.isFinite(q) || q < 1 || q > 10) {
      return res.status(400).json({ error: "Quantidade inválida (1-10)." });
    }

    const total = Number((prod.preco * q).toFixed(2));

    await ShopPurchase.create({
      email,
      sku: prod.sku,
      produto: prod.nome,
      quantidade: q,
      total,
      dataCompra: hojeYYYYMMDD(),
    });

    user.historicoLoja.push({
      dataCompra: hojeYYYYMMDD(),
      produto: prod.nome,
      quantidade: q,
      total: `${total.toFixed(2)}€`,
    });

    await user.save();

    return res.json({ message: "Compra na loja registada no histórico.", total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao comprar na loja." });
  }
});


app.get("/api/historico", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email é obrigatório." });

    const user = await User.findOne({ email }).lean();
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    return res.json({
      user: {
        nome: user.nome,
        email: user.email,
        tipo: user.tipo,
        numeroSocio: user.numeroSocio,
        codigoSegurancaHint: user.codigoSegurancaHint,
      },
      historico: {
        bilhetes: user.historicoBilhetes || [],
        inscricoes: user.historicoInscricoes || [],
        loja: user.historicoLoja || [],
        quotas: user.historicoQuotas || [],
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar histórico." });
  }
});

// ✅ Upgrade direto (Adepto/Normal/Premium -> Normal/Premium) + socioDesde
app.post("/api/upgrade", async (req, res) => {
  try {
    const { email, password, tipo } = req.body;
    if (!email || !password || !tipo) return res.status(400).json({ error: "Email, password e tipo são obrigatórios." });
    if (!["Normal", "Premium"].includes(tipo)) return res.status(400).json({ error: "Tipo inválido (Normal/Premium)." });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Password incorreta." });

    if (user.tipo === tipo) return res.status(400).json({ error: "Já estás nesse tipo." });

    const eraAdepto = (user.tipo === "Adepto");

    user.tipo = tipo;
    user.numeroSocio = (tipo === "Normal") ? gerarNumeroNormal() : gerarNumeroPremium();
    if (eraAdepto || !user.socioDesde) user.socioDesde = hojeYYYYMMDD();

    await user.save();

    return res.json({ message: "Upgrade efetuado.", tipo: user.tipo, numeroSocio: user.numeroSocio });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao fazer upgrade." });
  }
});

// ✅ Quotas: status (profissional)
app.get("/api/quotas/status", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email é obrigatório." });

    const st = await getQuotaStatus(email);
    if (!st.ok) return res.status(st.code || 400).json({ error: st.error });

    // devolve só o que interessa para UI
    return res.json({
      tipo: st.userTipo,
      valorMensal: st.valorMensal,
      socioDesde: st.socioDesde,
      nextUnpaid: st.nextUnpaid,
      overdueMonths: st.overdueMonths,
      paidUntil: st.paidUntil,
      diasRestantes: st.diasRestantes,
      validadeAte: st.validadeAte,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar status de quotas." });
  }
});

// ✅ Quotas: listar pagas
app.get("/api/quotas", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: "Email é obrigatório." });

    const st = await getQuotaStatus(email);
    if (!st.ok) return res.status(st.code || 400).json({ error: st.error });

    return res.json({
      tipo: st.userTipo,
      valorMensal: st.valorMensal,
      pagos: st.pagos,
      status: {
        socioDesde: st.socioDesde,
        nextUnpaid: st.nextUnpaid,
        overdueMonths: st.overdueMonths,
        paidUntil: st.paidUntil,
        diasRestantes: st.diasRestantes,
        validadeAte: st.validadeAte,
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar quotas." });
  }
});

// ✅ Quotas: pagar N meses seguidos (sem saltar meses)
app.post("/api/quotas/pagar", async (req, res) => {
  try {
    const { email, password, meses } = req.body;
    if (!email || !password || !meses) {
      return res.status(400).json({ error: "Email, password e meses são obrigatórios." });
    }

    const n = Number(meses);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      return res.status(400).json({ error: "Número de meses inválido (1-12)." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });
    if (user.tipo === "Adepto") return res.status(403).json({ error: "Apenas sócios podem pagar quotas." });

    const okPass = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!okPass) return res.status(401).json({ error: "Password incorreta." });

    const valor = quotaValorPorTipo(user.tipo);
    if (valor <= 0) return res.status(400).json({ error: "Tipo inválido para quotas." });

    // calcula próximo mês por pagar
    const st = await getQuotaStatus(email);
    if (!st.ok) return res.status(st.code || 400).json({ error: st.error });

    const startInt = ymToInt(st.nextUnpaid.ano, st.nextUnpaid.mes);

    const docs = [];
    for (let i = 0; i < n; i++) {
      const { ano, mes } = intToYM(startInt + i);
      docs.push({ email, mes, ano, valor, tipo: user.tipo, dataPagamento: hojeYYYYMMDD() });
    }

    // garante que não existem já (evita erro a meio)
    const exists = await QuotaPayment.find({
      email,
      $or: docs.map(d => ({ mes: d.mes, ano: d.ano })),
    }).lean();

    if (exists.length > 0) {
      return res.status(409).json({ error: "Algumas dessas quotas já estão pagas. Atualiza e tenta novamente." });
    }

    await QuotaPayment.insertMany(docs);

    // histórico user
    docs.forEach(d => {
      user.historicoQuotas.push({
        dataPagamento: d.dataPagamento,
        mes: d.mes,
        ano: d.ano,
        valor: `${Number(d.valor).toFixed(2)}€`,
        tipo: user.tipo,
      });
    });
    await user.save();

    const st2 = await getQuotaStatus(email);

    return res.json({
      message: `Pagaste ${n} mês(es) com sucesso.`,
      pagos: docs.map(d => ({ mes: d.mes, ano: d.ano, valor: d.valor })),
      status: {
        nextUnpaid: st2.ok ? st2.nextUnpaid : null,
        overdueMonths: st2.ok ? st2.overdueMonths : null,
        paidUntil: st2.ok ? st2.paidUntil : null,
        diasRestantes: st2.ok ? st2.diasRestantes : null,
        validadeAte: st2.ok ? st2.validadeAte : null,
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao pagar quotas." });
  }
});

// Código segurança reset
app.post("/api/seguranca/reset", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email e password são obrigatórios." });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Password incorreta." });

    const novoCodigo = gerarCodigoSeguranca();
    user.codigoSegurancaHash = await bcrypt.hash(novoCodigo, 10);
    user.codigoSegurancaHint = novoCodigo.slice(-4);
    await user.save();

    return res.json({ message: "Código atualizado.", codigoSeguranca: novoCodigo, codigoSegurancaHint: user.codigoSegurancaHint });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar código de segurança." });
  }
});

// ✅ Bilhetes comprar (VIP sem bug do nº 0 + preço calculado no server)
app.post("/api/bilhetes/comprar", async (req, res) => {
  try {
    const { email, codigoSeguranca, gameSlug, quantidade, setor } = req.body;
    if (!email || !codigoSeguranca || !gameSlug || !quantidade || !setor) {
      return res.status(400).json({ error: "Dados em falta." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await verificarCodigoSeguranca(user, codigoSeguranca);
    if (!ok) return res.status(401).json({ error: "Código de segurança inválido." });

    const jogo = await Game.findOne({ slug: gameSlug });
    if (!jogo) return res.status(404).json({ error: "Jogo não encontrado." });

    // ✅ VIP só Premium com nº sócio 1-499 (nº 0 fica bloqueado)
    if (setor === "Zona VIP") {
      const n = Number(user.numeroSocio || 0);
      const vipOk = (user.tipo === "Premium" && n >= 1 && n < 500);
      if (!vipOk) return res.status(403).json({ error: "Zona VIP só para Sócio Premium com nº 1-499." });
    }

    const q = Number(quantidade);
    if (!Number.isFinite(q) || q < 1 || q > 10) return res.status(400).json({ error: "Quantidade inválida (1-10)." });

    const pu = calcTicketUnitPrice(setor, user);
    if (pu == null) return res.status(400).json({ error: "Setor inválido." });

    const pt = Number((pu * q).toFixed(2));

    await TicketPurchase.create({
      email,
      gameSlug,
      quantidade: q,
      setor,
      precoUnitario: pu,
      precoTotal: pt,
      dataCompra: hojeYYYYMMDD()
    });

    await Game.updateOne({ slug: gameSlug }, { $inc: { attendanceCount: q } });

    user.historicoBilhetes.push({
      dataCompra: hojeYYYYMMDD(),
      jogo: jogo.titulo,
      competicao: jogo.competicao,
      local: jogo.local,
      dataJogo: jogo.data,
      horaJogo: jogo.hora,
      setor,
      preco: `${pt.toFixed(2)}€ (x${q})`,
    });

    await user.save();
    return res.json({ message: "Compra registada.", precoUnitario: pu, precoTotal: pt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao comprar bilhete." });
  }
});

// ✅ Inscrições criar (código + password + nº sócio “bate certo”)
app.post("/api/inscricoes/criar", async (req, res) => {
  try {
    const { email, codigoSeguranca, password, nome, nome_atleta, escalao, mensalidade } = req.body;
    if (!email || !codigoSeguranca || !password || !nome || !nome_atleta || !escalao || !mensalidade) {
      return res.status(400).json({ error: "Dados em falta." });
    }

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const okCod = await verificarCodigoSeguranca(user, codigoSeguranca);
    if (!okCod) return res.status(401).json({ error: "Código de segurança inválido." });

    const okPass = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!okPass) return res.status(401).json({ error: "Password incorreta." });

    // ✅ nº sócio vem sempre do utilizador
    const numeroSocio = Number(user.numeroSocio || 0);

    await Registration.create({
      email,
      nome,
      nome_atleta,
      numeroSocio,
      escalao,
      mensalidade,
      dataInscricao: hojeYYYYMMDD(),
      estado: "Pendente",
    });

    user.historicoInscricoes.push({ dataInscricao: hojeYYYYMMDD(), escalao, mensalidade, estado: "Pendente" });
    await user.save();

    return res.json({ message: "Inscrição registada.", numeroSocio });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar inscrição." });
  }
});

// ===============================
// ✅ APAGAR CONTA — PASSO 1: Pedir código de confirmação
// ===============================
app.post("/api/conta/apagar/pedir", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email e password são obrigatórios." });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const ok = await bcrypt.compare(password.trim(), user.passwordHash);
    if (!ok) return res.status(401).json({ error: "Password incorreta." });

    // Gerar código de 10 dígitos
    const codigo = Math.floor(1000000000 + Math.random() * 9000000000).toString();
    user.deleteAccountCodeHash = await bcrypt.hash(codigo, 10);
    user.deleteAccountCodeExpiry = new Date(Date.now() + 15 * 60 * 1000); // 15 minutos
    await user.save();

    // Enviar email com o código
    try {
      await transporter.sendMail({
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "Confirmação de Eliminação de Conta — Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #cc0000;">Eliminação de Conta</h2>
            <p>Recebemos um pedido para eliminar a tua conta. Para confirmar, introduz o seguinte código:</p>
            <div style="background: #f4f4f4; padding: 15px; text-align: center; 
                        font-size: 24px; font-weight: bold; letter-spacing: 4px; 
                        border-radius: 8px; margin: 20px 0;">
              ${codigo}
            </div>
            <p style="color: #cc0000; font-size: 14px; font-weight: bold;">
              ⚠️ Esta ação é irreversível. Todos os teus dados serão eliminados permanentemente.
            </p>
            <p style="color: #666; font-size: 14px;">
              Este código expira em 15 minutos.<br>
              Se não pediste a eliminação da conta, ignora este email.
            </p>
            <p style="color: #666; font-size: 13px; margin-top: 15px;">
              — Equipa Esfera Andebol Masters
            </p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de confirmação de exclusão:", emailErr);
      return res.status(500).json({ error: "Erro ao enviar email. Tenta novamente." });
    }

    return res.json({ message: "Código de confirmação enviado para o teu email." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao pedir eliminação de conta." });
  }
});

// ===============================
// ✅ APAGAR CONTA — PASSO 2: Confirmar código e apagar
// ===============================
app.post("/api/conta/apagar/confirmar", async (req, res) => {
  try {
    const { email, codigo } = req.body;
    if (!email || !codigo) return res.status(400).json({ error: "Email e código são obrigatórios." });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    // Verificar se há código ativo
    if (!user.deleteAccountCodeHash || !user.deleteAccountCodeExpiry) {
      return res.status(400).json({ error: "Nenhum pedido de eliminação ativo. Pede um novo código." });
    }

    // Verificar expiração
    if (new Date() > user.deleteAccountCodeExpiry) {
      user.deleteAccountCodeHash = null;
      user.deleteAccountCodeExpiry = null;
      await user.save();
      return res.status(400).json({ error: "Código expirado. Pede um novo código." });
    }

    // Verificar código
    const match = await bcrypt.compare(String(codigo).trim(), user.deleteAccountCodeHash);
    if (!match) return res.status(400).json({ error: "Código incorreto." });

    // Guardar dados antes de apagar
    const nomeUser = user.nome;

    await Promise.all([
      TicketPurchase.deleteMany({ email }),
      ShopPurchase.deleteMany({ email }),
      Registration.deleteMany({ email }),
      QuotaPayment.deleteMany({ email }),
      User.deleteOne({ email }),
    ]);

    // Enviar email de despedida
    try {
      await transporter.sendMail({
        from: `"Esfera" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: "A tua conta foi eliminada — Esfera",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #333;">Adeus, ${nomeUser}.</h2>
            <p>A tua conta na Esfera foi eliminada com sucesso, assim como todos os dados associados.</p>
            <p>Lamentamos ver-te partir. Se algum dia quiseres voltar, serás sempre bem-vindo — basta criar uma nova conta.</p>
            <p style="color: #666; font-size: 14px; margin-top: 20px;">
              Se não foste tu que pediste esta eliminação, contacta-nos imediatamente.
            </p>
            <p style="color: #666; font-size: 13px; margin-top: 15px;">
              — Equipa Esfera Andebol Masters
            </p>
          </div>
        `,
      });
    } catch (emailErr) {
      console.error("❌ Erro ao enviar email de despedida:", emailErr);
    }

    return res.json({ message: "Conta apagada com sucesso." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao apagar conta." });
  }
});

// ════════════════════════════════════════════════════════
// ✅ ROTAS ADMIN
// ════════════════════════════════════════════════════════

// Dashboard — contagens e receita total
app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const usersCount = await User.countDocuments();
    const ticketsCount = await TicketPurchase.countDocuments();
    const gamesCount = await Game.countDocuments();
    const treinadoresCount = await Treinador.countDocuments();

    // Receita: bilhetes + loja + quotas
    const ticketAgg = await TicketPurchase.aggregate([{ $group: { _id: null, total: { $sum: "$precoTotal" } } }]);
    const shopAgg = await ShopPurchase.aggregate([{ $group: { _id: null, total: { $sum: "$total" } } }]);
    const quotaAgg = await QuotaPayment.aggregate([{ $group: { _id: null, total: { $sum: "$valor" } } }]);

    const receitaTotal =
      (ticketAgg[0]?.total || 0) +
      (shopAgg[0]?.total || 0) +
      (quotaAgg[0]?.total || 0);

    return res.json({
      contagens: {
        users: usersCount,
        tickets: ticketsCount,
        games: gamesCount,
        treinadores: treinadoresCount,
      },
      receita: {
        total: receitaTotal,
        bilhetes: ticketAgg[0]?.total || 0,
        loja: shopAgg[0]?.total || 0,
        quotas: quotaAgg[0]?.total || 0,
      },
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar dashboard." });
  }
});

// Utilizadores — listar com pesquisa e filtro
app.get("/api/admin/utilizadores", async (req, res) => {
  try {
    const { search, tipo } = req.query;
    const filter = {};

    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ nome: regex }, { email: regex }];
    }
    if (tipo) filter.tipo = tipo;

    const users = await User.find(filter)
      .select("nome email numeroSocio tipo codigoSegurancaHint createdAt socioDesde telefone")
      .sort({ createdAt: -1 })
      .lean();

    // Adicionar campo isVerified (tem passwordHash = conta criada = verificada)
    const data = users.map((u) => ({
      ...u,
      isVerified: true, // Todas as contas que existem na DB estão verificadas
    }));

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar utilizadores." });
  }
});

// Utilizador individual — detalhes
app.get("/api/admin/utilizadores/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-passwordHash -codigoSegurancaHash")
      .lean();

    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    return res.json({ user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar utilizador." });
  }
});

// Bilhetes — listar com pesquisa e filtro por setor
app.get("/api/admin/bilhetes", async (req, res) => {
  try {
    const { email, setor } = req.query;
    const filter = {};

    if (email) filter.email = new RegExp(email, "i");
    if (setor) filter.setor = setor;

    const data = await TicketPurchase.find(filter).sort({ createdAt: -1 }).lean();

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar bilhetes." });
  }
});

// Loja — listar compras com pesquisa
app.get("/api/admin/loja", async (req, res) => {
  try {
    const { email } = req.query;
    const filter = {};

    if (email) {
      const regex = new RegExp(email, "i");
      filter.$or = [{ email: regex }, { produto: regex }];
    }

    const data = await ShopPurchase.find(filter).sort({ createdAt: -1 }).lean();

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar compras da loja." });
  }
});

// Quotas — listar pagamentos com pesquisa e filtro
app.get("/api/admin/quotas", async (req, res) => {
  try {
    const { email, tipo } = req.query;
    const filter = {};

    if (email) filter.email = new RegExp(email, "i");
    if (tipo) filter.tipo = tipo;

    const data = await QuotaPayment.find(filter).sort({ ano: -1, mes: -1 }).lean();

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar quotas." });
  }
});

// Inscrições — listar com pesquisa e filtro por estado
app.get("/api/admin/inscricoes", async (req, res) => {
  try {
    const { email, estado } = req.query;
    const filter = {};

    if (email) {
      const regex = new RegExp(email, "i");
      filter.$or = [{ nome: regex }, { nome_atleta: regex }, { email: regex }];
    }
    if (estado) filter.estado = estado;

    const data = await Registration.find(filter).sort({ createdAt: -1 }).lean();

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar inscrições." });
  }
});

// Inscrições — atualizar estado (Aprovar/Rejeitar)
app.patch("/api/admin/inscricoes/:id", async (req, res) => {
  try {
    const { estado } = req.body;
    if (!estado || !["Aprovada", "Rejeitada", "Pendente"].includes(estado)) {
      return res.status(400).json({ error: "Estado inválido." });
    }

    const inscricao = await Registration.findByIdAndUpdate(
      req.params.id,
      { estado },
      { new: true }
    ).lean();

    if (!inscricao) return res.status(404).json({ error: "Inscrição não encontrada." });

    // Atualizar também no histórico do user
    try {
      const user = await User.findOne({ email: inscricao.email });
      if (user) {
        const entry = user.historicoInscricoes.find(
          (h) => h.dataInscricao === inscricao.dataInscricao && h.escalao === inscricao.escalao
        );
        if (entry) {
          entry.estado = estado;
          await user.save();
        }
      }
    } catch (ignore) {}

    return res.json({ message: "Estado atualizado.", inscricao });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar inscrição." });
  }
});

// ════════════════════════════════════════════════════════
// ✅ ROTAS ADMIN — CRUD COMPLETO
// ════════════════════════════════════════════════════════

// ──── UTILIZADORES: Editar ────
app.put("/api/admin/utilizadores/:id", async (req, res) => {
  try {
    const { nome, telefone, tipo, numeroSocio, morada, nacionalidade, genero } = req.body;
    const update = {};
    if (nome) update.nome = nome;
    if (telefone !== undefined) update.telefone = telefone;
    if (tipo && ["Adepto", "Normal", "Premium"].includes(tipo)) update.tipo = tipo;
    if (numeroSocio !== undefined) update.numeroSocio = Number(numeroSocio);
    if (morada) update.morada = morada;
    if (nacionalidade) update.nacionalidade = nacionalidade;
    if (genero) update.genero = genero;

    const user = await User.findByIdAndUpdate(req.params.id, update, { new: true })
      .select("-passwordHash -codigoSegurancaHash")
      .lean();

    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });
    return res.json({ message: "Utilizador atualizado.", user });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar utilizador." });
  }
});

// ──── UTILIZADORES: Eliminar ────
app.delete("/api/admin/utilizadores/:id", async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "Utilizador não encontrado." });

    const email = user.email;
    await Promise.all([
      TicketPurchase.deleteMany({ email }),
      ShopPurchase.deleteMany({ email }),
      Registration.deleteMany({ email }),
      QuotaPayment.deleteMany({ email }),
      User.deleteOne({ _id: req.params.id }),
    ]);

    return res.json({ message: "Utilizador e dados associados eliminados." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar utilizador." });
  }
});

// ──── JOGOS: Criar ────
app.post("/api/admin/jogos", async (req, res) => {
  try {
    const { titulo, data, hora, local, competicao, adversario, resultado, status, pontos } = req.body;
    if (!titulo || !data || !hora || !local || !competicao || !adversario) {
      return res.status(400).json({ error: "Campos obrigatórios em falta (titulo, data, hora, local, competicao, adversario)." });
    }

    // Gerar slug automaticamente
    const slug = `${titulo.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${data}`;

    const jogo = await Game.create({
      slug, titulo, data, hora, local, competicao, adversario,
      resultado: resultado || "",
      status: status || "agendado",
      pontos: pontos || "",
    });

    return res.status(201).json({ message: "Jogo criado.", jogo });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return res.status(409).json({ error: "Já existe um jogo com esse slug." });
    return res.status(500).json({ error: "Erro ao criar jogo." });
  }
});

// ──── JOGOS: Editar ────
app.put("/api/admin/jogos/:id", async (req, res) => {
  try {
    const { titulo, data, hora, local, competicao, adversario, resultado, status, pontos } = req.body;
    const update = {};
    if (titulo) update.titulo = titulo;
    if (data) update.data = data;
    if (hora) update.hora = hora;
    if (local) update.local = local;
    if (competicao) update.competicao = competicao;
    if (adversario) update.adversario = adversario;
    if (resultado !== undefined) update.resultado = resultado;
    if (status) update.status = status;
    if (pontos !== undefined) update.pontos = pontos;

    const jogo = await Game.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!jogo) return res.status(404).json({ error: "Jogo não encontrado." });
    return res.json({ message: "Jogo atualizado.", jogo });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar jogo." });
  }
});

// ──── JOGOS: Eliminar ────
app.delete("/api/admin/jogos/:id", async (req, res) => {
  try {
    const jogo = await Game.findByIdAndDelete(req.params.id);
    if (!jogo) return res.status(404).json({ error: "Jogo não encontrado." });
    // Também apagar bilhetes associados
    await TicketPurchase.deleteMany({ gameSlug: jogo.slug });
    return res.json({ message: "Jogo e bilhetes associados eliminados." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar jogo." });
  }
});

// ──── BILHETES: Criar (admin direto, sem código segurança) ────
app.post("/api/admin/bilhetes", async (req, res) => {
  try {
    const { email, gameSlug, quantidade, setor, precoTotal } = req.body;
    if (!email || !gameSlug || !quantidade || !setor) {
      return res.status(400).json({ error: "Campos obrigatórios em falta." });
    }

    const q = Number(quantidade);
    const pt = Number(precoTotal) || 0;
    const pu = q > 0 ? Number((pt / q).toFixed(2)) : 0;

    const bilhete = await TicketPurchase.create({
      email, gameSlug, quantidade: q, setor,
      precoUnitario: pu, precoTotal: pt,
      dataCompra: hojeYYYYMMDD(),
    });

    return res.status(201).json({ message: "Bilhete criado.", bilhete });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar bilhete." });
  }
});

// ──── BILHETES: Editar ────
app.put("/api/admin/bilhetes/:id", async (req, res) => {
  try {
    const { quantidade, setor, precoTotal } = req.body;
    const update = {};
    if (quantidade) update.quantidade = Number(quantidade);
    if (setor) update.setor = setor;
    if (precoTotal !== undefined) {
      update.precoTotal = Number(precoTotal);
      if (update.quantidade) update.precoUnitario = Number((update.precoTotal / update.quantidade).toFixed(2));
    }

    const bilhete = await TicketPurchase.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!bilhete) return res.status(404).json({ error: "Bilhete não encontrado." });
    return res.json({ message: "Bilhete atualizado.", bilhete });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar bilhete." });
  }
});

// ──── BILHETES: Eliminar ────
app.delete("/api/admin/bilhetes/:id", async (req, res) => {
  try {
    const bilhete = await TicketPurchase.findByIdAndDelete(req.params.id);
    if (!bilhete) return res.status(404).json({ error: "Bilhete não encontrado." });
    return res.json({ message: "Bilhete eliminado." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar bilhete." });
  }
});

// ──── LOJA (Compras): Criar ────
app.post("/api/admin/loja", async (req, res) => {
  try {
    const { email, produto, sku, quantidade, total } = req.body;
    if (!email || !produto || !quantidade) {
      return res.status(400).json({ error: "Campos obrigatórios em falta." });
    }

    const compra = await ShopPurchase.create({
      email, produto, sku: sku || "",
      quantidade: Number(quantidade),
      total: Number(total) || 0,
      dataCompra: hojeYYYYMMDD(),
    });

    return res.status(201).json({ message: "Venda registada.", compra });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar venda." });
  }
});

// ──── LOJA (Compras): Editar ────
app.put("/api/admin/loja/:id", async (req, res) => {
  try {
    const { produto, sku, quantidade, total } = req.body;
    const update = {};
    if (produto) update.produto = produto;
    if (sku !== undefined) update.sku = sku;
    if (quantidade) update.quantidade = Number(quantidade);
    if (total !== undefined) update.total = Number(total);

    const compra = await ShopPurchase.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!compra) return res.status(404).json({ error: "Compra não encontrada." });
    return res.json({ message: "Compra atualizada.", compra });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar compra." });
  }
});

// ──── LOJA (Compras): Eliminar ────
app.delete("/api/admin/loja/:id", async (req, res) => {
  try {
    const compra = await ShopPurchase.findByIdAndDelete(req.params.id);
    if (!compra) return res.status(404).json({ error: "Compra não encontrada." });
    return res.json({ message: "Compra eliminada." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar compra." });
  }
});

// ──── QUOTAS: Criar ────
app.post("/api/admin/quotas", async (req, res) => {
  try {
    const { email, tipo, mes, ano, valor } = req.body;
    if (!email || !tipo || !mes || !ano || valor === undefined) {
      return res.status(400).json({ error: "Campos obrigatórios em falta." });
    }

    const quota = await QuotaPayment.create({
      email, tipo, mes: Number(mes), ano: Number(ano),
      valor: Number(valor),
      dataPagamento: hojeYYYYMMDD(),
    });

    return res.status(201).json({ message: "Quota registada.", quota });
  } catch (err) {
    console.error(err);
    if (err?.code === 11000) return res.status(409).json({ error: "Esta quota já foi paga (mês/ano duplicado)." });
    return res.status(500).json({ error: "Erro ao criar quota." });
  }
});

// ──── QUOTAS: Editar ────
app.put("/api/admin/quotas/:id", async (req, res) => {
  try {
    const { tipo, mes, ano, valor } = req.body;
    const update = {};
    if (tipo) update.tipo = tipo;
    if (mes) update.mes = Number(mes);
    if (ano) update.ano = Number(ano);
    if (valor !== undefined) update.valor = Number(valor);

    const quota = await QuotaPayment.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!quota) return res.status(404).json({ error: "Quota não encontrada." });
    return res.json({ message: "Quota atualizada.", quota });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar quota." });
  }
});

// ──── QUOTAS: Eliminar ────
app.delete("/api/admin/quotas/:id", async (req, res) => {
  try {
    const quota = await QuotaPayment.findByIdAndDelete(req.params.id);
    if (!quota) return res.status(404).json({ error: "Quota não encontrada." });
    return res.json({ message: "Quota eliminada." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar quota." });
  }
});

// ──── INSCRIÇÕES: Criar (admin direto) ────
app.post("/api/admin/inscricoes", async (req, res) => {
  try {
    const { email, nome, nome_atleta, escalao, mensalidade, estado } = req.body;
    if (!email || !nome || !nome_atleta || !escalao) {
      return res.status(400).json({ error: "Campos obrigatórios em falta." });
    }

    // Buscar nº sócio do user
    const user = await User.findOne({ email }).lean();
    const numeroSocio = user ? (user.numeroSocio || 0) : 0;

    const inscricao = await Registration.create({
      email, nome, nome_atleta, numeroSocio, escalao,
      mensalidade: mensalidade || "0",
      dataInscricao: hojeYYYYMMDD(),
      estado: estado || "Pendente",
    });

    return res.status(201).json({ message: "Inscrição criada.", inscricao });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar inscrição." });
  }
});

// ──── INSCRIÇÕES: Editar (campos completos) ────
app.put("/api/admin/inscricoes/:id", async (req, res) => {
  try {
    const { nome, nome_atleta, escalao, mensalidade, estado } = req.body;
    const update = {};
    if (nome) update.nome = nome;
    if (nome_atleta) update.nome_atleta = nome_atleta;
    if (escalao) update.escalao = escalao;
    if (mensalidade !== undefined) update.mensalidade = mensalidade;
    if (estado && ["Pendente", "Aprovada", "Rejeitada"].includes(estado)) update.estado = estado;

    const inscricao = await Registration.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!inscricao) return res.status(404).json({ error: "Inscrição não encontrada." });
    return res.json({ message: "Inscrição atualizada.", inscricao });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar inscrição." });
  }
});

// ──── INSCRIÇÕES: Eliminar ────
app.delete("/api/admin/inscricoes/:id", async (req, res) => {
  try {
    const inscricao = await Registration.findByIdAndDelete(req.params.id);
    if (!inscricao) return res.status(404).json({ error: "Inscrição não encontrada." });
    return res.json({ message: "Inscrição eliminada." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar inscrição." });
  }
});

// ──── TREINADORES: Listar ────
app.get("/api/admin/treinadores", async (req, res) => {
  try {
    const { search, estado, escalao } = req.query;
    const filter = {};

    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ nome: regex }, { email: regex }, { escalao: regex }];
    }
    if (estado) filter.estado = estado;
    if (escalao) filter.escalao = escalao;

    const data = await Treinador.find(filter).sort({ createdAt: -1 }).lean();

    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar treinadores." });
  }
});

// ──── TREINADORES: Criar ────
app.post("/api/admin/treinadores", async (req, res) => {
  try {
    const { nome, email, telefone, escalao, funcao, dataInicio, estado } = req.body;
    if (!nome || !email || !escalao || !funcao) {
      return res.status(400).json({ error: "Campos obrigatórios em falta (nome, email, escalão, função)." });
    }

    const treinador = await Treinador.create({
      nome, email, telefone: telefone || "",
      escalao, funcao,
      dataInicio: dataInicio || hojeYYYYMMDD(),
      estado: estado || "Ativo",
    });

    return res.status(201).json({ message: "Treinador criado.", treinador });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar treinador." });
  }
});

// ──── TREINADORES: Editar ────
app.put("/api/admin/treinadores/:id", async (req, res) => {
  try {
    const { nome, email, telefone, escalao, funcao, dataInicio, estado } = req.body;
    const update = {};
    if (nome) update.nome = nome;
    if (email) update.email = email;
    if (telefone !== undefined) update.telefone = telefone;
    if (escalao) update.escalao = escalao;
    if (funcao) update.funcao = funcao;
    if (dataInicio) update.dataInicio = dataInicio;
    if (estado && ["Ativo", "Inativo"].includes(estado)) update.estado = estado;

    const treinador = await Treinador.findByIdAndUpdate(req.params.id, update, { new: true }).lean();
    if (!treinador) return res.status(404).json({ error: "Treinador não encontrado." });
    return res.json({ message: "Treinador atualizado.", treinador });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar treinador." });
  }
});

// ──── TREINADORES: Eliminar ────
app.delete("/api/admin/treinadores/:id", async (req, res) => {
  try {
    const treinador = await Treinador.findByIdAndDelete(req.params.id);
    if (!treinador) return res.status(404).json({ error: "Treinador não encontrado." });
    return res.json({ message: "Treinador eliminado." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar treinador." });
  }
});

// Produtos Loja — listar com pesquisa e filtro
app.get("/api/admin/produtos", async (req, res) => {
  try {
    const { search, categoria } = req.query;
    const filter = {};
    if (search) {
      const regex = new RegExp(search, "i");
      filter.$or = [{ nome: regex }, { sku: regex }];
    }
    if (categoria) filter.categoria = categoria;
    const data = await ShopProduct.find(filter).sort({ categoria: 1, sku: 1 }).lean();
    return res.json({ data });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao carregar produtos da loja." });
  }
});

// Produtos Loja — criar
app.post("/api/admin/produtos", async (req, res) => {
  try {
    const { sku, nome, categoria, preco } = req.body;
    if (!sku || !nome || !categoria || preco === undefined)
      return res.status(400).json({ error: "Campos obrigatórios: sku, nome, categoria, preco." });
    const produto = await ShopProduct.create({ sku, nome, categoria, preco });
    return res.json({ produto });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "SKU já existe." });
    console.error(err);
    return res.status(500).json({ error: "Erro ao criar produto." });
  }
});

// Produtos Loja — editar
app.put("/api/admin/produtos/:id", async (req, res) => {
  try {
    const { nome, categoria, preco } = req.body;
    const produto = await ShopProduct.findByIdAndUpdate(
      req.params.id,
      { nome, categoria, preco },
      { new: true, runValidators: true }
    ).lean();
    if (!produto) return res.status(404).json({ error: "Produto não encontrado." });
    return res.json({ produto });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao atualizar produto." });
  }
});

// Produtos Loja — eliminar
app.delete("/api/admin/produtos/:id", async (req, res) => {
  try {
    await ShopProduct.findByIdAndDelete(req.params.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Erro ao eliminar produto." });
  }
});


// ---------------- Start ----------------
app.listen(PORT, () => console.log(`🚀 API a correr em http://localhost:${PORT}`));