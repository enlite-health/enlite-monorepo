import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';
import './registrations';

const DEFAULT_VERSION = '1.0.0';

function resolveServers(): Array<{ url: string; description: string }> {
  const envServers: Array<{ url: string; description: string }> = [];

  const local = process.env.OPENAPI_LOCAL_URL ?? 'http://localhost:8080';
  envServers.push({ url: local, description: 'Local dev (make dev)' });

  if (process.env.OPENAPI_STAGING_URL) {
    envServers.push({
      url: process.env.OPENAPI_STAGING_URL,
      description: 'Staging (enlite-stg)',
    });
  }

  if (process.env.OPENAPI_PROD_URL) {
    envServers.push({
      url: process.env.OPENAPI_PROD_URL,
      description: 'Produção (enlite-prd)',
    });
  }

  return envServers;
}

const SECURITY_SCHEMES = {
  firebaseAuth: {
    type: 'http' as const,
    scheme: 'bearer' as const,
    bearerFormat: 'JWT',
    description:
      'Token Firebase Auth. Workers logam via Google/email; staff via console admin. ' +
      'Header: `Authorization: Bearer <id_token>`.',
  },
  internalApiKey: {
    type: 'apiKey' as const,
    in: 'header' as const,
    name: 'X-API-Key',
    description:
      'Chave compartilhada usada por jobs internos (Cloud Tasks, schedulers) — ' +
      'NUNCA exposta ao frontend.',
  },
  partnerKey: {
    type: 'apiKey' as const,
    in: 'header' as const,
    name: 'X-Partner-Key',
    description:
      'Chave de webhook por parceiro (Talentum, etc.) emitida via `webhook_partners`.',
  },
  twilioSignature: {
    type: 'apiKey' as const,
    in: 'header' as const,
    name: 'X-Twilio-Signature',
    description: 'Assinatura HMAC-SHA1 do Twilio para webhooks (status / inbound).',
  },
  clickupHmac: {
    type: 'apiKey' as const,
    in: 'header' as const,
    name: 'X-Signature',
    description: 'HMAC-SHA256 do ClickUp sobre o body do webhook.',
  },
};

export function buildOpenApiDocument() {
  registerSecuritySchemes();

  const generator = new OpenApiGeneratorV3(registry.definitions);

  return generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Enlite worker-functions API',
      version: process.env.OPENAPI_VERSION ?? DEFAULT_VERSION,
      description: [
        '## Visão geral',
        '',
        'API interna da plataforma Enlite que cobre o ciclo de vida do Acompanhante Terapêutico (AT):',
        'onboarding, documentos, vagas, matching, comunicação (WhatsApp via Twilio) e integrações',
        '(ClickUp, Talentum, Twilio).',
        '',
        '## Convenções',
        '',
        '- **Envelope de resposta**: `{ success: true, data: ... }` em sucesso; `{ success: false, error, details }` em erro.',
        '- **IDs**: UUID v4 para entidades; `case_number` (inteiro humano) é a chave usada pela operação.',
        '- **Datas**: ISO 8601 UTC. Para "fim de dia" usar `23:59` (cap canônico).',
        '- **Paginação**: `limit` (default 20, máx 100) + `offset` (zero-based). Resposta inclui `total`.',
        '- **Auth**: workers e staff autenticam com Firebase ID Token (`Bearer`). Jobs internos usam `X-API-Key`. Webhooks usam chaves/assinaturas específicas.',
        '',
        '## Como adicionar uma rota nova',
        '',
        'Veja `docs/openapi.md`. Toda rota Express precisa de uma entrada correspondente em `src/shared/openapi/registrations/`, senão o teste de cobertura Playwright falha.',
      ].join('\n'),
      contact: {
        name: 'Time Enlite',
        email: 'tech@enlite.health',
      },
    },
    servers: resolveServers(),
    tags: TAGS_ORDER,
  });
}

