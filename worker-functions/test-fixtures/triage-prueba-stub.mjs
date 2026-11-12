// Stub do triage para o e2e de TELA da Luz (prueba) (spec 086, `enlite-frontend/e2e/integration/luz-prueba.integration.e2e.ts`).
// O triage real não existe no CI: este servidor ocupa o lugar dele NA FRONTEIRA DE SAÍDA do worker-functions (`TRIAGE_PRUEBA_URL`),
// então a rota da plataforma, a célula e o contador rodam de verdade. Responde `POST /internal/luz/prueba/turn` com uma resposta fixa
// e guarda cada request (`x-enlite-gatilho-id` + corpo) para o teste ler em `GET /_requests`. Zero dependência (só `node:http`).
import http from 'node:http';

const PORT = Number(process.env.PORT || 9060);
const requests = [];

const RESPOSTA = {
  tipo: 'reply',
  texto: 'Hola, soy la Luz (stub)',
  ferramentas: [
    { nome: 'get_worker_status', ok: true, prueba: false },
    { nome: 'apply_to_vacancy', ok: true, prueba: true },
  ],
  validadores: ['notario:x'],
  prestadora: { nome: 'Prueba Luz PRUEBA' },
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/_requests') return json(res, 200, requests);
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && req.url === '/internal/luz/prueba/turn') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { codigo: 'REQUISICAO_INVALIDA' });
        }
        requests.push({ gatilho: req.headers['x-enlite-gatilho-id'] ?? null, body });
        json(res, 200, RESPOSTA);
      });
      return;
    }
    json(res, 404, { codigo: 'NAO_ENCONTRADO' });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`triage-prueba-stub em :${PORT}`));
