import { registry, z } from '../registry';
import { ErrorResponseSchema, successResponseSchema, UuidParam } from '../schemas/common';

/**
 * `src/modules/patient-documents/interfaces/routes/patientDocumentsRoutes.ts` (spec 031, aba "Documentos"
 * da ficha do paciente). Família `admin.patients`; células `patient_document:read|create|update|delete`.
 * O teste de cobertura FALHA se uma rota Express não tiver registro (ver `registrations/index.ts`).
 */
const PatientIdParams = z.object({ id: UuidParam });
const DocumentIdParams = z.object({ id: UuidParam, docId: UuidParam });

const PatientDocumentDto = z.object({
  id: z.string().uuid(),
  origin: z.enum(['tab', 'chat']).openapi({ description: '`tab` = subido na aba; `chat` = anexado numa mensagem do chat do paciente.' }),
  label: z.string().nullable().openapi({ description: 'Nome do documento (livre, dado pela operadora). `null` só se a decifra falhar neste item.' }),
  contentType: z.string(),
  sizeBytes: z.number().int().positive(),
  createdAt: z.string().datetime(),
  createdByUid: z.string(),
  createdByDisplayName: z.string().nullable(),
  labelUpdatedAt: z.string().datetime().nullable().openapi({ description: 'Quando o nome foi editado pela última vez (`null` = nunca).' }),
});

const ListResponse = successResponseSchema(
  'PatientDocumentListResponse',
  z.array(PatientDocumentDto),
  'Mais novo primeiro. UMA fonte: documentos subidos na aba E os que entraram pelo chat. `[]` = não há documento.',
);
const OneResponse = successResponseSchema('PatientDocumentResponse', PatientDocumentDto);
const UrlResponse = successResponseSchema(
  'PatientDocumentUrlResponse',
  z.object({ url: z.string().url(), expiresInSeconds: z.number().int().openapi({ description: 'Sempre 300.' }) }),
);

const UploadBody = z.object({
  file: z.string().openapi({ format: 'binary', description: 'PDF, PNG, JPEG ou .docx — máx. 10 MB (mesma política do chat).' }),
  label: z.string().min(1).max(255).openapi({ description: 'Nome do documento, livre, obrigatório (trim, 1–255).' }),
});
const RenameBody = z.object({ label: z.string().min(1).max(255) });

const err = (description: string) => ({ description, content: { 'application/json': { schema: ErrorResponseSchema } } });
const noSession = err('Não autenticado.');
const noCell = err('Sem a célula exigida.');
const notFound = err('Paciente inexistente (ou de outro país), OU documento inexistente/de outro paciente — a resposta não distingue.');
const serverError = err('Erro interno.');

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/documents',
  tags: ['Admin · Patient Documents'],
  summary: 'Lista os documentos do paciente',
  description: 'Célula `patient_document:read`. Quem tem a célula vê TODOS os documentos, inclusive os do chat, mesmo sem `patient_conversation:read`. Trilha `logResourceAccess` (só UUID).',
  security: [{ firebaseAuth: [] }],
  request: { params: PatientIdParams },
  responses: { 200: { description: 'Lista.', content: { 'application/json': { schema: ListResponse } } }, 401: noSession, 403: noCell, 404: notFound, 500: serverError },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/patients/{id}/documents',
  tags: ['Admin · Patient Documents'],
  summary: 'Sobe um documento pela aba (multipart)',
  description: 'Célula `patient_document:create`. Tipo e tamanho validados NO SERVIDOR (pipeline do chat: 413 acima de 10 MB, 415 fora de PDF/PNG/JPEG/DOCX). Nome, caminho e rótulo cifrados.',
  security: [{ firebaseAuth: [] }],
  request: { params: PatientIdParams, body: { content: { 'multipart/form-data': { schema: UploadBody } } } },
  responses: {
    201: { description: 'Documento criado.', content: { 'application/json': { schema: OneResponse } } },
    400: err('`label` ausente/vazio/longo demais, ou `file` ausente.'),
    401: noSession,
    403: noCell,
    404: notFound,
    413: err('`FILE_TOO_LARGE` — acima de 10 MB.'),
    415: err('`UNSUPPORTED_MEDIA_TYPE`, `MALICIOUS_CONTENT_DETECTED` ou `LEGACY_DOC_NOT_ALLOWED`.'),
    500: serverError,
  },
});

registry.registerPath({
  method: 'patch',
  path: '/api/admin/patients/{id}/documents/{docId}',
  tags: ['Admin · Patient Documents'],
  summary: 'Renomeia um documento na lista',
  description: 'Célula `patient_document:update`. Só o nome na lista muda (o nome do arquivo na mensagem do chat não). Grava quem e quando renomeou.',
  security: [{ firebaseAuth: [] }],
  request: { params: DocumentIdParams, body: { content: { 'application/json': { schema: RenameBody } } } },
  responses: { 200: { description: 'Documento atualizado.', content: { 'application/json': { schema: OneResponse } } }, 400: err('`label` vazio, só espaços ou > 255.'), 401: noSession, 403: noCell, 404: notFound, 500: serverError },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/patients/{id}/documents/{docId}',
  tags: ['Admin · Patient Documents'],
  summary: 'Exclui um documento (DEFINITIVO)',
  description: 'Célula `patient_document:delete`. Some a linha e o objeto do bucket; se veio do chat, a mensagem passa a mostrar "documento eliminado" (`deleted: true` no anexo) e o link do anexo responde 404.',
  security: [{ firebaseAuth: [] }],
  request: { params: DocumentIdParams },
  responses: { 204: { description: 'Excluído.' }, 401: noSession, 403: noCell, 404: notFound, 500: serverError },
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/patients/{id}/documents/{docId}/url',
  tags: ['Admin · Patient Documents'],
  summary: 'URL assinada para abrir o arquivo',
  description: 'Célula `patient_document:read` (NÃO exige `patient_conversation:read`, nem para documento do chat). Signed URL v4, 300 s, a cada clique. Trilha `logResourceAccess` com o UUID do documento.',
  security: [{ firebaseAuth: [] }],
  request: { params: DocumentIdParams },
  responses: { 200: { description: 'URL assinada.', content: { 'application/json': { schema: UrlResponse } } }, 401: noSession, 403: noCell, 404: notFound, 500: serverError },
});
