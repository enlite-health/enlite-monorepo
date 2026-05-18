import { registry, z } from '../registry';
import { ErrorResponseSchema, OkMessage, UuidParam } from '../schemas/common';

const UploadUrlBody = z.object({
  type: z.string().min(1).openapi({ description: 'Tipo de documento (ex: curriculum, antecedentes_penais).', example: 'curriculum' }),
  contentType: z.string().min(1).openapi({ description: 'MIME type do arquivo.', example: 'application/pdf' }),
});

const SaveDocumentBody = z.object({
  type: z.string().min(1).openapi({ description: 'Tipo de documento.', example: 'curriculum' }),
  gcsPath: z.string().min(1).openapi({ description: 'Caminho do arquivo no GCS após upload.', example: 'workers/uuid/curriculum.pdf' }),
  originalName: z.string().optional().openapi({ description: 'Nome original do arquivo.', example: 'meu_curriculo.pdf' }),
});

const ViewUrlBody = z.object({
  type: z.string().min(1).openapi({ description: 'Tipo de documento para gerar URL temporária de visualização.', example: 'curriculum' }),
});

const AdditionalDocUploadBody = z.object({
  fileName: z.string().min(1).openapi({ description: 'Nome do arquivo adicional.', example: 'certificado_curso.pdf' }),
  contentType: z.string().min(1).openapi({ description: 'MIME type do arquivo.', example: 'application/pdf' }),
});

const AdditionalDocSaveBody = z.object({
  fileName: z.string().min(1).openapi({ description: 'Nome do arquivo.', example: 'certificado_curso.pdf' }),
  gcsPath: z.string().min(1).openapi({ description: 'Caminho no GCS.', example: 'workers/uuid/additional/certificado.pdf' }),
  label: z.string().optional().openapi({ description: 'Label descritiva do documento.', example: 'Certificado de curso' }),
});

registry.registerPath({
  method: 'get',
  path: '/api/workers/me/documents',
  tags: ['Worker · Documents'],
  summary: 'Lista documentos do worker autenticado',
  description:
    'Retorna o status de cada documento obrigatório do worker (curriculum, antecedentes penais, MEI, etc.). ' +
    'Requer Firebase token.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de documentos do worker.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/workers/me/documents/upload-url',
  tags: ['Worker · Documents'],
  summary: 'Gera URL assinada para upload de documento',
  description:
    'Retorna uma URL PUT assinada do GCS para o worker fazer upload direto de um documento. ' +
    'A URL expira em 15 minutos. Requer Firebase token.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: UploadUrlBody } } } },
  responses: {
    200: { description: 'URL assinada gerada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Tipo inválido.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/workers/me/documents/save',
  tags: ['Worker · Documents'],
  summary: 'Confirma upload e salva referência do documento',
  description:
    'Após upload via URL assinada, registra o caminho GCS no banco. ' +
    'Atualiza o status do documento de pending para uploaded.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: SaveDocumentBody } } } },
  responses: {
    200: { description: 'Documento registrado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/workers/me/documents/view-url',
  tags: ['Worker · Documents'],
  summary: 'Gera URL temporária para visualizar documento',
  description:
    'Retorna URL GET assinada do GCS para o worker visualizar seu próprio documento. ' +
    'URL expira em 60 minutos.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: ViewUrlBody } } } },
  responses: {
    200: { description: 'URL de visualização gerada.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Tipo inválido ou documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/workers/me/documents/{type}',
  tags: ['Worker · Documents'],
  summary: 'Remove documento do worker',
  description:
    'Remove o documento do tipo especificado. O GCS object não é deletado imediatamente — ' +
    'apenas a referência no banco é apagada.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({
      type: z.string().openapi({ description: 'Tipo do documento a remover.', example: 'curriculum' }),
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
  method: 'get',
  path: '/api/workers/me/additional-documents',
  tags: ['Worker · Documents'],
  summary: 'Lista documentos adicionais do worker',
  description:
    'Retorna todos os documentos extras (não obrigatórios) enviados pelo worker. ' +
    'Ex: certificados de cursos, seguros complementares.',
  security: [{ firebaseAuth: [] }],
  responses: {
    200: { description: 'Lista de documentos adicionais.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/workers/me/additional-documents/upload-url',
  tags: ['Worker · Documents'],
  summary: 'Gera URL para upload de documento adicional',
  description:
    'Retorna URL PUT assinada do GCS para upload de um documento adicional. ' +
    'Expira em 15 minutos.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: AdditionalDocUploadBody } } } },
  responses: {
    200: { description: 'URL assinada.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'post',
  path: '/api/workers/me/additional-documents',
  tags: ['Worker · Documents'],
  summary: 'Salva referência de documento adicional',
  description:
    'Registra no banco o documento adicional após upload bem-sucedido no GCS. ' +
    'Permite múltiplos documentos por worker sem tipo fixo.',
  security: [{ firebaseAuth: [] }],
  request: { body: { content: { 'application/json': { schema: AdditionalDocSaveBody } } } },
  responses: {
    201: { description: 'Documento adicional registrado.', content: { 'application/json': { schema: OkMessage } } },
    400: { description: 'Dados inválidos.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});

registry.registerPath({
  method: 'delete',
  path: '/api/workers/me/additional-documents/{id}',
  tags: ['Worker · Documents'],
  summary: 'Remove documento adicional do worker',
  description:
    'Remove um documento adicional específico pelo seu UUID. ' +
    'Só pode remover documentos do próprio worker autenticado.',
  security: [{ firebaseAuth: [] }],
  request: {
    params: z.object({ id: UuidParam }),
  },
  responses: {
    200: { description: 'Documento adicional removido.', content: { 'application/json': { schema: OkMessage } } },
    401: { description: 'Não autenticado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    404: { description: 'Documento não encontrado.', content: { 'application/json': { schema: ErrorResponseSchema } } },
    500: { description: 'Erro interno.', content: { 'application/json': { schema: ErrorResponseSchema } } },
  },
});
