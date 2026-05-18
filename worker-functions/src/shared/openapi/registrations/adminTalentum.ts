import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const PrescreeningQuestionBody = z.object({
  question: z.string().min(1).openapi({ description: 'Texto da pergunta.', example: 'Tem experiência com TEA?' }),
  responseType: z.array(z.string()).optional().openapi({ description: 'Tipo de resposta aceito.', example: ['text', 'audio'] }),
  desiredResponse: z.string().min(1).openapi({ description: 'Resposta esperada do candidato.', example: 'Sim' }),
  weight: z.number().int().min(1).max(10).openapi({ description: 'Peso da pergunta (1-10).', example: 8 }),
  required: z.boolean().optional().openapi({ description: 'Se a pergunta é obrigatória.', example: true }),
  analyzed: z.boolean().optional().openapi({ description: 'Se deve ser analisada pela IA.', example: true }),
  earlyStoppage: z.boolean().optional().openapi({ description: 'Se resposta errada encerra o prescreening.', example: false }),
});

const PrescreeningFaqItem = z.object({
  question: z.string().openapi({ description: 'Pergunta frequente.', example: 'Qual o horário de trabalho?' }),
  answer: z.string().openapi({ description: 'Resposta padrão.', example: 'Das 9h às 18h, de segunda a sexta.' }),
});

const SavePrescreeningConfigBody = z.object({
  questions: z.array(PrescreeningQuestionBody).openapi({ description: 'Lista de perguntas do prescreening.' }),
  faq: z.array(PrescreeningFaqItem).optional().openapi({ description: 'Perguntas frequentes da vaga.' }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/publish-talentum',
  tags: ['Admin · Talentum'],
  summary: 'Publica vaga no Talentum',
  description:
    'Sincroniza a vaga para o Talentum criando o prescreening correspondente. ' +
    'Requer que a vaga tenha descrição e configuração de prescreening.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Vaga publicada no Talentum.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/vacancies/{id}/publish-talentum',
  tags: ['Admin · Talentum'],
  summary: 'Remove vaga do Talentum',
  description:
    'Desativa o prescreening correspondente no Talentum. ' +
    'Candidatos em andamento continuam sendo processados.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Vaga removida do Talentum.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/generate-talentum-description',
  tags: ['Admin · Talentum'],
  summary: 'Gera descrição para Talentum via IA',
  description:
    'Usa IA (Gemini) para gerar a descrição da vaga no formato exigido pelo Talentum. ' +
    'Persiste a descrição gerada na vaga.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Descrição gerada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/generate-ai-content',
  tags: ['Admin · Talentum'],
  summary: 'Gera conteúdo IA (descrição + prescreening)',
  description:
    'Gera descrição Talentum + perguntas de prescreening + FAQ usando IA. ' +
    'NÃO persiste — retorna o conteúdo gerado para revisão antes de salvar.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Conteúdo gerado pela IA.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/sync-talentum',
  tags: ['Admin · Talentum'],
  summary: 'Sincroniza vagas com Talentum',
  description:
    'Busca todas as vagas do Talentum e sincroniza com o banco local. ' +
    'Suporta flag `?force=true` para ignorar cache e reprocessar tudo.',
  security: [{ firebaseAuth: [] }],
  request: {
    query: z.object({
      force: z.enum(['true', 'false']).optional().openapi({ description: 'Ignora cache e reprocessa tudo.', example: 'true' }),
    }),
  },
  responses: {
    200: { description: 'Relatório de sincronização.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    502: { description: 'Falha na comunicação com Talentum.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/vacancies/{id}/prescreening-config',
  tags: ['Admin · Talentum'],
  summary: 'Retorna configuração de prescreening da vaga',
  description:
    'Retorna as perguntas e FAQ de prescreening configuradas para a vaga. ' +
    'Endpoint de leitura — sem side effects.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Configuração de prescreening.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/{id}/prescreening-config',
  tags: ['Admin · Talentum'],
  summary: 'Salva configuração de prescreening',
  description:
    'Substitui integralmente a configuração de prescreening da vaga (perguntas + FAQ). ' +
    'Operação transacional — deleta tudo e reinsere.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: SavePrescreeningConfigBody } } },
  },
  responses: {
    200: { description: 'Configuração salva.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos (ex: weight fora do range).', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
