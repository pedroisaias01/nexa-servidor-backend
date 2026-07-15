const admin = require('firebase-admin');

function exigirEnv(nome) {
    const valor = process.env[nome];

    if (!valor) {
        throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
    }

    return valor;
}

function carregarPrivateKey() {
    const privateKey = exigirEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');

    if (!privateKey.includes('BEGIN PRIVATE KEY')) {
        throw new Error('FIREBASE_PRIVATE_KEY parece inválida. Confira a chave privada do service account.');
    }

    return privateKey;
}

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: exigirEnv('FIREBASE_PROJECT_ID'),
            clientEmail: exigirEnv('FIREBASE_CLIENT_EMAIL'),
            privateKey: carregarPrivateKey()
        })
    });
}

const db = admin.firestore();

async function buscarPerfilUsuario(uid, email) {
    const tentativas = [
        db.collection('users').doc(uid),
        db.collection('clientes').doc(uid)
    ];

    if (email) {
        tentativas.push(db.collection('clientes').doc(email));
    }

    for (const ref of tentativas) {
        const doc = await ref.get();

        if (doc.exists) {
            return {
                id: doc.id,
                path: ref.path,
                data: doc.data() || {}
            };
        }
    }

    return null;
}

function usuarioAtivo(dados) {
    if (!dados) return false;

    if (dados.active === false) return false;
    if (dados.ativo === false) return false;
    if (dados.status && String(dados.status).toLowerCase() !== 'active') return false;

    return true;
}

async function verificarUsuarioFirebase(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ erro: 'Token não enviado.' });
        }

        const idToken = authHeader.replace('Bearer ', '').trim();

        if (!idToken) {
            return res.status(401).json({ erro: 'Token vazio.' });
        }

        const decodedToken = await admin.auth().verifyIdToken(idToken, true);
        const uid = decodedToken.uid;
        const email = decodedToken.email || '';

        const perfil = await buscarPerfilUsuario(uid, email);

        if (!perfil) {
            return res.status(403).json({ erro: 'Usuário sem cadastro no sistema.' });
        }

        if (!usuarioAtivo(perfil.data)) {
            return res.status(403).json({ erro: 'Usuário inativo.' });
        }

        req.user = {
            uid,
            email,
            profilePath: perfil.path,
            ...perfil.data
        };

        next();
    } catch (erro) {
        console.error('Erro Firebase:', erro);

        return res.status(401).json({
            erro: 'Token inválido ou expirado.'
        });
    }
}

module.exports = {
    admin,
    db,
    verificarUsuarioFirebase
};