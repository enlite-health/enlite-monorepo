import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const MeetLinkLookupBody = z.object({
  link: z.string().min(1).openapi({
    description: 'URL do Google Meet para resolver data/hora via Google Calendar.',
    example: 'https://meet.google.com/abc-defg-hij',
  }),
});

const MeetLinksBody = z.object({
  meet_links: z.tuple([
    z.string().nullable(),
    z.string().nullable(),
    z.string().nullable(),
  ]).openapi({
    description: 'Exatamente 3 slots de Meet links (null para vazio).',
    example: ['https://meet.google.com/abc-defg-hij', null, null],
  }),
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/vacancies/meet-links/lookup',
  tags: ['Admin · Meet Links'],
  summary: 'Resolve data/hora de um Meet link',
  description:
    'Consulta o Google Calendar para resolver a data/hora do evento a partir do Meet link. ' +
    'Não persiste — usado pelo form de criação de vaga para preview antes de salvar.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: MeetLinkLookupBody } } } },
  responses: {
    200: { description: 'Data/hora resolvida ou null.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Link inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'put',
  path: '/api/admin/vacancies/{id}/meet-links',
  tags: ['Admin · Meet Links'],
  summary: 'Atualiza Meet links de uma vaga',
  description:
    'Salva até 3 Google Meet links com data/hora resolvida via Google Calendar. ' +
    'Valida formato antes de persistir. Links null limpam o slot.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: MeetLinksBody } } },
  },
  responses: {
    200: { description: 'Meet links atualizados.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Formato de link inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Vaga não encontrada.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
