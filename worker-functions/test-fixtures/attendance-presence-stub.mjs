// Stub do attendance para o e2e do informe da guarda (emenda 077 F5). O attendance real não existe no CI: este servidor ocupa o lugar dele
// NA FRONTEIRA DE SAÍDA do worker-functions (`ATTENDANCE_SERVICE_URL`), então o PUT do informe roda de verdade, com o gate de presença.
// Contrato: `POST /internal/v1/presence/lookup` `{occurrence_ids}` → `[{occurrence_id, worker_id, status, exit_source}]` (attendance `contracts/internal-v1.openapi.yaml`).
// Ocorrência desconhecida responde `CLOSED` (default: os e2e que não tratam de presença seguem verdes); o teste muda o estado por
// `PUT /_presence/:occurrence_id {status}` e lê o que chegou em `GET /_requests` (inclui se veio `Authorization`). Zero dependência.
import http from 'node:http';

const PORT = Number(process.env.PORT || 9070);
const STATUSES = new Set(['NONE', 'OPEN', 'CLOSED', 'CLOSED_DECLARED']);
const presence = new Map();
const requests = [];

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req, cb) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    try { cb(JSON.parse(raw || '{}')); } catch { cb(null); }
  });
};

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && req.url === '/_requests') return json(res, 200, requests);
    if (req.method === 'DELETE' && req.url === '/_state') { presence.clear(); requests.length = 0; return json(res, 200, { ok: true }); }
    const set = req.method === 'PUT' && /^\/_presence\/([0-9a-f-]{36})$/.exec(req.url ?? '');
    if (set) {
      return readBody(req, (b) => {
        if (!b || !STATUSES.has(b.status)) return json(res, 400, { codigo: 'REQUISICAO_INVALIDA' });
        presence.set(set[1], b.status);
        json(res, 200, { ok: true });
      });
    }
    if (req.method === 'POST' && req.url === '/internal/v1/presence/lookup') {
      return readBody(req, (b) => {
        if (!b || !Array.isArray(b.occurrence_ids)) return json(res, 400, { codigo: 'REQUISICAO_INVALIDA' });
        requests.push({ path: req.url, auth: Boolean(req.headers.authorization), occurrence_ids: b.occurrence_ids });
        json(res, 200, b.occurrence_ids.map((id) => {
          const status = presence.get(id) ?? 'CLOSED';
          return { occurrence_id: id, worker_id: status === 'NONE' ? null : 'stub-worker', status, exit_source: status === 'CLOSED' ? 'APP' : status === 'CLOSED_DECLARED' ? 'DECLARED' : null };
        }));
      });
    }
    json(res, 404, { codigo: 'NAO_ENCONTRADO' });
  })
  .listen(PORT, '0.0.0.0', () => console.log(`attendance-presence-stub em :${PORT}`));
