require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const firebase = require('./src/firebase.js');
const r2 = require('./src/r2.js');

const app = express();

const db = firebase.db;
const verificarUsuarioFirebase = firebase.verificarUsuarioFirebase;
const gerarLinkTemporarioR2 = r2.gerarLinkTemporarioR2;

const PORTA = process.env.PORT || 8081;

const ORIGENS_PERMITIDAS = (process.env.CORS_ORIGIN || '')
    .split(',')
    .map(origem => origem.trim())
    .filter(Boolean);

function origemPermitida(origin) {
    if (!origin) return true;

    if (ORIGENS_PERMITIDAS.length === 0) {
        return true;
    }

    return ORIGENS_PERMITIDAS.includes(origin);
}

app.use(cors({
    origin(origin, callback) {
        if (origemPermitida(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error('Origem não permitida pelo CORS.'));
    },
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

const TIPOS_VALIDOS = new Set(['canal', 'filme', 'serie']);

function normalizarTipo(tipo) {
    const valor = String(tipo || '').trim().toLowerCase();
    return TIPOS_VALIDOS.has(valor) ? valor : '';
}

function textoSeguro(valor, fallback = '') {
    return String(valor || fallback).trim();
}

function conteudoEstaAtivo(dados) {
    if (!dados) return false;
    if (dados.active === false) return false;
    if (dados.ativo === false) return false;
    return true;
}

function conteudoPublico(doc) {
    const dados = doc.data() || {};

    return {
        id: doc.id,
        titulo: textoSeguro(dados.titulo || dados.name || dados.title, 'Sem título'),
        capa: textoSeguro(dados.capa || dados.cover || dados.stream_icon || dados.movie_image, ''),
        tipo: textoSeguro(dados.tipo, ''),
        categoria: textoSeguro(dados.categoria, 'Geral')
    };
}

async function buscarConteudosPorTipo(tipo) {
    const snapshot = await db.collection('conteudos')
        .where('tipo', '==', tipo)
        .get();

    return snapshot.docs
        .filter(doc => conteudoEstaAtivo(doc.data()))
        .map(conteudoPublico);
}

function validarUrlProxy(url) {
    let parsedUrl;

    try {
        parsedUrl = new URL(url);
    } catch {
        return null;
    }

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return null;
    }

    if (
        parsedUrl.hostname === 'localhost' ||
        parsedUrl.hostname === '127.0.0.1' ||
        parsedUrl.hostname.startsWith('192.168.') ||
        parsedUrl.hostname.startsWith('10.') ||
        parsedUrl.hostname.startsWith('172.16.')
    ) {
        return null;
    }

    return parsedUrl.toString();
}

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        app: 'Nexa Prime API'
    });
});

app.get('/api/me', verificarUsuarioFirebase, (req, res) => {
    res.json({
        ok: true,
        user: {
            uid: req.user.uid,
            email: req.user.email || '',
            role: req.user.role || req.user.plano || 'user',
            active: req.user.active !== false && req.user.ativo !== false
        }
    });
});

app.get('/api/categorias', verificarUsuarioFirebase, async (req, res) => {
    try {
        const tipo = normalizarTipo(req.query.tipo);

        if (!tipo) {
            return res.status(400).json({ erro: 'Tipo inválido.' });
        }

        const conteudos = await buscarConteudosPorTipo(tipo);
        const mapa = new Map();

        conteudos.forEach(item => {
            const nome = item.categoria || 'Geral';
            const chave = nome.toLowerCase();

            const atual = mapa.get(chave) || {
                id: chave,
                nome,
                total: 0
            };

            atual.total += 1;
            mapa.set(chave, atual);
        });

        const categorias = Array.from(mapa.values())
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

        res.json({
            ok: true,
            categorias
        });
    } catch (erro) {
        console.error('Erro ao buscar categorias:', erro);
        res.status(500).json({ erro: 'Erro ao buscar categorias.' });
    }
});

