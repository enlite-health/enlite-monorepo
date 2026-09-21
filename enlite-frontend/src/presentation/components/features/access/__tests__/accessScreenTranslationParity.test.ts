/**
 * Rede de paridade da tela de Acessos e permissões (spec 024, 21/09): TUDO que essa tela desenha
 * — título de TELA, título de CONTAINER/seção, nome de RECURSO, nome de AÇÃO — precisa de rótulo
 * HUMANO em es e pt-BR. Sem isso o painel mostra ID cru / snake_case / `resource:action` pro
 * Marcel/Diego. Achados reais que motivaram este teste:
 *  - `recruitment.blocked`/`recruitment.health` mostravam o ID CRU (colisão de chave i18next —
 *    ver `ScreenTree.i18nKeys.test.ts`, que prova SÓ esse caso em detalhe);
 *  - `catalog_therapeutic_objectives`, `catalog_therapeutic_activities`,
 *    `catalog_therapeutic_segments`, `patient_therapeutic_project`, `patient_contract_value` e
 *    `anacare_hours` (recursos) e `write` (ação) não tinham entrada em
 *    `admin.access.group.cells.resource`/`.action` — apareciam SNAKE_CASE cru na grade.
 *
 * "Rótulo técnico" (pega qualquer um dos 3, igual ao pedido): chave AUSENTE (t() cai no
 * `defaultValue`, que é a própria chave crua) OU o valor resolvido é EXATAMENTE a chave OU o
 * valor "parece token" — sem espaço e com `_`/`:` (texto humano em es-AR/pt-BR sempre tem espaço
 * entre palavras; token de sistema não). `.` fica de fora do heurístico de token: abreviação
 * humana comum aqui termina em ponto (`Elim.`, `Expor.`, `Valid.`) e não pode contar como técnica
 * — a chave AUSENTE já é pega pela 1ª regra (o fallback é sempre a chave crua inteira).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { SCREEN_REGISTRY } from '@presentation/config/screenRegistry';
import permissionCatalog from '../../../../../test/fixtures/permission-catalog.json';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const LINGUAS = ['es', 'pt-BR'] as const;
type Lingua = (typeof LINGUAS)[number];

function pareceTecnico(valor: string, chaveCrua: string): boolean {
  if (!valor || !valor.trim()) return true;
  if (valor === chaveCrua) return true;
  if (!valor.includes(' ') && /[_:]/.test(valor)) return true;
  return false;
}

function tela(id: string, lng: Lingua): string {
  return i18n.t(`admin.access.screens.${id}.label`, { defaultValue: id, lng });
}

function container(sid: string, cid: string, lng: Lingua): string {
  return i18n.t(`admin.access.screens.${sid}.containers.${cid}`, { defaultValue: cid, lng });
}

function recurso(r: string, lng: Lingua): string {
  return i18n.t(`admin.access.group.cells.resource.${r}`, { defaultValue: r, lng });
}

function acao(a: string, lng: Lingua): string {
  return i18n.t(`admin.access.group.cells.action.${a}`, { defaultValue: a, lng });
}

const RECURSOS = [...new Set((permissionCatalog.cells as string[]).map((c) => c.split(':')[0]))].sort();
const ACOES = [...new Set((permissionCatalog.cells as string[]).map((c) => c.split(':')[1]))].sort();

describe('Tela de Acessos e permissões — paridade de tradução humana (es/pt-BR)', () => {
  it('a varredura tem massa de verdade — contagem zero é "não olhei", não sucesso', () => {
    expect(SCREEN_REGISTRY.length).toBeGreaterThan(20);
    expect(RECURSOS.length).toBeGreaterThan(20);
    expect(ACOES.length).toBeGreaterThan(5);
  });

  it.each(LINGUAS)('todo TÍTULO DE TELA do SCREEN_REGISTRY é humano, não ID cru (%s)', (lng) => {
    const crus = SCREEN_REGISTRY.map((s) => s.id).filter((id) => pareceTecnico(tela(id, lng), id));
    expect(crus, `IDs de tela sem rótulo humano em ${lng}: ${JSON.stringify(crus)}`).toEqual([]);
  });

  it.each(LINGUAS)('todo TÍTULO DE CONTAINER/seção do SCREEN_REGISTRY é humano (%s)', (lng) => {
    const crus: string[] = [];
    for (const s of SCREEN_REGISTRY) {
      for (const ct of s.containers ?? []) {
        if (pareceTecnico(container(s.id, ct.id, lng), ct.id)) crus.push(`${s.id}.containers.${ct.id}`);
      }
    }
    expect(crus, `containers sem rótulo humano em ${lng}: ${JSON.stringify(crus)}`).toEqual([]);
  });

  it.each(LINGUAS)('todo RECURSO do catálogo (permission-catalog.json) tem rótulo humano (%s)', (lng) => {
    const crus = RECURSOS.filter((r) => pareceTecnico(recurso(r, lng), r));
    expect(crus, `recursos sem rótulo humano em ${lng}: ${JSON.stringify(crus)}`).toEqual([]);
  });

  it.each(LINGUAS)('toda AÇÃO do catálogo (permission-catalog.json) tem rótulo humano (%s)', (lng) => {
    const crus = ACOES.filter((a) => pareceTecnico(acao(a, lng), a));
    expect(crus, `ações sem rótulo humano em ${lng}: ${JSON.stringify(crus)}`).toEqual([]);
  });
});
