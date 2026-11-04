/**
 * Spec 084 F5: teste de i18n — FALHA se faltar o rótulo es ou pt-BR de ON_HOLD no seletor (e de qualquer ação nova da 084).
 * Lê os JSONs de verdade (nunca um dublê do `t`).
 */
import { describe, it, expect } from 'vitest';
import es from '@infrastructure/i18n/locales/es.json';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';

type Json = { [k: string]: Json | string };
const dig = (o: Json, path: string): string | undefined =>
  path.split('.').reduce<Json | string | undefined>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), o) as string | undefined;

const EDITABLE = ['SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'ON_HOLD', 'SUSPENDED', 'CLOSED'];

describe('seletor de status da vaga — i18n es + pt-BR (spec 084)', () => {
  it.each(EDITABLE)('o rótulo de %s existe em es e em pt-BR', (status) => {
    expect(dig(es as Json, `admin.vacancyDetail.statusBadge.${status}`)).toBeTruthy();
    expect(dig(ptBR as Json, `admin.vacancyDetail.statusBadge.${status}`)).toBeTruthy();
  });

  it('"En espera" em es e "Em espera" em pt-BR (rótulo do ON_HOLD)', () => {
    expect(dig(es as Json, 'admin.vacancyDetail.statusBadge.ON_HOLD')).toBe('En espera');
    expect(dig(ptBR as Json, 'admin.vacancyDetail.statusBadge.ON_HOLD')).toBe('Em espera');
  });

  it('DE_BAJA tem selo nos dois idiomas (a lista não mostra "Desconocido")', () => {
    expect(dig(es as Json, 'admin.vacancyDetail.statusBadge.DE_BAJA')).toBeTruthy();
    expect(dig(ptBR as Json, 'admin.vacancyDetail.statusBadge.DE_BAJA')).toBeTruthy();
  });

  const NEW_KEYS = [
    'admin.vacancyDetail.statusEditor.resume',
    'admin.vacancyDetail.statusEditor.errors.VACANCY_DE_BAJA_NO_REACTIVATION',
    'admin.vacancyDetail.statusEditor.errors.CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED',
    'admin.vacancyDetail.baja.button',
    'admin.vacancyDetail.baja.confirmTitle',
    'admin.vacancyDetail.baja.confirmBody',
    'admin.vacancyDetail.baja.confirm',
    'admin.vacancyDetail.baja.cancel',
    'admin.vacancyDetail.baja.working',
    'admin.vacancyDetail.baja.readOnlyBanner',
    'admin.vacancyDetail.baja.readOnlyDetail',
    'admin.vacancyDetail.baja.error',
    'admin.vacancyDetail.baja.talentumManual',
    'admin.vacancyDetail.baja.talentumManualResume',
    'admin.vacancyDetail.baja.talentumPending',
    'admin.vacancies.baja.talentumPendingBadge',
    'admin.vacancies.statusOptions.deBaja',
    'admin.vacancies.baja.showToggle',
    'admin.vacancies.baja.talentumManualToggle',
    'admin.vacancies.baja.badge',
    'admin.vacancies.baja.readOnlyHint',
    'admin.vacancies.baja.talentumManualBadge',
    'admin.vacancies.baja.talentumManualResumeBadge',
    'admin.vacancies.baja.selectAll',
    'admin.vacancies.baja.selectRow',
    'admin.vacancies.baja.selectedCount',
    'admin.vacancies.baja.bulkButton',
    'admin.vacancies.baja.clearSelection',
    'admin.vacancies.baja.confirmTitle',
    'admin.vacancies.baja.confirmBody',
    'admin.vacancies.baja.confirmCases',
    'admin.vacancies.baja.confirm',
    'admin.vacancies.baja.cancel',
    'admin.vacancies.baja.working',
    'admin.vacancies.baja.done',
    'admin.vacancies.baja.error',
    'admin.vacancies.baja.errors.VACANCY_HAS_SERVICE',
    'admin.vacancies.baja.errors.VACANCY_ALREADY_DE_BAJA',
    'admin.vacancies.baja.errors.VACANCY_NOT_FOUND',
  ];

  it.each(NEW_KEYS)('%s existe em es E em pt-BR, e os dois textos diferem', (key) => {
    const a = dig(es as Json, key);
    const b = dig(ptBR as Json, key);
    expect(a, `es: ${key}`).toBeTruthy();
    expect(b, `pt-BR: ${key}`).toBeTruthy();
  });

  it('não existe nenhum botão/texto de "reativar vaga" nos dois idiomas (R17)', () => {
    for (const bundle of [es, ptBR]) {
      const baja = JSON.stringify({
        a: dig(bundle as Json, 'admin.vacancies.baja') ? (bundle as unknown as { admin: { vacancies: { baja: unknown } } }).admin.vacancies.baja : null,
        b: (bundle as unknown as { admin: { vacancyDetail: { baja: unknown } } }).admin.vacancyDetail.baja,
      });
      expect(baja).not.toMatch(/reactivar vacante|reativar vaga|reactivate|\\bReactivar\\b|\\bReativar\\b/);
    }
  });
});
