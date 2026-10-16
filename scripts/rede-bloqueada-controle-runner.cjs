'use strict';
/**
 * Teste-controle `rede-bloqueada.controle` do PROCESSO node dos jobs de Playwright (spec 050, R-16).
 *
 * Os jobs de integração do frontend rodam o Playwright (não o vitest) e não têm jest no caminho, então o controle é um
 * passo do workflow: `node scripts/rede-bloqueada-controle-runner.cjs` (a guarda entra ao carregar o módulo; no passo do
 * Playwright ela entra por `NODE_OPTIONS=--require`). Cobre só o PROCESSO node do runner; o NAVEGADOR não passa por aqui.
 *  (a) `mcp.tactiq.io` falha PELA guarda em cada camada; (b) um servidor em localhost, subido aqui, É alcançado.
 * Sai com 1 se qualquer verificação falhar.
 */
const http = require('node:http');
const { sondar } = require('./rede-bloqueada-em-teste.cjs');

async function main() {
  const falhas = [];
  for (const camada of ['net', 'tls', 'http', 'https', 'http2', 'fetch']) {
    const r = await sondar(camada, 'mcp.tactiq.io', 443);
    console.log(`rede-bloqueada.controle runner (a) ${camada} -> mcp.tactiq.io conectou=${r.conectou} bloqueada=${r.bloqueada} (${r.erro ? r.erro.message : ''})`);
    if (r.conectou || !r.bloqueada) falhas.push(`${camada}: mcp.tactiq.io não foi bloqueado pela guarda`);
  }
  const server = http.createServer((_req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  for (const camada of ['net', 'http', 'fetch']) {
    const r = await sondar(camada, '127.0.0.1', port);
    console.log(`rede-bloqueada.controle runner (b) ${camada} -> 127.0.0.1 conectou=${r.conectou}`);
    if (!r.conectou) falhas.push(`${camada}: o servidor local NÃO foi alcançado (controle do controle)`);
  }
  server.close();
  if (falhas.length > 0) {
    console.error(`rede-bloqueada.controle runner FALHOU: ${falhas.join('; ')}`);
    process.exit(1);
  }
  console.log('rede-bloqueada.controle runner OK');
}

main();