app.get('/api/conteudos', verificarUsuarioFirebase, async (req, res) => {
    try {
        const tipo = normalizarTipo(req.query.tipo);
        const categoria = textoSeguro(req.query.categoria);

        if (!tipo) {
            return res.status(400).json({ erro: 'Tipo inválido.' });
        }

        let conteudos = await buscarConteudosPorTipo(tipo);

        if (categoria) {
            const categoriaNormalizada = categoria.toLowerCase();

            conteudos = conteudos.filter(item => {
                return item.categoria.toLowerCase() === categoriaNormalizada;
            });
        }

        conteudos.sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));

        res.json({
            ok: true,
            conteudos
        });
    } catch (erro) {
        console.error('Erro ao buscar conteúdos:', erro);
        res.status(500).json({ erro: 'Erro ao buscar conteúdos.' });
    }
});

app.get('/api/play/:id', verificarUsuarioFirebase, async (req, res) => {
    try {
        const id = textoSeguro(req.params.id);

        const doc = await db.collection('conteudos').doc(id).get();

        if (!doc.exists) {
            return res.status(404).json({ erro: 'Conteúdo não encontrado.' });
        }

        const dados = doc.data() || {};

        if (!conteudoEstaAtivo(dados)) {
            return res.status(403).json({ erro: 'Conteúdo indisponível.' });
        }

        let url = '';

        if (dados.objectKey) {
            url = await gerarLinkTemporarioR2(dados.objectKey);
        } else if (dados.link) {
            url = dados.link;
        }

        if (!url) {
            return res.status(404).json({ erro: 'Sem link de reprodução.' });
        }

        res.json({
            ok: true,
            id: doc.id,
            titulo: textoSeguro(dados.titulo || dados.name || dados.title, 'Sem título'),
            tipo: textoSeguro(dados.tipo, ''),
            isLive: dados.tipo === 'canal',
            url
        });
    } catch (erro) {
        console.error('Erro ao gerar reprodução:', erro);
        res.status(500).json({ erro: 'Erro no servidor.' });
    }
});

function montarUrlAbsoluta(baseUrl, linha) {
    try {
        return new URL(linha, baseUrl).toString();
    } catch {
        return linha;
    }
}

function deveReescreverLinhaM3u8(linha) {
    const texto = String(linha || '').trim();

    if (!texto) return false;
    if (texto.startsWith('#')) return false;
    if (texto.startsWith('data:')) return false;
    if (texto.startsWith('blob:')) return false;

    return true;
}

function reescreverM3u8(conteudo, baseUrl, req) {
    const origemProxy = `${req.protocol}://${req.get('host')}`;

    return String(conteudo)
        .split(/\r?\n/)
        .map(linhaOriginal => {
            const linha = linhaOriginal.trim();

            if (!deveReescreverLinhaM3u8(linha)) {
                return linhaOriginal;
            }

            const absoluta = montarUrlAbsoluta(baseUrl, linha);
            return `${origemProxy}/api/proxy?url=${encodeURIComponent(absoluta)}`;
        })
        .join('\n');
}

function pareceM3u8(url, contentType) {
    return (
        /\.m3u8(\?|$)/i.test(url) ||
        String(contentType || '').includes('application/vnd.apple.mpegurl') ||
        String(contentType || '').includes('application/x-mpegURL')
    );
}

app.get('/api/proxy', async (req, res) => {
    const targetUrl = validarUrlProxy(req.query.url);

    if (!targetUrl) {
        return res.status(400).send('URL inválida ou não permitida.');
    }

    try {
        const resposta = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxRedirects: 3,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const contentType = resposta.headers['content-type'] || '';

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');

        if (pareceM3u8(targetUrl, contentType)) {
            const texto = Buffer.from(resposta.data).toString('utf8');
            const m3u8Reescrito = reescreverM3u8(texto, targetUrl, req);

            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            return res.send(m3u8Reescrito);
        }

        res.setHeader('Content-Type', contentType || 'application/octet-stream');
        return res.send(Buffer.from(resposta.data));
    } catch (erro) {
        console.error('Erro no proxy:', erro.message);
        return res.status(502).send('Erro ao buscar mídia.');
    }
});

app.use((req, res) => {
    res.status(404).json({
        erro: 'Rota não encontrada.'
    });
});

const PORT = process.env.PORT || 8081;
app.listen(PORT, () => console.log(`✅ Nexa Prime API rodando na porta ${PORT}`
});