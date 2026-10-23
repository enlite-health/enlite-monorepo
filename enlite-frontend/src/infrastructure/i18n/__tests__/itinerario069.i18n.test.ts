/**
 * Spec 069 (T513) — toda chave NOVA da aba Itinerario existe em es E pt-BR, com as mesmas variáveis
 * de interpolação; os códigos de erro de §3.3 têm tradução; os avisos do Ana Care (FR-40) saíram.
 */
import { describe, it, expect } from 'vitest';
import esJson from '../locales/es.json';
import ptBRJson from '../locales/pt-BR.json';

type Json = string | { [key: string]: Json };
const ITIN = 'admin.patients.detail.itinerary';
const get = (json: unknown, path: string): unknown => path.split('.').reduce((o, k) => (o as Record<string, unknown> | undefined)?.[k], json);

/** Todas as folhas (caminho completo → texto) de um ramo. */
function leaves(node: Json, prefix: string, out: Record<string, string> = {}): Record<string, string> {
  if (typeof node === 'string') {
    out[prefix] = node;
    return out;
  }
  for (const [k, v] of Object.entries(node)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}
const vars = (text: string): string[] => [...new Set([...text.matchAll(/{{\s*(\w+)\s*}}/g)].map((m) => m[1]))].sort();

const NEW_BRANCHES = [
  `${ITIN}.serviceList`, `${ITIN}.serviceCard`, `${ITIN}.serviceScreen`, `${ITIN}.weekPicker`, `${ITIN}.upcoming`,
  // F6 — o fluxo "Nueva sustitución", a aba "Sustituciones", a escolha de quem entra e os ajustes da F5
  `${ITIN}.serviceVacancy`, `${ITIN}.fixed`, `${ITIN}.saleEntra`, `${ITIN}.flow`, `${ITIN}.cover`, `${ITIN}.substitutions`,
];
const NEW_ERROR_CODES = [
  'SUBSTITUTION_NO_SHIFTS_IN_PERIOD',
  'WORKER_HAS_PENDING_ENTRY',
  'REQUEST_NOT_UNDOABLE',
  'REQUEST_ALREADY_UNDONE',
  'ALLOCATION_RESTORE_CONFLICT',
  'ABSENCE_ALREADY_EXISTS',
  'ABSENCE_DATE_IN_PAST',
  'SUBSTITUTION_SHIFTS_MISMATCH',
  'NOTHING_TO_COVER',
  'SUBSTITUTE_IS_TITULAR',
  'WORKER_HAS_SCHEDULED_EXIT',
  'WORKER_HAS_SCHEDULED_EXIT_UNDATED',
  'ALREADY_COVERED',
];
/** Os códigos de erro que as rotas do pedido devolvem (F6): todos com texto, nos dois idiomas. */
const F6_ERROR_CODES = [
  'REASON_REQUIRED', 'SUBSTITUTION_SHIFTS_MISMATCH', 'WORKER_HAS_PENDING_ENTRY', 'REQUEST_ALREADY_UNDONE', 'REQUEST_NOT_UNDOABLE',
  'NOTHING_TO_COVER', 'ALLOCATION_RESTORE_CONFLICT', 'ITINERARY_SLOT_CAPACITY_EXCEEDED', 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD', 'ABSENCE_ALREADY_EXISTS',
  'WORKER_HAS_SCHEDULED_EXIT', 'WORKER_HAS_SCHEDULED_EXIT_UNDATED', 'ALREADY_COVERED',
];
const NOTIFICATION_KEYS = [
  'itineraryUncoveredText', 'itineraryUncoveredShifts_one', 'itineraryUncoveredShifts_other', 'itineraryUncoveredServices_one', 'itineraryUncoveredServices_other',
  'itineraryUncoveredContext', 'itineraryUncoveredDetail',
];

describe('itinerário 069 — i18n es + pt-BR', () => {
  it.each(NEW_BRANCHES)('%s: mesmas chaves e mesmas variáveis nos 2 idiomas, nenhuma vazia', (branch) => {
    const es = leaves(get(esJson, branch) as Json, '');
    const pt = leaves(get(ptBRJson, branch) as Json, '');
    expect(Object.keys(es).length).toBeGreaterThan(0);
    expect(Object.keys(pt).sort()).toEqual(Object.keys(es).sort());
    for (const [key, text] of Object.entries(es)) {
      expect(text.length, `es ${branch}.${key}`).toBeGreaterThan(0);
      expect(pt[key].length, `pt-BR ${branch}.${key}`).toBeGreaterThan(0);
      expect(vars(pt[key]), `variáveis de ${branch}.${key}`).toEqual(vars(text));
    }
  });

  it('textos-chave do mockup, literais em es: abas, voltar, nova sustitución, Ir a esta semana, Horario fijo', () => {
    expect(get(esJson, `${ITIN}.serviceScreen.tabs`)).toEqual({ upcoming: 'Próximos días', fixed: 'Horario fijo', substitutions: 'Sustituciones' });
    expect(get(esJson, `${ITIN}.serviceScreen.back`)).toBe('Volver a los servicios');
    expect(get(esJson, `${ITIN}.serviceScreen.newSubstitution`)).toBe('Nueva sustitución');
    expect(get(esJson, `${ITIN}.weekPicker.goToCurrent`)).toBe('Ir a esta semana');
    expect(get(ptBRJson, `${ITIN}.serviceScreen.tabs.fixed`)).toBe('Horário fixo');
  });

  it('o aviso do cartão leva {{days}} (o horizonte vem do GET) — nenhum "7" no texto, em nenhum idioma', () => {
    for (const json of [esJson, ptBRJson]) {
      for (const suffix of ['_one', '_other']) {
        const text = get(json, `${ITIN}.serviceCard.uncoveredShifts${suffix}`) as string;
        expect(text).toContain('{{days}}');
        expect(text).not.toMatch(/\b7\b/);
      }
    }
  });

  it.each(NEW_ERROR_CODES)('código de erro %s tem mensagem em es e pt-BR', (code) => {
    for (const json of [esJson, ptBRJson]) {
      const text = get(json, `${ITIN}.actionErrors.${code}`);
      expect(typeof text === 'string' && text.length > 0, code).toBe(true);
      expect(text).not.toContain(code); // nunca o código cru
    }
  });

  it.each(F6_ERROR_CODES)('F6: código %s tem mensagem em es e pt-BR e não é o código cru', (code) => {
    for (const json of [esJson, ptBRJson]) {
      const text = get(json, `${ITIN}.actionErrors.${code}`);
      expect(typeof text === 'string' && text.length > 0, code).toBe(true);
      expect(text).not.toContain(code);
    }
  });

  it('F6: os textos-chave do mockup, literais em es (Paso N de N, as 3 perguntas, as 3 durações, Sale/Entra, Próximas/Pasadas, colunas)', () => {
    const f = `${ITIN}.flow`;
    expect(get(esJson, `${f}.step`)).toBe('Paso {{current}} de {{total}}');
    expect([`${f}.who.title`, `${f}.howLong.title`, `${f}.whoCovers.title`, `${f}.summary.title`].map((k) => get(esJson, k))).toEqual(['¿Quién no va a venir?', '¿Por cuánto tiempo?', '¿Quién la cubre?', 'Motivo y resumen']);
    expect(['ONE_DAY', 'DAYS', 'PERMANENT'].map((t) => get(esJson, `${f}.howLong.options.${t}.title`))).toEqual(['Un solo día', 'Varios días', 'No vuelve más']);
    expect(get(esJson, `${f}.whoCovers.nobody.title`)).toBe('Nadie todavía');
    expect(get(esJson, `${f}.summary.registering`)).toBe('Vas a registrar:');
    expect(get(esJson, `${ITIN}.saleEntra.pick`)).toBe('Elegir quién entra');
    expect(get(esJson, `${ITIN}.substitutions.filters`)).toEqual({ upcoming: 'Próximas', past: 'Pasadas' });
    expect(get(esJson, `${ITIN}.substitutions.columns`)).toEqual({ when: 'Cuándo', change: 'Cambio', action: 'Acción' });
    expect([get(esJson, `${ITIN}.substitutions.undone`), get(esJson, `${ITIN}.substitutions.adjusted`), get(esJson, `${ITIN}.substitutions.legacy`)]).toEqual(['Deshecha', 'Ajustado', 'Sin pedido (anterior)']);
    expect(get(esJson, `${ITIN}.fixed.noAttention`)).toBe('Sin atención: {{days}}');
    expect(get(esJson, `${ITIN}.serviceVacancy.withCase`)).toBe('Vacante CASO {{caseLabel}} · {{reserveCount}} en Respuesta Rápida');
  });

  it('F6: o texto do conflito leva nome, dia e as duas horas; o do passo 2 leva o nome e a contagem (plural nos dois idiomas)', () => {
    for (const json of [esJson, ptBRJson]) {
      expect(vars(get(json, `${ITIN}.flow.whoCovers.conflict`) as string)).toEqual(['end', 'name', 'start', 'weekday']);
      for (const suffix of ['_one', '_other']) {
        expect(vars(get(json, `${ITIN}.flow.howLong.shiftsCount${suffix}`) as string)).toEqual(['count', 'name']);
        expect(typeof get(json, `${ITIN}.flow.summary.cancelled${suffix}`)).toBe('string');
        expect(typeof get(json, `${ITIN}.substitutions.shifts${suffix}`)).toBe('string');
      }
    }
  });

  it.each(NOTIFICATION_KEYS)('notificação %s existe em es e pt-BR', (key) => {
    for (const json of [esJson, ptBRJson]) expect(typeof get(json, `admin.notifications.${key}`)).toBe('string');
  });

  it('FR-40: a chave do aviso do Ana Care saiu dos 2 grupos, nos 2 idiomas, e o painel antigo de eventos também', () => {
    for (const json of [esJson, ptBRJson]) {
      expect(get(json, `${ITIN}.editModal.anaCareNotice`)).toBeUndefined();
      expect(get(json, 'admin.patients.detail.serviceTeam.substitution.anaCareNotice')).toBeUndefined();
      expect(get(json, `${ITIN}.eventsPanel`)).toBeUndefined();
      expect(get(json, `${ITIN}.newSubstitutionModal`)).toBeUndefined();
    }
  });
});
