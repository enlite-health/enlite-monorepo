import { registry, z } from '../registry';
import { ErrorResponseSchema } from '../schemas/common';

const ScaleOption = z.object({
  code: z.string().openapi({ description: 'Chave estável da opção (rótulo da planilha em minúsculas, sem acento, "_").', example: 'no_lo_hizo' }),
  position: z.number().int(),
  label: z.string(),
  meaning: z.string(),
  score: z.number().int().nullable().openapi({ description: 'Nota da opção; null = a planilha não define nota (lacuna L1), nunca inventada.' }),
  alert: z.object({ kind: z.string(), text: z.string() }).nullable().openapi({ description: 'Aviso literal da planilha; só IMMEDIATE gera sinal no painel (DC-5). Nenhum envio automático.' }),
  asksReason: z.boolean(),
});

const Scale = z.object({
  code: z.string(),
  name: z.string(),
  answeredBy: z.enum(['AT', 'CAREGIVER']),
  answerKind: z.enum(['SINGLE_CHOICE', 'COUNT', 'MULTI_CHOICE']),
  options: z.array(ScaleOption),
  reasons: z.array(z.object({ code: z.string(), position: z.number().int(), label: z.string() })),
});

const TemplateObjective = z.object({ id: z.string().uuid(), title: z.string(), question: z.string(), scaleCode: z.string() });
const TemplateActivity = z.object({
  id: z.string().uuid(), title: z.string(), description: z.string().nullable(), scaleCode: z.string(), frequency: z.string().nullable(),
});

const ReportTemplate = z.object({
  occurrenceId: z.string().uuid().openapi({ description: 'Mesmo occurrence_id do itinerário (uuid v5 de slot|data|worker).' }),
  ptiVersionId: z.string().uuid().nullable().openapi({ description: 'null = sem PTI vigente para o serviço da guarda na data (DC-4): informe só com relatório.' }),
  dueAt: z.string().openapi({ description: 'Prazo = fim programado da guarda + 24 h (DC-2). O servidor aceita até +7 dias.' }),
  objectives: z.array(TemplateObjective),
  activities: z.array(TemplateActivity),
});

const AnswerBody = z.object({
  objectiveId: z.string().uuid().optional(),
  activityId: z.string().uuid().optional(),
  scaleCode: z.string(),
  optionCode: z.string().optional(),
  countValue: z.number().int().min(0).max(999).optional(),
  reasonCode: z.string().optional(),
}).openapi({ description: 'Exatamente um de objectiveId/activityId e exatamente um de optionCode/countValue.' });

const SubmitBody = z.object({
  occurrenceId: z.string().uuid(),
  ptiVersionId: z.string().uuid().nullable(),
  narrative: z.string().min(1).max(8000).openapi({ description: 'Relatório descritivo — TEXTO CLÍNICO. Nunca logado nem devolvido em erro.' }),
  narrativeSource: z.enum(['TYPED', 'DICTATED', 'MIXED']),
  deviceSubmittedAt: z.string().datetime({ offset: true }),
  appVersion: z.string().min(1).max(64),
  answers: z.array(AnswerBody).max(600),
});

const err = (description: string) => ({ description, content: { 'application/json': { schema: ErrorResponseSchema } } });
const security = [{ firebaseAuth: [] }];
const inactive = { description: 'Conta inativa.', content: { 'application/json': { schema: z.object({ code: z.literal('ACCOUNT_INACTIVE') }) } } };

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/daily-report-scales',
  tags: ['Worker · Informe da guarda'],
  summary: 'Catálogo de escalas do registro diário (18 escalas, opções, motivos)',
  description: 'Catálogo global, sem PHI. `ETag` = hash do conteúdo; `If-None-Match` igual → 304.',
  security,
  responses: {
    200: { description: 'Escalas.', content: { 'application/json': { schema: z.object({ version: z.string(), scales: z.array(Scale) }) } } },
    304: { description: 'Sem mudança desde o ETag informado.' },
    401: err('Não autenticado.'),
    500: err('Erro interno.'),
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/daily-report-templates',
  tags: ['Worker · Informe da guarda'],
  summary: 'Molde do informe por guarda do prestador (janela máx. 9 dias)',
  description:
    'Uma entrada por guarda do prestador (expansão do itinerário). PTI vigente do SERVIÇO da guarda na data. Sem patient_id, diagnóstico nem contexto clínico (DF-7). '
    + 'Objetivos OM e sem pergunta ficam de fora (L3, DC-4).',
  security,
  request: { query: z.object({ from: z.string().openapi({ example: '2026-11-17' }), to: z.string().openapi({ example: '2026-11-25' }) }) },
  responses: {
    200: { description: 'Moldes.', content: { 'application/json': { schema: z.object({ items: z.array(ReportTemplate) }) } } },
    400: err('Janela inválida (from > to ou mais de 9 dias).'),
    401: err('Não autenticado.'),
    403: inactive,
    500: err('Erro interno.'),
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/workers/me/daily-reports/{reportId}',
  tags: ['Worker · Informe da guarda'],
  summary: 'Envia o informe da guarda (idempotente pelo id, imutável depois de recebido)',
  description:
    '201 criado · 200 mesmo id e mesmo corpo (retry) · 409 `daily_report_conflict` (mesmo id, corpo diferente) · 409 `daily_report_exists` (outro id para a guarda) · '
    + '422 com `code` ∈ occurrence_unknown, daily_report_window_closed, pti_version_mismatch, item_not_in_pti, scale_mismatch, option_unknown, reason_required, '
    + 'reason_not_allowed, objective_answer_missing. O corpo de erro NUNCA ecoa narrativa nem respostas.',
  security,
  request: {
    params: z.object({ reportId: z.string().uuid() }),
    body: { required: true, content: { 'application/json': { schema: SubmitBody } } },
  },
  responses: {
    200: { description: 'Retry do mesmo informe.', content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } } },
    201: { description: 'Criado.', content: { 'application/json': { schema: z.object({ id: z.string().uuid() }) } } },
    400: err('Corpo inválido (details = só os caminhos dos campos).'),
    401: err('Não autenticado.'),
    403: inactive,
    409: err('daily_report_conflict | daily_report_exists.'),
    422: err('Regra do informe violada (code nomeado).'),
    500: err('Erro interno.'),
  },
});
