/**
 * patientStatusMessages — spec 051 (§6.4): a frase de recusa da troca de estado, a mesma na ficha e no
 * Kanban. Contrato: a frase principal NUNCA carrega código técnico, enum nem nome de célula.
 */
import { describe, it, expect } from 'vitest';
import es from '@infrastructure/i18n/locales/es.json';
import { friendlyStatusMessage, missingItemsLabel } from '../patientStatusMessages';

const dict = es as Record<string, any>;
function t(key: string, opts?: Record<string, unknown>): string {
  let cur: any = dict;
  for (const p of key.split('.')) cur = cur?.[p];
  if (typeof cur !== 'string') return typeof opts?.defaultValue === 'string' ? opts.defaultValue : key;
  return cur.replace(/\{\{(\w+)\}\}/g, (_m: string, k: string) => String(opts?.[k] ?? ''));
}

describe('friendlyStatusMessage', () => {
  it('403 sem permissão: texto da spec §6.4 com o estado de destino traduzido e nenhum termo técnico', () => {
    const m = friendlyStatusMessage(t, { code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', to: 'SEARCHING' })!;
    expect(m).toBe('No tienes permiso para pasar a este paciente a «Búsqueda». Pídele a quien administra los accesos que lo habilite.');
    expect(m).not.toMatch(/patient_status|move_to|PATIENT_STATUS|SEARCHING/);
  });

  it('completude: SEARCHING fala do serviço contratado; outro destino fala dos dados do paciente; a lista "Falta" vem do checklist', () => {
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_NOT_READY', to: 'SEARCHING', missing: ['SERVICE_SCHEDULE'] }))
      .toBe('Para pasar a «Búsqueda», el servicio contratado tiene que estar completo. Falta: horario del servicio.');
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_NOT_READY', to: 'ACTIVE', missing: ['ADDRESS', 'SERVICE_SCHEDULE'] }))
      .toBe('Para pasar a «Activo» faltan datos del paciente: domicilio, horario del servicio.');
  });

  it('completude sem lista (corpo incompleto ou `missing` que não é array) cai na frase genérica — nunca "Falta: ."', () => {
    const generic = 'Para pasar a «Activo» faltan datos obligatorios en la ficha.';
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_NOT_READY', to: 'ACTIVE' })).toBe(generic);
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_NOT_READY', to: 'ACTIVE', missing: 'ADDRESS' as unknown as string[] })).toBe(generic);
  });

  it('motivos obrigatórios, destino indisponível e lista ilegível', () => {
    expect(friendlyStatusMessage(t, { code: 'ON_HOLD_REASON_REQUIRED' })).toBe('Para dejar al paciente «En espera» indica el motivo (escuela, obra social u otro).');
    expect(friendlyStatusMessage(t, { code: 'SUSPENSION_EXIT_REASON_REQUIRED' })).toBe('Para sacar al paciente de «Suspendido» elige el motivo.');
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED' })).toBe('Este cambio de estado no está disponible.');
    expect(friendlyStatusMessage(t, { code: 'STATUS_NOT_OFFERED', to: 'SEARCHING' })).toBe('Este cambio de estado no está disponible.');
    expect(friendlyStatusMessage(t, { code: 'STATUS_OPTIONS_UNAVAILABLE' })).toBe('No se pudieron comprobar los estados disponibles. Intenta de nuevo.');
  });

  it('código desconhecido ou ausente → null (o chamador usa o genérico dele)', () => {
    expect(friendlyStatusMessage(t, { code: 'ALGO_NOVO' })).toBeNull();
    expect(friendlyStatusMessage(t, {})).toBeNull();
  });

  it('destino sem tradução cai no valor cru em vez de quebrar', () => {
    expect(friendlyStatusMessage(t, { code: 'PATIENT_STATUS_MOVE_NOT_PERMITTED', to: 'NOVO_ESTADO' })).toContain('«NOVO_ESTADO»');
  });
});

describe('missingItemsLabel', () => {
  it('minúscula só na 1ª letra, e não em sigla (2ª letra maiúscula); item sem tradução cai no código', () => {
    const fake = (k: string, o?: Record<string, unknown>) => ({ 'admin.patients.detail.completeness.items.A': 'Horario del servicio', 'admin.patients.detail.completeness.items.B': 'CID-11' } as Record<string, string>)[k] ?? String(o?.defaultValue);
    expect(missingItemsLabel(fake, ['A', 'B', 'C'])).toBe('horario del servicio, CID-11, C');
    expect(missingItemsLabel(fake, undefined)).toBe('');
  });
});
