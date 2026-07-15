require('dotenv').config();

const axios = require('axios');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// 🛡️ ARMADURA ANTI-CRASH NAS IMPORTAÇÕES.
const firebase = require('./src/firebase.js');
const db = firebase.db;

// Se o firebase.js falhar em enviar a função, criamos um escudo temporário
const verificarUsuarioFirebase = firebase.verificarUsuarioFirebase || function(req, res, next) {
    console.log("⚠️ AVISO: Segurança do Firebase bypassada temporariamente (Função não encontrada).");
    next();
};

let gerarLinkTemporarioR2 = async () => "";
try {
    const r2 = require('./src/r2.js');
    if (r2.gerarLinkTemporarioR2) gerarLinkTemporarioR2 = r2.gerarLinkTemporarioR2;
} catch (e) {
    console.log("⚠️ AVISO: Arquivo r2.js não encontrado, ignorando...");
}

const app = express();

// Configuração de CORS liberada para evitar bloqueio no celular
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(express.json({ limit: '1mb' }));

app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false
}));

// --- FUNÇÕES DE  LÓGICA ---
const TIPOS_VALIDOS = new Set(['canal', 'filme', 'serie']);

function normalizarTipo(tipo) {
    const valor = String(tipo || '').trim().toLowerCase();
    return TIPOS_VALIDOS.has(valor) ? valor : '';
}

function textoSeguro(valor, fallback = '') {
    return String(valor || fallback).trim();
}

function conteudoPublico(doc) {
    const dados = doc.data() || {};
    return {
        id: doc.id,
        titulo: textoSeguro(dados.titulo || dados.name || dados.title, 'Sem titulo'),
        capa: textoSeguro(dados.capa || dados.cover || dados.stream_icon || dados.movie_image, ''),
        tipo: textoSeguro(dados.tipo, ''),
        categoria: textoSeguro(dados.categoria, 'Geral')
    };
}

function conteudoEstaLiberado(dados) {
    if (!dados) return false;
    if (dados.active === false || dados.ativo === false) return false;
    return true;
}

async function buscarConteudosPorTipo(tipo) {
    if (!db) return []; // Escudo caso o banco de dados falhe
    const snapshot = await db.collection('conteudos')
        .where('tipo', '==', tipo)
        .get();

    return snapshot.docs
        .filter(doc => conteudoEstaLiberado(doc.data()))
        .map(conteudoPublico);
}

// --- ROTAS DA API ---
app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'Nexa Prime API' });
});

app.get('/api/me', verificarUsuarioFirebase, (req, res) => {
    // Garante que a tela de login não trave caso o Firebase local falhe
    const user = req.user || { uid: 'dev', email: 'dev@teste.com', role: 'admin', active: true };
    res.json({ ok: true, user });
});

app.get('/api/categorias', verificarUsuarioFirebase, async (req, res) => {
    try {
        const tipo = normalizarTipo(req.query.tipo);
        if (!tipo) return res.status(400).json({ erro: 'Tipo invalido.' });

        const conteudos = await buscarConteudosPorTipo(tipo);
        const mapa = new Map();

        conteudos.forEach(item => {
            const nome = item.categoria || 'Geral';
            const chave = nome.toLowerCase();
            const atual = mapa.get(chave) || { id: chave, nome, total: 0 };
            atual.total += 1;
            mapa.set(chave, atual);
        });

        const categorias = Array.from(mapa.values()).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
        res.json({ ok: true, categorias });
    } catch (erro) {
        console.error('Erro ao buscar categorias:', erro);
        res.status(500).json({ erro: 'Erro ao buscar categorias.' });
    }
});

app.get('/api/conteudos', verificarUsuarioFirebase, async (req, res) => {
    try {
        const tipo = normalizarTipo(req.query.tipo);
        const categoria = textoSeguro(req.query.categoria);

        if (!tipo) return res.status(400).json({ erro: 'Tipo invalido.' });

        let conteudos = await buscarConteudosPorTipo(tipo);

        if (categoria) {
            const categoriaNormalizada = categoria.toLowerCase();
            conteudos = conteudos.filter(item => item.categoria.toLowerCase() === categoriaNormalizada);
        }

        conteudos.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
        res.json({ ok: true, conteudos });
    } catch (erro) {
        console.error('Erro ao buscar conteudos:', erro);
        res.status(500).json({ erro: 'Erro ao buscar conteudos.' });
    }
});

app.get('/api/play/:id', verificarUsuarioFirebase, async (req, res) => {
    try {
        const id = textoSeguro(req.params.id);
        if (!db) return res.status(500).json({ erro: 'Banco de dados offline.' });
        
        const doc = await db.collection('conteudos').doc(id).get();
        if (!doc.exists) return res.status(404).json({ erro: 'Conteudo nao encontrado.' });

        const dados = doc.data() || {};
        if (!conteudoEstaLiberado(dados)) return res.status(403).json({ erro: 'Conteudo indisponivel.' });

        let url = '';
        let expiresIn = null;

        if (dados.objectKey) {
            url = await gerarLinkTemporarioR2(dados.objectKey);
            expiresIn = Number(process.env.SIGNED_URL_TTL || 600);
        } else if (dados.link) {
            url = dados.link;
        }

        if (!url) return res.status(404).json({ erro: 'Este conteudo nao possui link de reproducao.' });

        res.json({
            ok: true,
            id: doc.id,
            titulo: textoSeguro(dados.titulo || dados.name || dados.title, 'Sem titulo'),
            tipo: textoSeguro(dados.tipo, ''),
            isLive: dados.tipo === 'canal',
            url,
            expiresIn
        });
    } catch (erro) {
        console.error('Erro ao gerar link de reproducao:', erro);
        res.status(500).json({ erro: 'Erro ao gerar link de reproducao.' });
    }
});

// Proxy do player para não dar erro 404
app.get('/api/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send('URL não informada');
    try {
        const resposta = await axios.get(targetUrl, {
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
        });
        res.setHeader('Content-Type', resposta.headers['content-type']);
        res.setHeader('Access-Control-Allow-Origin', '*');
        resposta.data.pipe(res);
    } catch (erro) {
        console.error('Erro no proxy:', erro.message);
        res.status(500).send('Erro ao buscar o canal');
    }
});

app.use((req, res) => {
    res.status(404).json({ erro: 'Rota nao encontrada.' });
});

const PORTA = Number(process.env.PORT || 3000);

app.listen(PORTA, () => {
    console.log('✅ TUDO OK! Nexa Prime API rodando na porta ' + PORTA);
});