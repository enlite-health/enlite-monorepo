// Semeia o emulador BigQuery (goccy/bigquery-emulator) com um billing export SINTÉTICO (spec 082, T043 / §9.4).
// Só números e nomes de serviço GCP: nenhum dado de pessoa, nenhum dado clínico. Sem dependências (fetch do Node 20).
// Datas relativas a hoje (UTC): a janela do leitor é calculada a partir de "agora", então um arquivo fixo envelheceria.
//   BIGQUERY_EMULATOR_HOST  base do emulador (ex.: http://bigquery-emulator:9050)
//   SEED_PROJECT / SEED_DATASET / SEED_TABLE  default enlite-test / billing_export_test / gcp_billing_export_resource_v1_test
const host = (process.env.BIGQUERY_EMULATOR_HOST || 'http://localhost:9050').replace(/\/$/, '');
const project = process.env.SEED_PROJECT || 'enlite-test';
const dataset = process.env.SEED_DATASET || 'billing_export_test';
const table = process.env.SEED_TABLE || 'gcp_billing_export_resource_v1_test';

const DAY = 24 * 3600 * 1000;
const now = new Date();
const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
const iso = (ms) => new Date(ms).toISOString();
const invoiceMonth = (ms) => iso(ms).slice(0, 7).replace('-', '');

const rec = (fields) => fields.map(([name, type, mode = 'NULLABLE', sub]) => ({ name, type, mode, ...(sub ? { fields: sub } : {}) }));
const schema = {
  fields: rec([
    ['usage_start_time', 'TIMESTAMP'],
    ['export_time', 'TIMESTAMP'],
    ['cost', 'FLOAT'],
    ['currency', 'STRING'],
    ['service', 'RECORD', 'NULLABLE', rec([['description', 'STRING']])],
    ['resource', 'RECORD', 'NULLABLE', rec([['name', 'STRING']])],
    ['invoice', 'RECORD', 'NULLABLE', rec([['month', 'STRING']])],
    ['labels', 'RECORD', 'REPEATED', rec([['key', 'STRING'], ['value', 'STRING']])],
    ['credits', 'RECORD', 'REPEATED', rec([['name', 'STRING'], ['amount', 'FLOAT']])],
  ]),
};

// 4 séries x 25 dias (hoje-24 .. hoje), atravessando 2 meses. Por dia: 2 + 6 + 3 + 1 = 12; ontem a série `yesterday` salta de 2 para 14 (anomalia).
const series = [
  { service: 'Cloud Run', resource: 'projects/enlite-test/services/api-sintetica', cost: 2, yesterday: 14, labels: { setor: 'plataforma', service: 'api' } },
  { service: 'Cloud SQL', resource: 'projects/enlite-test/instances/pg-sintetico', cost: 6, labels: { setor: 'plataforma', service: 'db' } },
  { service: 'Vertex AI', resource: null, cost: 3, labels: { setor: 'recrutamento', service: 'parser-sintetico', funcao: 'parser_vaga' } },
  // sem label "setor": vira a linha "sem setor" da tela
  { service: 'Cloud Run', resource: 'projects/enlite-test/services/sem-rotulo', cost: 1, labels: {} },
];

const rows = [];
for (let back = 24; back >= 0; back--) {
  const dayMs = todayMs - back * DAY;
  for (const s of series) {
    const cost = back === 1 && s.yesterday ? s.yesterday : s.cost;
    // `export_time` de hoje = 09:00 UTC: dataUntil = hoje => o último dia COMPLETO é ontem (a anomalia mora nele).
    rows.push(mk(s, dayMs, cost, back === 0 ? dayMs + 9 * 3600 * 1000 : dayMs + DAY + 3600 * 1000));
  }
}
function mk(s, dayMs, cost, exportMs) {
  return {
    usage_start_time: iso(dayMs + 3600 * 1000),
    export_time: iso(exportMs),
    cost,
    currency: 'USD',
    service: { description: s.service },
    resource: s.resource ? { name: s.resource } : null,
    invoice: { month: invoiceMonth(dayMs) },
    labels: Object.entries(s.labels).map(([key, value]) => ({ key, value })),
    credits: [],
  };
}
async function call(method, path, body, okStatuses = [200]) {
  const res = await fetch(`${host}/bigquery/v2/projects/${project}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text;
}

for (let i = 0; ; i++) {
  try { await fetch(`${host}/bigquery/v2/projects/${project}/datasets`); break; }
  catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
}
await call('POST', '/datasets', { datasetReference: { projectId: project, datasetId: dataset } }, [200, 409]);
await call('POST', `/datasets/${dataset}/tables`, { tableReference: { projectId: project, datasetId: dataset, tableId: table }, schema }, [200, 409]);
const out = await call('POST', `/datasets/${dataset}/tables/${table}/insertAll`, { rows: rows.map((json, i) => ({ insertId: String(i), json })) });
if (/insertErrors/.test(out)) throw new Error(`insertAll: ${out.slice(0, 400)}`);
console.log(`seed ok: ${rows.length} linhas em ${project}.${dataset}.${table}`);
