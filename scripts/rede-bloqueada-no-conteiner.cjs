'use strict';
/**
 * Teste-controle `rede-bloqueada.controle` DENTRO do contêiner da API (spec 050, R-16).
 *
 * Roda assim, depois de a stack subir (o contêiner não tem este arquivo; vai pela entrada padrão):
 *   docker compose <-f ...> exec -T api node - < scripts/rede-bloqueada-no-conteiner.cjs
 *
 * (a) cada host de terceiro resolve SÓ para o endereço morto dos `extra_hosts` (docker-compose.test.yml) e a conexão
 *     a ele FALHA — se resolver para outro endereço, o bloqueio não está de pé; se conectar, a API alcançaria o terceiro;
 * (b) controle do controle: a própria API (127.0.0.1:8080) É alcançada pelo mesmo mecanismo de conexão.
 * Sai com 1 se qualquer verificação falhar. Não imprime segredo nem corpo de resposta.
 */
const dns = require('node:dns');
const net = require('node:net');

const ENDERECO_MORTO = '127.0.0.1';
const TERCEIROS = ['mcp.tactiq.io', 'api.twilio.com', 'oauth2.googleapis.com', 'www.googleapis.com'];
const API = { host: '127.0.0.1', port: Number(process.env.PORT) || 8080 };

function conectar(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => { s.destroy(); resolve({ conectou: false, motivo: 'timeout' }); }, 3000);
    s.once('connect', () => { clearTimeout(timer); s.destroy(); resolve({ conectou: true }); });
    s.once('error', (e) => { clearTimeout(timer); resolve({ conectou: false, motivo: e.code || e.message }); });
  });
}

async function main() {
  const falhas = [];
  for (const host of TERCEIROS) {
    const enderecos = (await dns.promises.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    const soMorto = enderecos.length > 0 && enderecos.every((a) => a === ENDERECO_MORTO);
    const r = await conectar(host, 443);
    console.log(`rede-bloqueada.controle conteiner (a) ${host} -> resolve=[${enderecos.join(',')}] conectou=${r.conectou}${r.motivo ? ` (${r.motivo})` : ''}`);
    if (!soMorto) falhas.push(`${host} não resolve só para ${ENDERECO_MORTO}`);
    if (r.conectou) falhas.push(`${host}:443 CONECTOU`);
  }
  const local = await conectar(API.host, API.port);
  console.log(`rede-bloqueada.controle conteiner (b) ${API.host}:${API.port} -> conectou=${local.conectou}`);
  if (!local.conectou) falhas.push(`controle do controle: a API local (${API.host}:${API.port}) não foi alcançada`);

  if (falhas.length > 0) {
    console.error(`rede-bloqueada.controle conteiner FALHOU: ${falhas.join('; ')}`);
    process.exit(1);
  }
  console.log('rede-bloqueada.controle conteiner OK');
}

main();