function registerSecuritySchemes() {
  for (const [name, scheme] of Object.entries(SECURITY_SCHEMES)) {
    registry.registerComponent('securitySchemes', name, scheme);
  }
}

const TAGS_ORDER = [
  { name: 'Health · Status', description: 'Probes de liveness/readiness.' },
  { name: 'Worker · Onboarding', description: 'Criação inicial e lookup de workers.' },
  { name: 'Worker · Profile', description: 'Dados do worker autenticado (`/me`).' },
  { name: 'Worker · Documents', description: 'Documentos do próprio worker.' },
  { name: 'Worker · Jobs', description: 'Listagem e refresh de vagas para o worker.' },
  { name: 'Worker · Status', description: 'Status interno / encuadres / docs vencendo.' },
  { name: 'Worker · Cases', description: 'Casos clínicos vinculados ao worker.' },
  { name: 'Worker · Applications', description: 'Candidaturas do worker (track de canal).' },
  { name: 'User · Account', description: 'Operações de conta do usuário.' },
  { name: 'Admin · Setup', description: 'Bootstrap do primeiro admin (uma vez).' },
  { name: 'Admin · Users', description: 'Gestão de usuários admin/staff/coordinator.' },
  { name: 'Admin · Auth', description: 'Perfil do admin autenticado.' },
  { name: 'Admin · Workers', description: 'Gestão de workers pelo time interno.' },
  { name: 'Admin · Worker Documents', description: 'Validação e gestão de documentos de workers.' },
  { name: 'Admin · Patients', description: 'Pacientes (casos clínicos) e endereços.' },
  { name: 'Admin · Vacancies', description: 'CRUD e listagem de vagas.' },
  { name: 'Admin · Matching', description: 'Match de workers para vagas.' },
  { name: 'Admin · Encuadres', description: 'Movimentação de candidatos no funil.' },
  { name: 'Admin · Talentum', description: 'Integração com Talentum (publish/sync).' },
  { name: 'Admin · Meet Links', description: 'Links de Google Meet de entrevistas.' },
  { name: 'Admin · Social Links', description: 'Links públicos de vaga (por canal).' },
  { name: 'Admin · Funnel', description: 'Funil de encuadres por vaga.' },
  { name: 'Admin · Dashboard', description: 'Métricas operacionais agregadas.' },
  { name: 'Admin · Interview Slots', description: 'Slots de entrevista e booking.' },
  { name: 'Admin · Recruitment', description: 'Pipeline ClickUp ↔ Talentum.' },
  { name: 'Admin · Messaging', description: 'WhatsApp e templates de mensagem.' },
  { name: 'Analytics · Workers', description: 'Estatísticas de workers.' },
  { name: 'Analytics · Vacancies', description: 'Estatísticas de vagas.' },
  { name: 'Analytics · Deduplication', description: 'Detecção e merge de workers duplicados.' },
  { name: 'Analytics · Dashboard', description: 'Dashboards agregados.' },
  { name: 'Public · Jobs', description: 'Listagem pública de vagas (sem auth).' },
  { name: 'Public · Vacancies', description: 'Detalhe de vaga acessível por link público.' },
  { name: 'Internal · Events', description: 'Processamento interno de domain events.' },
  { name: 'Internal · Outbox', description: 'Outbox de notificações.' },
  { name: 'Internal · Reminders', description: 'Lembretes agendados.' },
  { name: 'Internal · Messaging', description: 'Bulk dispatch interno.' },
  { name: 'Internal · Webhooks', description: 'Webhooks internos legados.' },
  { name: 'Webhooks · Talentum', description: 'Webhooks Talentum (prescreening).' },
  { name: 'Webhooks · Twilio', description: 'Webhooks Twilio (status e inbound).' },
  { name: 'Webhooks · ClickUp', description: 'Webhooks ClickUp (pacientes).' },
  { name: 'Webhooks · Test', description: 'Variantes de teste dos webhooks.' },
  { name: 'Recruitment · Test', description: 'Endpoints de teste do pipeline de recruitment.' },
];
