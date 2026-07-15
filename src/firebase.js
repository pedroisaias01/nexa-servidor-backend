String.raw`const admin = require('firebase-admin');

function exigirEnv(nome) {
    const valor = process.env[nome];

    if (!valor) {
        throw new Error('Variavel de ambiente obrigatoria ausente: ' + nome);
    }

    return valor;
}

const privateKey = exigirEnv('FIREBASE_PRIVATE_KEY').replace(/\\n/g, '\n');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: exigirEnv('FIREBASE_PROJECT_ID'),
            clientEmail: exigirEnv('FIREBASE_CLIENT_EMAIL'),
            privateKey
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
    if (dados.active === false || dados.ativo === false) return false;
    return true;
}

async function verificarUsuarioFirebase(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';

        if (!authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ erro: 'Token nao enviado.' });
        }

        const idToken = authHeader.replace('Bearer ', '').trim();
        const decodedToken = await admin.auth().verifyIdToken(idToken, true);
        const uid = decodedToken.uid;
        const email = decodedToken.email || '';
        const perfil = await buscarPerfilUsuario(uid, email);

        if (!perfil) {
            return res.status(403).json({ erro: 'Usuario sem cadastro no sistema.' });
        }

        if (!usuarioAtivo(perfil.data)) {
            return res.status(403).json({ erro: 'Usuario inativo.' });
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
        res.status(401).json({ erro: 'Token invalido ou expirado.' });
    }
}

module.exports = {
    admin,
    db,
    verificarUsuarioFirebase
};`;
