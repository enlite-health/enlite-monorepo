#!/usr/bin/env node
/**
 * generate-fake-gcs-sa.js — conserto #1/#7 da 2ª revisão do PR-4 (spec 018).
 *
 * Gera um service-account JSON FAKE (RSA local, sem acesso real a nada) para o
 * `@google-cloud/storage` assinar URLs v4 (`getReadSignedUrl`) contra o fake-gcs-server. Roda
 * DENTRO do container `api` (`docker-compose.test.yml`, comando do serviço) — não depende de
 * nenhum arquivo montado do host, e nenhuma chave (fake ou não) é commitada: o arquivo nasce a
 * cada boot do container, em `/tmp`.
 *
 * Idempotente: se o arquivo já existe (restart do mesmo container sem recriar), não regenera.
 */

const crypto = require('crypto');
const fs = require('fs');

const TARGET_PATH = process.env.FAKE_GCS_SA_PATH || '/tmp/fake-sa.json';

if (fs.existsSync(TARGET_PATH)) {
  process.exit(0);
}

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const fakeServiceAccount = {
  type: 'service_account',
  project_id: 'enlite-test',
  private_key_id: 'fake-key-id-ci',
  private_key: privateKey,
  client_email: 'fake-ci@enlite-test.iam.gserviceaccount.com',
  client_id: '000000000000000000000',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:
    'https://www.googleapis.com/robot/v1/metadata/x509/fake-ci%40enlite-test.iam.gserviceaccount.com',
};

fs.writeFileSync(TARGET_PATH, JSON.stringify(fakeServiceAccount, null, 2), { mode: 0o600 });
console.log(`[generate-fake-gcs-sa] chave fake gerada em ${TARGET_PATH}`);
