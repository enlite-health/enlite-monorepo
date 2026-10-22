import { describe, expect, it } from 'vitest';
import { ApiError } from '@infrastructure/http/ApiError';
import i18n from '@infrastructure/i18n/config';
import { ENQUADRE_ERROR_KEYS, enquadreErrorKey, isEnquadreStateConflict } from '../enquadreErrors';

const apiErr = (code: string | undefined, status: number, message = 'Maria Gómez maria@x.test'): ApiError =>
  new ApiError({ success: false, error: message, code }, status);

const SERVER_CODES = [
  'TACTIQ_LINK_REQUIRED', 'HOST_NOT_IN_ROSTER', 'ENQUADRE_WORKER_NOT_AVAILABLE', 'ENQUADRE_WORKER_EMAIL_INVALID',
  'ENQUADRE_GUEST_NOT_ALLOWED', 'ENQUADRE_CONFIG_INVALID', 'ENQUADRE_SLOT_IN_PAST', 'CALENDAR_CREATE_FAILED',
  'CALENDAR_UPDATE_FAILED', 'ENQUADRE_EVENT_NOT_OPEN', 'ENQUADRE_EVENT_NOT_ENDED', 'ENQUADRE_PARTICIPANT_ALREADY_MARKED',
  'ENQUADRE_EVENT_NOT_FOUND', 'WORKER_NOT_ELIGIBLE',
];

describe('enquadreErrorKey', () => {
  it.each(SERVER_CODES)('%s tem chave própria, que existe em es e pt-BR', async (code) => {
    const key = enquadreErrorKey(apiErr(code, 409));
    expect(key).not.toBe('admin.vacancyDetail.enquadre.errors.generic');
    for (const lng of ['es', 'pt-BR']) expect(i18n.getFixedT(lng)(key), `${lng} ${key}`).not.toBe(key);
  });

  it('as 14 chaves mapeadas são todas distintas', () => {
    expect(ENQUADRE_ERROR_KEYS).toHaveLength(SERVER_CODES.length);
    expect(new Set(ENQUADRE_ERROR_KEYS).size).toBe(SERVER_CODES.length);
  });

  it('CALENDAR_CREATE_FAILED mostra o texto aprovado do estado E7', async () => {
    await i18n.changeLanguage('es');
    expect(i18n.t(enquadreErrorKey(apiErr('CALENDAR_CREATE_FAILED', 502)))).toBe('No se pudo crear el evento en Google Calendar. No se guardó nada.');
  });

  it('código desconhecido, erro sem code e erro que não é do servidor caem no fallback; nunca na mensagem', () => {
    const fb = 'admin.vacancyDetail.enquadre.kanban.moveError';
    expect(enquadreErrorKey(apiErr('NOVO_CODIGO', 500), fb)).toBe(fb);
    expect(enquadreErrorKey(apiErr(undefined, 500), fb)).toBe(fb);
    expect(enquadreErrorKey(new Error('Maria Gómez'), fb)).toBe(fb);
    expect(enquadreErrorKey(apiErr('NOVO_CODIGO', 500))).toBe('admin.vacancyDetail.enquadre.errors.generic');
  });

  it('nunca devolve a mensagem do servidor (nome/e-mail)', () => {
    for (const code of [...SERVER_CODES, 'DESCONHECIDO']) {
      expect(enquadreErrorKey(apiErr(code, 422, 'Maria Gómez maria@x.test'))).not.toMatch(/Maria|maria@/);
    }
  });
});

describe('isEnquadreStateConflict', () => {
  it('409 de estado recarrega; 409 de Tactiq, 422 e erro comum não', () => {
    expect(isEnquadreStateConflict(apiErr('ENQUADRE_EVENT_NOT_OPEN', 409))).toBe(true);
    expect(isEnquadreStateConflict(apiErr('ENQUADRE_WORKER_NOT_AVAILABLE', 409))).toBe(true);
    expect(isEnquadreStateConflict(apiErr('TACTIQ_LINK_REQUIRED', 409))).toBe(false);
    expect(isEnquadreStateConflict(apiErr('HOST_NOT_IN_ROSTER', 422))).toBe(false);
    expect(isEnquadreStateConflict(new Error('x'))).toBe(false);
  });
});
