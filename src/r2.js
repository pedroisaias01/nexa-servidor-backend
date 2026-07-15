String.raw`const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

function exigirEnv(nome) {
    const valor = process.env[nome];

    if (!valor) {
        throw new Error('Variavel de ambiente obrigatoria ausente para R2: ' + nome);
    }

    return valor;
}

function criarClienteR2() {
    return new S3Client({
        region: 'auto',
        endpoint: 'https://' + exigirEnv('R2_ACCOUNT_ID') + '.r2.cloudflarestorage.com',
        credentials: {
            accessKeyId: exigirEnv('R2_ACCESS_KEY_ID'),
            secretAccessKey: exigirEnv('R2_SECRET_ACCESS_KEY')
        }
    });
}

async function gerarLinkTemporarioR2(objectKey) {
    if (!objectKey) {
        throw new Error('objectKey nao informado.');
    }

    const command = new GetObjectCommand({
        Bucket: exigirEnv('R2_BUCKET'),
        Key: objectKey
    });

    return getSignedUrl(criarClienteR2(), command, {
        expiresIn: Number(process.env.SIGNED_URL_TTL || 600)
    });
}

module.exports = {
    gerarLinkTemporarioR2
};`;
