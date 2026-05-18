import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const AdminUploadUrlBody = z.object({
  contentType: z.string().min(1).openapi({ description: 'MIME type do arquivo.', example: 'application/pdf' }),
  originalName: z.string().optional().openapi({ description: 'Nome original do arquivo.', example: 'curriculum.pdf' }),
});

const AdminSaveDocBody = z.object({
  gcsPath: z.string().min(1).openapi({ description: 'Caminho no GCS após upload.', example: 'workers/uuid/curriculum.pdf' }),
  originalName: z.string().optional().openapi({ description: 'Nome original do arquivo.', example: 'curriculum.pdf' }),
});

const AdminViewUrlBody = z.object({
  type: z.string().optional().openapi({ description: 'Tipo do documento para visualização.', example: 'curriculum' }),
});

const ValidateDocBody = z.object({
  validated: z.boolean().openapi({ description: 'true para validar, false para reprovar.', example: true }),
  comment: z.string().optional().openapi({ description: 'Comentário do validador.', example: 'Documento legível e vigente.' }),
});

const AdminAdditionalDocUploadBody = z.object({
  fileName: z.string().min(1).openapi({ description: 'Nome do arquivo adicional.', example: 'certificado.pdf' }),
  contentType: z.string().min(1).openapi({ description: 'MIME type.', example: 'application/pdf' }),
});

const AdminAdditionalDocSaveBody = z.object({
  fileName: z.string().min(1).openapi({ description: 'Nome do arquivo.', example: 'certificado.pdf' }),
  gcsPath: z.string().min(1).openapi({ description: 'Caminho no GCS.', example: 'workers/uuid/additional/cert.pdf' }),
  label: z.string().optional().openapi({ description: 'Label descritiva.', example: 'Certificado de curso AT' }),
});

registry.registerPath({
  method: 'get',
  path: '/api/admin/workers/{id}/additional-documents',
  tags: ['Admin · Worker Documents'],
  summary: 'Lista documentos adicionais do worker',
  description:
    'Retorna todos os documentos extras enviados pelo worker ou pela equipe admin. ' +
    'Requer autenticação de staff.',
  security: [{ firebaseAuth: [] }],
  request: { params: z.object({ id: UuidParam }) },
  responses: {
    200: { description: 'Lista de documentos adicionais.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Worker não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/additional-documents/upload-url',
  tags: ['Admin · Worker Documents'],
  summary: 'Gera URL para upload de documento adicional (admin)',
  description:
    'Retorna URL PUT assinada do GCS para que o admin faça upload de um documento adicional de um worker.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: AdminAdditionalDocUploadBody } } },
  },
  responses: {
    200: { description: 'URL assinada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/additional-documents',
  tags: ['Admin · Worker Documents'],
  summary: 'Salva documento adicional do worker (admin)',
  description:
    'Registra referência de documento adicional após upload pelo admin. ' +
    'Permite múltiplos documentos por worker sem tipo fixo.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: AdminAdditionalDocSaveBody } } },
  },
  responses: {
    201: { description: 'Documento adicional registrado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/workers/{id}/additional-documents/{docId}',
  tags: ['Admin · Worker Documents'],
  summary: 'Remove documento adicional do worker (admin)',
  description:
    'Remove um documento adicional específico pelo UUID do documento. ' +
    'Não deleta o objeto GCS imediatamente.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      id: UuidParam,
      docId: UuidParam,
    }),
  },
  responses: {
    200: { description: 'Documento removido.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/documents/upload-url',
  tags: ['Admin · Worker Documents'],
  summary: 'Gera URL para upload de documento obrigatório (admin)',
  description:
    'Retorna URL PUT assinada do GCS para upload de documento obrigatório de um worker. ' +
    'Usado pelo admin para enviar documentos em nome do worker.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: AdminUploadUrlBody } } },
  },
  responses: {
    200: { description: 'URL assinada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/documents/save',
  tags: ['Admin · Worker Documents'],
  summary: 'Confirma upload de documento obrigatório (admin)',
  description:
    'Registra o caminho GCS do documento obrigatório após upload pelo admin. ' +
    'Atualiza status de validação do documento.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: AdminSaveDocBody } } },
  },
  responses: {
    200: { description: 'Documento registrado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/documents/view-url',
  tags: ['Admin · Worker Documents'],
  summary: 'Gera URL de visualização de documento (admin)',
  description:
    'Retorna URL GET assinada do GCS para visualização de um documento do worker. ' +
    'URL expira em 60 minutos.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
    body: { content: { 'application/json': { schema: AdminViewUrlBody } } },
  },
  responses: {
    200: { description: 'URL de visualização.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/workers/{id}/documents/{type}',
  tags: ['Admin · Worker Documents'],
  summary: 'Remove documento obrigatório do worker (admin)',
  description:
    'Remove a referência de um documento obrigatório pelo tipo. ' +
    'Volta o status do documento para pendente.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      id: UuidParam,
      type: z.string().openapi({ description: 'Tipo do documento.', example: 'curriculum' }),
    }),
  },
  responses: {
    200: { description: 'Documento removido.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/admin/workers/{id}/documents/{type}/validate',
  tags: ['Admin · Worker Documents'],
  summary: 'Valida documento do worker',
  description:
    'Registra a validação (aprovação) de um documento pelo revisor. ' +
    'Quando todos obrigatórios são validados, o worker pode avançar no funil.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      id: UuidParam,
      type: z.string().openapi({ description: 'Tipo do documento a validar.', example: 'curriculum' }),
    }),
    body: { content: { 'application/json': { schema: ValidateDocBody } } },
  },
  responses: {
    200: { description: 'Documento validado.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/admin/workers/{id}/documents/{type}/validate',
  tags: ['Admin · Worker Documents'],
  summary: 'Remove validação de documento do worker',
  description:
    'Reverte a validação de um documento, voltando-o ao status de pendente de revisão. ' +
    'Usado quando o revisor precisa corrigir a avaliação.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      id: UuidParam,
      type: z.string().openapi({ description: 'Tipo do documento.', example: 'curriculum' }),
    }),
  },
  responses: {
    200: { description: 'Validação removida.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
