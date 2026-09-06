/**
 * FR-D2 (spec 014): "es.json sem texto pt-BR nos blocos admin.patients.*" — teste de idioma por
 * lista de palavras/grafemas. Este arquivo cobre `admin.patients.detail.*` (a FICHA), que o
 * `AdminPatients.i18n.test.ts` não cobre (ele é só da LISTA). Guarda especificamente as chaves
 * novas da spec 014 (checklist de completude, aviso de telefone, Sim/Não) — foi exatamente aí
 * que o texto pt-BR morto ficou (D3: "Sim"/"Não" nunca traduzidos porque a chave não existia).
 */
import { describe, it, expect } from 'vitest';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';

function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? flattenKeys(v, path) : [path];
  });
}

function getNested(obj: Record<string, any>, path: string): unknown {
  return path.split('.').reduce((acc: any, key) => acc?.[key], obj);
}

const esDetail = (es as Record<string, any>).admin.patients.detail;
const ptDetail = (ptBR as Record<string, any>).admin.patients.detail;
const esCommon = (es as Record<string, any>).common;
const ptCommon = (ptBR as Record<string, any>).common;

// Grafemas que só existem em pt-BR (não em es-AR): ã, õ, ç, â, ê, ô e o dígrafo "ção"/"ões".
// Es-AR usa á/é/í/ó/ú/ñ/ü — nenhum overlap com esses.
const PT_ONLY_GRAPHEMES = /[ãõçâêô]/i;

describe('admin.patients.detail — es sem grafema pt-BR (FR-D2)', () => {
  const keys = flattenKeys(esDetail);

  it.each(keys)('chave "%s" não contém grafema exclusivo de pt-BR', (key) => {
    const value = getNested(esDetail, key);
    if (typeof value !== 'string') return;
    expect(PT_ONLY_GRAPHEMES.test(value)).toBe(false);
  });
});

describe('common — es sem grafema pt-BR (D3: Sim/Não → Sí/No)', () => {
  it('common.yes em es é "Sí", nunca "Sim"', () => {
    expect(esCommon.yes).toBe('Sí');
    expect(esCommon.yes).not.toBe('Sim');
  });

  it('common.no em es é "No", nunca "Não"', () => {
    expect(esCommon.no).toBe('No');
    expect(PT_ONLY_GRAPHEMES.test(esCommon.no)).toBe(false);
  });

  it('common.yes/no existem nos DOIS locales (chave que faltava fazia o fallback pt-BR vazar)', () => {
    expect(ptCommon.yes).toBeTruthy();
    expect(ptCommon.no).toBeTruthy();
    expect(esCommon.yes).toBeTruthy();
    expect(esCommon.no).toBeTruthy();
  });
});

describe('admin.patients.detail — paridade de chaves es × pt-BR (spec 014)', () => {
  it('toda chave nova da spec 014 (completeness, phoneMatch) existe nos dois locales', () => {
    const esKeys = new Set(flattenKeys(esDetail));
    const ptKeys = new Set(flattenKeys(ptDetail));
    const missingInEs = [...ptKeys].filter((k) => !esKeys.has(k));
    const missingInPt = [...esKeys].filter((k) => !ptKeys.has(k));
    expect(missingInEs).toEqual([]);
    expect(missingInPt).toEqual([]);
  });

  it('admin.patients.detail.completeness tem os 5 itens + title/readyTitle', () => {
    expect(esDetail.completeness.title).toBeTruthy();
    expect(esDetail.completeness.readyTitle).toBeTruthy();
    for (const code of ['ADDRESS', 'RESPONSIBLE', 'COVERAGE', 'CONTRACTED_SERVICE', 'CONSENT']) {
      expect(esDetail.completeness.items[code]).toBeTruthy();
    }
  });

  it('admin.patients.detail.identityCard.patientWhatsapp existe (D3.1: rótulo corrigido)', () => {
    expect(esDetail.identityCard.patientWhatsapp).toBe('WhatsApp del paciente');
  });
});
