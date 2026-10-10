/**
 * Spec 051 (F1) — paridade das 7 células `patient_status:move_to_*`:
 * constante do domínio ↔ descrição em `CELL_DESCRIPTION` ↔ 2ª fonte do catálogo
 * (`cellsForaDeRota`) ↔ categoria do recurso ↔ consumidor (a função de decisão).
 *
 * Molde: `worker/__tests__/paridadeDeCelulas.test.ts`. Célula só em closure/constante NÃO entra
 * no catálogo (memória `celula-em-closure-nao-entra-no-catalogo`): sem a descrição, o sync
 * nunca a cria em `iam.permissions` e o PR-B negaria a troca para todos.
 */
import {
  CELL_DESCRIPTION,
  RESOURCE_CATEGORY,
} from '../../../identity/permissions/domain/PermissionCell';
import { cellsForaDeRota } from '../../../identity/permissions/infrastructure/catalog/scanExpressRouter';
import { CLINICAL_PATIENT_STATUSES } from '../enums/PatientStatus';
import { CELULA_DO_DESTINO, decidirTrocaForaDoFluxo } from '../trocaForaDoFluxo';

const SETE = [
  'patient_status:move_to_searching',
  'patient_status:move_to_active',
  'patient_status:move_to_replacement',
  'patient_status:move_to_on_hold',
  'patient_status:move_to_suspended',
  'patient_status:move_to_alta',
  'patient_status:move_to_discharged',
];

describe('patient_status:move_to_* — paridade célula ↔ descrição ↔ catálogo ↔ consumidor', () => {
  it('controle positivo: são exatamente 7 destinos clínicos e 7 chaves esperadas', () => {
    expect(CLINICAL_PATIENT_STATUSES).toHaveLength(7);
    expect(SETE).toHaveLength(7);
  });

  it('o mapa destino→célula cobre os 7 estados clínicos e é exatamente a lista esperada', () => {
    expect(Object.keys(CELULA_DO_DESTINO).sort()).toEqual([...CLINICAL_PATIENT_STATUSES].sort());
    expect(Object.values(CELULA_DO_DESTINO).sort()).toEqual([...SETE].sort());
  });

  it.each(SETE)('%s tem descrição legível em CELL_DESCRIPTION', (chave) => {
    const d = CELL_DESCRIPTION[chave];
    expect(typeof d).toBe('string');
    expect(d.length).toBeGreaterThan(40);
  });

  it('a 2ª fonte do catálogo (cellsForaDeRota) devolve as 7 — é o que as faz existir em iam.permissions', () => {
    const fora = cellsForaDeRota([]).map((c) => `${c.resource}:${c.action}`);
    for (const chave of SETE) expect(fora).toContain(chave);
    expect(fora.filter((k) => k.startsWith('patient_status:'))).toHaveLength(7);
  });

  it('o recurso patient_status tem categoria declarada (não cai em "Não categorizado")', () => {
    expect(RESOURCE_CATEGORY.patient_status).toBe('Pacientes');
  });

  it('CELL_DESCRIPTION não tem nenhuma patient_status:* fora das 7', () => {
    const todas = Object.keys(CELL_DESCRIPTION).filter((k) => k.startsWith('patient_status:'));
    expect(todas.sort()).toEqual([...SETE].sort());
  });

  it.each(SETE)('consumidor: %s é a ÚNICA que libera o destino correspondente', (chave) => {
    const destino = (Object.entries(CELULA_DO_DESTINO).find(([, c]) => c === chave) as [string, string])[0];
    const origem = destino === 'ACTIVE' ? 'SEARCHING' : 'ACTIVE';
    const com = decidirTrocaForaDoFluxo({ de: origem, para: destino, naFsm: false, cells: [chave], changeSource: 'admin_panel' });
    const semOutras = decidirTrocaForaDoFluxo({
      de: origem, para: destino, naFsm: false, cells: SETE.filter((c) => c !== chave), changeSource: 'admin_panel',
    });
    expect(com.resultado).toBe('permitida_por_permissao');
    expect(semOutras).toEqual({ resultado: 'recusada_por_permissao', celulaFaltante: chave });
  });
});
