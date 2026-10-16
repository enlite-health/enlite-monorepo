'use strict';
/**
 * Guarda de rede dos testes (spec 050, R-16): teste NUNCA alcança terceiro.
 *
 * UM módulo só, usado por todo runner de teste do monorepo:
 *   - worker-functions: `setupFiles` de jest.config.js, jest.config.e2e.js e jest.config.e2e-real.js;
 *   - enlite-frontend: `src/test/setup.ts` (vitest) e `NODE_OPTIONS=--require` nos passos do Playwright
 *     (só o PROCESSO node do runner; o NAVEGADOR do Playwright não passa por aqui — spec 050 §15).
 *
 * Como funciona: troca `net.Socket.prototype.connect`. `http`, `https`, `http2`, `tls`, o `fetch` do Node (undici) e
 * `net.connect` abrem a conexão por esse método, então todos passam por aqui. Destino que não seja local NÃO conecta:
 * o socket é destruído com `RedeBloqueadaEmTesteError` (mensagem `rede bloqueada em teste: <host>`, código `ERR_REDE_BLOQUEADA_EM_TESTE`),
 * ANTES de qualquer consulta de DNS.
 *
 * NÃO cobre: UDP (`dgram`), processo filho que o teste lance, nem navegador. Também não há variável que a desligue
 * (guarda com botão de desligar vira guarda desligada); para sabotar, quebre este arquivo.
 *
 * Liberados (lista EXPLÍCITA, sem curinga): `localhost`, `127.0.0.1`, `::1` e socket Unix (`path`). Os serviços das stacks de
 * CI (Postgres, API, fake-gcs, emulador do Firebase) são alcançados pelo runner via `localhost:<porta>`, então não entram
 * por nome. Dependência legítima de infraestrutura (npm, imagens) acontece ANTES dos testes, em outro passo; se algum teste
 * precisar de um host de infraestrutura, libere POR NOME aqui, com comentário dizendo qual teste e por quê.
 */
const net = require('node:net');

const ALLOWED_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1']);
const BLOCKED_CODE = 'ERR_REDE_BLOQUEADA_EM_TESTE';
const INSTALLED = Symbol.for('enlite.rede-bloqueada-em-teste');

class RedeBloqueadaEmTesteError extends Error {
  constructor(host) {
    super(`rede bloqueada em teste: ${host}`);
    this.name = 'RedeBloqueadaEmTesteError';
    this.code = BLOCKED_CODE;
    this.host = host;
  }
}

/** Destino de `socket.connect(...)`: `null` = socket Unix (local por natureza). */
function targetHost(args) {
  let first = args[0];
  // `net.connect` repassa a forma normalizada `[options, cb]`.
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') {
    if (first.path && !first.host && first.port === undefined) return null;
    return first.host || 'localhost';
  }
  // connect(path) — string que não é número de porta
  if (typeof first === 'string' && !/^\d+$/.test(first)) return null;
  // connect(port[, host][, cb])
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

function isAllowed(host) {
  if (host === null) return true;
  const normalized = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return ALLOWED_HOSTS.includes(normalized);
}

function install() {
  const proto = net.Socket.prototype;
  if (proto[INSTALLED]) return;
  const originalConnect = proto.connect;
  proto.connect = function guardedConnect(...args) {
    const host = targetHost(args);
    if (isAllowed(host)) return originalConnect.apply(this, args);
    process.nextTick(() => this.destroy(new RedeBloqueadaEmTesteError(host)));
    return this;
  };
  Object.defineProperty(proto, INSTALLED, { value: originalConnect });
}

const PROBE_TIMEOUT_MS = 5000;

/**
 * Percorre a cadeia `cause` (o `fetch` embrulha a falha de socket num `TypeError: fetch failed`) e diz se algum elo é o
 * bloqueio desta guarda. Dentro do jest o elo do `fetch` chega sem `code` (cruza o realm do sandbox), por isso o
 * reconhecimento é pelo código OU pela mensagem fixa `rede bloqueada em teste: `.
 */
function descreverFalha(err) {
  let bloqueada = false;
  let elo = err;
  let ultimo = err;
  for (let i = 0; elo && i < 6; i += 1, elo = elo.cause) {
    ultimo = elo;
    if (elo.code === BLOCKED_CODE || /rede bloqueada em teste: /.test(String(elo.message))) {
      bloqueada = true;
      ultimo = elo;
      break;
    }
  }
  return { bloqueada, erro: { code: ultimo && ultimo.code, message: String(ultimo && ultimo.message) } };
}

/**
 * Sonda do teste-controle: tenta abrir uma conexão por UMA camada e diz o que aconteceu.
 * `conectou: true` = a conexão foi estabelecida (o que o controle de bloqueio NÃO pode ver).
 */
function sondar(camada, host, port = 443) {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ conectou: false, bloqueada: false, erro: { code: 'TIMEOUT_DA_SONDA', message: `sem resposta em ${PROBE_TIMEOUT_MS} ms` } }),
      PROBE_TIMEOUT_MS,
    );
    timer.unref();
    const falhou = (err) => {
      clearTimeout(timer);
      resolve({ conectou: false, ...descreverFalha(err) });
    };
    const conectou = (fechar) => {
      clearTimeout(timer);
      try { fechar(); } catch { /* já fechado */ }
      resolve({ conectou: true, bloqueada: false });
    };
    const via = String(camada);
    if (via === 'net') {
      const s = net.connect({ host, port });
      s.once('connect', () => conectou(() => s.destroy()));
      s.once('error', falhou);
    } else if (via === 'tls') {
      const s = require('node:tls').connect({ host, port, servername: host });
      s.once('secureConnect', () => conectou(() => s.destroy()));
      s.once('error', falhou);
    } else if (via === 'http' || via === 'https') {
      const req = require(`node:${via}`).get({ host, port, path: '/', timeout: PROBE_TIMEOUT_MS });
      req.once('response', (res) => conectou(() => { res.destroy(); req.destroy(); }));
      req.once('error', falhou);
    } else if (via === 'http2') {
      const session = require('node:http2').connect(`https://${host}:${port}`);
      session.once('connect', () => conectou(() => session.destroy()));
      session.once('error', falhou);
    } else if (via === 'fetch') {
      fetch(`${port === 443 ? 'https' : 'http'}://${host}:${port}/`)
        .then((res) => conectou(() => res.body && res.body.cancel()))
        .catch(falhou);
    } else {
      clearTimeout(timer);
      resolve({ conectou: false, bloqueada: false, erro: { code: 'CAMADA_DESCONHECIDA', message: via } });
    }
  });
}

install();

module.exports = { ALLOWED_HOSTS, BLOCKED_CODE, RedeBloqueadaEmTesteError, install, sondar };
