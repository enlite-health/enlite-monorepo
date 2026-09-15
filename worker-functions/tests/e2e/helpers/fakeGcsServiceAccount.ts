/**
 * fakeGcsServiceAccount.ts — conserto #1 da 2ª revisão do PR-4 (spec 018).
 *
 * `patient-photo-and-documents.e2e.test.ts` roda um app EM PROCESSO (não a API dockerizada) e usa
 * o `@google-cloud/storage` REAL contra o `fake-gcs-server` — a assinatura v4 de
 * `getReadSignedUrl` é criptografia LOCAL (RSA), não uma chamada de rede ao Google, mas exige um
 * `GOOGLE_APPLICATION_CREDENTIALS` com uma chave privada de verdade no formato certo.
 *
 * Antes, o teste apontava para `/tmp/fake-sa.json` e esperava que esse arquivo já existisse
 * (criado à mão, "fora do repo") — funcionava local mas nunca no CI, que não tem esse arquivo
 * montado do host. Este helper GERA a chave (RSA local, sem acesso real a nada) no próprio setup
 * do teste, idempotente (reaproveita se já existe no diretório temp do processo) — sem depender de
 * nada externo e sem que chave nenhuma (fake ou não) entre no commit.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Gera (ou reaproveita) um service-account JSON fake e devolve o caminho do arquivo. */
export function ensureFakeGcsServiceAccountKey(
  targetPath: string = path.join(os.tmpdir(), 'enlite-fake-gcs-sa-e2e.json'),
): string {
  if (fs.existsSync(targetPath)) return targetPath;

  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  const fakeServiceAccount = {
    type: 'service_account',
    project_id: 'enlite-test',
    private_key_id: 'fake-key-id-e2e',
    private_key: privateKey,
    client_email: 'fake-e2e@enlite-test.iam.gserviceaccount.com',
    client_id: '000000000000000000000',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url:
      'https://www.googleapis.com/robot/v1/metadata/x509/fake-e2e%40enlite-test.iam.gserviceaccount.com',
  };

  fs.writeFileSync(targetPath, JSON.stringify(fakeServiceAccount, null, 2), { mode: 0o600 });
  return targetPath;
}
