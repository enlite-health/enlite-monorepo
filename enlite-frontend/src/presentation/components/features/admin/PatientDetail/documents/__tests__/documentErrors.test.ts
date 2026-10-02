/** documentErrors — spec 031: 413/415 do servidor viram mensagem es-AR; nunca ecoa `err.message`. */
import { describe, it, expect } from 'vitest';
import { ApiError } from '@infrastructure/http/ApiError';
import { uploadErrorKey, renameErrorKey } from '../documentErrors';
import { tEs } from './documentsTestKit';

const apiError = (status: number, code?: string, error = 'segredo-no-servidor.pdf') =>
  new ApiError({ success: false, error, code }, status);

describe('uploadErrorKey', () => {
  it.each([
    [apiError(413, 'FILE_TOO_LARGE'), 'El archivo supera los 10 MB'],
    [apiError(413), 'El archivo supera los 10 MB'],
    [apiError(400, 'FILE_TOO_LARGE'), 'El archivo supera los 10 MB'],
    [apiError(415, 'UNSUPPORTED_MEDIA_TYPE'), 'Tipo de archivo no aceptado'],
    [apiError(415), 'Tipo de archivo no aceptado'],
    [apiError(400, 'UNSUPPORTED_MEDIA_TYPE'), 'Tipo de archivo no aceptado'],
    [apiError(415, 'MALICIOUS_CONTENT_DETECTED'), 'El archivo fue rechazado por contener código activo o macros'],
    [apiError(415, 'LEGACY_DOC_NOT_ALLOWED'), 'Formato .doc no es aceptado; guardá como .docx'],
    [apiError(400, 'INVALID_DOCUMENT_LABEL'), 'El nombre debe tener entre 1 y 255 caracteres'],
    [apiError(500), 'No pudimos subir el archivo. Probá de nuevo.'],
    [new Error('rede caiu'), 'No pudimos subir el archivo. Probá de nuevo.'],
  ])('%#: mensagem es-AR certa e sem ecoar o texto do servidor', (err, expected) => {
    const text = tEs(uploadErrorKey(err));
    expect(text).toBe(expected);
    expect(text).not.toContain('segredo');
  });
});

describe('renameErrorKey', () => {
  it('nome inválido → mensagem do nome; qualquer outra falha → genérica de renomear', () => {
    expect(tEs(renameErrorKey(apiError(400, 'INVALID_DOCUMENT_LABEL')))).toBe('El nombre debe tener entre 1 y 255 caracteres');
    expect(tEs(renameErrorKey(apiError(500)))).toBe('No pudimos renombrar el documento. Probá de nuevo.');
    expect(tEs(renameErrorKey(new Error('x')))).toBe('No pudimos renombrar el documento. Probá de nuevo.');
  });
});
