/**
 * Spec 051 (F1) — paridade das 4 células `patient_status:move_to_*`:
 * constante do domínio ↔ descrição em `CELL_DESCRIPTION` ↔ 2ª fonte do catálogo
 * (`cellsForaDeRota`) ↔ categoria do recurso ↔ consumidor (a função de decisão).
 *
 * Molde: `worker/__tests__/paridadeDeCelulas.test.ts`. Célula só em closure/constante NÃO entra
 * no catálogo (memória `celula-em-closure-nao-entra-no-catalogo`): sem a descrição, o sync
 * nunca a cria em `iam.permissions` e o PR-B negaria a troca para todos.
 */
// Só o barrel (régua moduleBoundary: ninguém alcança subdiretório de identity/permissions).
import { CELL_DESCRIPTION, RESOURCE_CATEGORY, cellsForaDeRota } from '@modules/identity/permissions';
import { CLINICAL_PATIENT_STATUSES } from '../enums/PatientStatus';
import { CELULA_DO_DESTINO, decidirTrocaForaDoFluxo } from '../trocaForaDoFluxo';

// F5 (estado-automatico-do-paciente): saíram `move_to_{searching,active,replacement}` — esses estados só saem do fluxo automático.
const QUATRO = [
  'patient_status:move_to_on_hold',
  'patient_status:move_to_suspended',
  'patient_status:move_to_alta',
  'patient_status:move_to_discharged',
];

describe('patient_status:move_to_* — paridade célula ↔ descrição ↔ catálogo ↔ consumidor', () => {
  it('controle positivo: 7 estados clínicos, 4 chaves esperadas (os 3 derivados não têm célula)', () => {
    expect(CLINICAL_PATIENT_STATUSES).toHaveLength(7);
    expect(QUATRO).toHaveLength(4);
  });

  it('o mapa destino→célula cobre exatamente os 4 destinos humanos e é exatamente a lista esperada', () => {
    expect(Object.keys(CELULA_DO_DESTINO).sort()).toEqual(['ALTA', 'DISCHARGED', 'ON_HOLD', 'SUSPENDED']);
    expect(Object.values(CELULA_DO_DESTINO).sort()).toEqual([...QUATRO].sort());
  });

  it.each(QUATRO)('%s tem descrição legível em CELL_DESCRIPTION', (chave) => {
    const d = CELL_DESCRIPTION[chave];
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(40);
  });

  it('a 2ª fonte do catálogo (cellsForaDeRota) devolve as 4 — é o que as faz existir em iam.permissions', () => {
    const fora = cellsForaDeRota([]).map((c) => `${c.resource}:${c.action}`);
    for (const chave of QUATRO) expect(fora).toContain(chave);
    expect(fora.filter((k) => k.startsWith('patient_status:'))).toHaveLength(4);
  });

  it('o recurso patient_status tem categoria declarada (não cai em "Não categorizado")', () => {
    expect(RESOURCE_CATEGORY.patient_status).toBe('Pacientes');
  });

  it('CELL_DESCRIPTION não tem nenhuma patient_status:* fora das 4', () => {
    const todas = Object.keys(CELL_DESCRIPTION).filter((k) => k.startsWith('patient_status:'));
    expect(todas.sort()).toEqual([...QUATRO].sort());
  });

  it.each(QUATRO)('consumidor: %s é a ÚNICA que libera o destino correspondente', (chave) => {
    const destino = (Object.entries(CELULA_DO_DESTINO).find(([, c]) => c === chave) as [string, string])[0];
    const origem = 'ACTIVE';
    const com = decidirTrocaForaDoFluxo({ de: origem, para: destino, naFsm: false, cells: [chave], changeSource: 'admin_panel' });
    const semOutras = decidirTrocaForaDoFluxo({
      de: origem, para: destino, naFsm: false, cells: QUATRO.filter((c) => c !== chave), changeSource: 'admin_panel',
    });
    expect(com.resultado).toBe('permitida_por_permissao');
    expect(semOutras).toEqual({ resultado: 'recusada_por_permissao', celulaFaltante: chave });
  });
});

describe('as 3 células dos estados derivados saíram do catálogo (F5)', () => {
  it.each(['searching', 'active', 'replacement'])('patient_status:move_to_%s não está em CELL_DESCRIPTION nem na 2ª fonte do catálogo', (d) => {
    const chave = `patient_status:move_to_${d}`;
    expect(Object.keys(CELL_DESCRIPTION)).not.toContain(chave);
    expect(cellsForaDeRota([]).map((c) => `${c.resource}:${c.action}`)).not.toContain(chave);
  });
});
