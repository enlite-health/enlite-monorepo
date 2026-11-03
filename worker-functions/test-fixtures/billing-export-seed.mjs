// Semeia o emulador BigQuery (goccy/bigquery-emulator) com um billing export SINTÉTICO (spec 082, T043 / §9.4).
// Só números e nomes de serviço GCP: nenhum dado de pessoa, nenhum dado clínico. Sem dependências (fetch do Node 20).
// Datas relativas a hoje (UTC): a janela do leitor é calculada a partir de "agora", então um arquivo fixo envelheceria.
//   BIGQUERY_EMULATOR_HOST  base do emulador (ex.: http://bigquery-emulator:9050)
//   SEED_PROJECT / SEED_DATASET / SEED_TABLE  default enlite-test / billing_export_test / gcp_billing_export_resource_v1_test
//   SEED_SCENARIO  `anomaly` (default; o do compose) | `calm` | `short` — a tabela é APAGADA e recriada a cada execução, então o e2e
//                  (`custos-painel.integration.e2e.ts`) troca de cenário rodando este arquivo de novo contra a porta publicada do emulador.
//     anomaly  Cloud Run salta ontem (serviço com detalhe) + recurso NOVO de nome longo + 35 recursos pequenos (> 30) + custo sem
//              `resource.name` + 2 projetos (`enlite-test`, `enlite-stg`) + 1 série sem `project.id`
//     calm     o mesmo dado, sem salto e sem recurso novo (ontem igual à mediana)
//     short    só os últimos 5 dias (a janela de 7 dias do dia mais recente não fecha => histórico insuficiente)
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
    ['project', 'RECORD', 'NULLABLE', rec([['id', 'STRING']])],
    ['labels', 'RECORD', 'REPEATED', rec([['key', 'STRING'], ['value', 'STRING']])],
    ['credits', 'RECORD', 'REPEATED', rec([['name', 'STRING'], ['amount', 'FLOAT']])],
  ]),
};

// T056: tabela VAZIA do log `ai_usage` (o sink do Cloud Logging a cria em prd). A consulta do estimado a lê; sem ela o painel perderia a trilha.
const aiDataset = process.env.SEED_AI_DATASET || 'ai_usage_test';
const aiTable = process.env.SEED_AI_TABLE || 'run_googleapis_com_stdout';
const aiSchema = {
  fields: rec([
    ['timestamp', 'TIMESTAMP'],
    ['jsonPayload', 'RECORD', 'NULLABLE', rec([['event', 'STRING'], ['service', 'STRING'], ['setor', 'STRING'], ['funcao', 'STRING'], ['model', 'STRING'], ['tokens_in', 'INTEGER'], ['tokens_out', 'INTEGER']])],
  ]),
};

const scenario = process.env.SEED_SCENARIO || 'anomaly';
if (!['anomaly', 'calm', 'short'].includes(scenario)) throw new Error(`SEED_SCENARIO inválido: ${scenario}`);

// Nome de recurso Cloud Run plausível e LONGO (45 caracteres; UI-2 da spec 082): é o recurso "novo" do cenário `anomaly`.
export const LONG_RESOURCE = 'assistants-service-maria-whatsapp-handler-prd';

// 4 séries x 25 dias (hoje-24 .. hoje), atravessando 2 meses. Por dia: 2 + 6 + 3 + 1 = 12; ontem a série `yesterday` salta de 2 para 14 (anomalia).
const PRJ = 'enlite-test';
const series = [
  { service: 'Cloud Run', resource: 'projects/enlite-test/services/api-sintetica', cost: 2, yesterday: 14, project: PRJ, labels: { setor: 'plataforma', service: 'api' } },
  { service: 'Cloud SQL', resource: 'projects/enlite-test/instances/pg-sintetico', cost: 6, project: PRJ, labels: { setor: 'plataforma', service: 'db' } },
  { service: 'Vertex AI', resource: null, cost: 3, project: PRJ, labels: { setor: 'recrutamento', service: 'parser-sintetico', funcao: 'parser_vaga' } },
  // sem label "setor" e SEM `project.id`: vira a linha "sem setor" e a linha "sem projeto" da tela
  { service: 'Cloud Run', resource: 'projects/enlite-test/services/sem-rotulo', cost: 1, project: null, labels: {} },
];
// Só no cenário `anomaly`: recurso NOVO (sem custo nos 7 dias anteriores) que custa 6 só ontem => item `kind=resource`, `isNew`, nome longo.
if (scenario === 'anomaly') series.push({ service: 'Cloud Run', resource: `projects/enlite-test/services/${LONG_RESOURCE}`, cost: 0, yesterday: 6, onlyYesterday: true, project: PRJ, labels: { setor: 'plataforma', service: 'maria' } });
// 35 recursos de 0,1/dia (constantes: nunca anômalos), no projeto `enlite-stg`: com os 4+1 acima passam de 30 e o top 30 do leitor corta.
const MANY = 35;
for (let i = 1; i <= MANY; i++) {
  series.push({ service: 'Cloud Storage', resource: `projects/enlite-stg/buckets/bucket-sintetico-${String(i).padStart(2, '0')}`, cost: 0.1, lastDays: 9, project: 'enlite-stg', labels: { setor: 'plataforma', service: 'storage' } });
}

// `SEED_DAYS` (opcional) alonga a janela: o e2e do mês fechado precisa de linhas no mês anterior em qualquer dia do mês.
const DAYS = Number(process.env.SEED_DAYS) || (scenario === 'short' ? 5 : 25);
const rows = [];
for (let back = DAYS - 1; back >= 0; back--) {
  const dayMs = todayMs - back * DAY;
  for (const s of series) {
    if (s.lastDays && back >= s.lastDays) continue;
    let cost = s.cost;
    if (back === 1 && s.yesterday !== undefined && scenario !== 'calm') cost = s.yesterday;
    if (cost === 0) continue;
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
    project: s.project ? { id: s.project } : null,
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
  // O emulador responde 500 "already created" (não 409) quando o dataset/tabela já existe: reexecutar o seed (troca de cenário) é normal.
  if (okStatuses.includes(409) && res.status === 500 && /already (created|exists)/i.test(text)) return text;
  if (!okStatuses.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text;
}

for (let i = 0; ; i++) {
  try { await fetch(`${host}/bigquery/v2/projects/${project}/datasets`); break; }
  catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
}
await call('POST', '/datasets', { datasetReference: { projectId: project, datasetId: dataset } }, [200, 409]);
// Troca de cenário: a tabela é apagada e recriada (insertAll só acrescenta). 404 = primeira execução.
await call('DELETE', `/datasets/${dataset}/tables/${table}`, undefined, [200, 204, 404]);
await call('POST', `/datasets/${dataset}/tables`, { tableReference: { projectId: project, datasetId: dataset, tableId: table }, schema }, [200, 409]);
const out = await call('POST', '/datasets', { datasetReference: { projectId: project, datasetId: aiDataset } }, [200, 409]);
await call('POST', `/datasets/${aiDataset}/tables`, { tableReference: { projectId: project, datasetId: aiDataset, tableId: aiTable }, schema: aiSchema }, [200, 409]);
await call('POST', `/datasets/${dataset}/tables/${table}/insertAll`, { rows: rows.map((json, i) => ({ insertId: String(i), json })) });
if (/insertErrors/.test(out)) throw new Error(`insertAll: ${out.slice(0, 400)}`);
console.log(`seed ok (${scenario}): ${rows.length} linhas em ${project}.${dataset}.${table}; tabela vazia ${project}.${aiDataset}.${aiTable}`);
