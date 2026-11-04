/**
 * bigquery-emulator-auth-preload.js — spec 082, T043. SÓ para a stack de teste (carregado por `docker-compose.bigquery-emulator.yml`).
 *
 * O `@google-cloud/bigquery` 9.x lê `BIGQUERY_EMULATOR_HOST` mas NÃO pula a autenticação (não marca `customEndpoint`):
 * cada request passa por `GoogleAuth.authorizeRequest`, que tentaria mintar token em `oauth2.googleapis.com` (rede de terceiros,
 * bloqueada no CI e proibida em teste). Aqui, e só neste processo, `authorizeRequest` devolve a request sem token e o projeto
 * vem de `GOOGLE_CLOUD_PROJECT`. Nenhuma credencial é lida nem enviada. Não altera código de produção.
 * Sem `BIGQUERY_EMULATOR_HOST` não faz nada (nunca age contra o BigQuery real).
 */
'use strict';

if (process.env.BIGQUERY_EMULATOR_HOST) {
  // `@google-cloud/common` tem a SUA cópia de google-auth-library: é nela que o SDK passa.
  const commonDir = require.resolve('@google-cloud/common');
  const { GoogleAuth } = require(require.resolve('google-auth-library', { paths: [commonDir] }));
  GoogleAuth.prototype.authorizeRequest = async function authorizeRequestSemToken(opts) {
    return opts;
  };
  GoogleAuth.prototype.getProjectId = async function projetoDoEmulador() {
    return process.env.GOOGLE_CLOUD_PROJECT || 'enlite-test';
  };
  console.log('[BQ-EMULATOR-AUTH] authorizeRequest sem token; host=' + process.env.BIGQUERY_EMULATOR_HOST);
}
