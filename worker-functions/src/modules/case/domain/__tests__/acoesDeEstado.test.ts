/**
 * acoesDeEstado (F3, D5/D9, design §1.1/§8): a tabela das 6 ações. O cliente não escolhe destino de retomar/reativar; a origem
 * de cada ação é a da tabela; retomar só de ON_HOLD/SUSPENDED e reativar só de DISCHARGED.
 */
import { ACOES, ACAO_NAMES, acaoDisponivelDe, exigenciasDe, type Acao } from '../acoesDeEstado';
import type { EntradaDerivacao } from '../derivarEstadoPaciente';
import { CLINICAL_PATIENT_STATUSES } from '../enums/PatientStatus';
import { POLITICA_POR_ORIGEM } from '../enums/PatientChangeSource';

const horas = (status: string, servicos: EntradaDerivacao['servicos'], montado = true): EntradaDerivacao => ({ status, montado, servicos });
const COBRE_TUDO = [{ temVacanteViva: true, cobertas: 8, total: 8 }];

describe('acoesDeEstado', () => {
  it('tem exatamente as 6 ações, e toda origem da tabela existe na política por origem', () => {
    expect([...ACAO_NAMES].sort()).toEqual(['dar_alta', 'dar_baja', 'pausar', 'reativar', 'retomar', 'suspender']);
    for (const a of ACAO_NAMES) expect(POLITICA_POR_ORIGEM).toHaveProperty(ACOES[a].origem);
  });

  it.each([
    ['pausar', 'ON_HOLD'],
    ['suspender', 'SUSPENDED'],
    ['dar_alta', 'ALTA'],
    ['dar_baja', 'DISCHARGED'],
  ] as Array<[Acao, string]>)('%s → destino fixo %s, origem admin_panel (as células e a FSM de hoje valem)', (acao, destino) => {
    expect(ACOES[acao].destino({ horas: horas('ACTIVE', COBRE_TUDO) })).toBe(destino);
    expect(ACOES[acao].origem).toBe('admin_panel');
  });

  it('pausar exige o motivo; as outras 3 do painel não exigem nada por si', () => {
    expect(ACOES.pausar.exige).toEqual(['onHoldReason']);
    for (const a of ['suspender', 'dar_alta', 'dar_baja'] as Acao[]) expect(ACOES[a].exige).toEqual([]);
  });

  it('retomar e reativar usam a origem `resume` e o destino sai das horas (cobre tudo → ACTIVE; sem itinerário → SEARCHING)', () => {
    for (const a of ['retomar', 'reativar'] as Acao[]) {
      expect(ACOES[a].origem).toBe('resume');
      expect(ACOES[a].destino({ horas: horas('ON_HOLD', COBRE_TUDO) })).toBe('ACTIVE');
      expect(ACOES[a].destino({ horas: horas('ON_HOLD', [], false) })).toBe('SEARCHING');
    }
  });

  it('retomar só existe de ON_HOLD e SUSPENDED; reativar só de DISCHARGED (D9) — o resto recusa', () => {
    const de = (a: Acao) => CLINICAL_PATIENT_STATUSES.filter((s) => acaoDisponivelDe(a, s));
    expect(de('retomar')).toEqual(['ON_HOLD', 'SUSPENDED']);
    expect(de('reativar')).toEqual(['DISCHARGED']);
    expect(acaoDisponivelDe('retomar', 'ACTIVE')).toBe(false);
    expect(acaoDisponivelDe('reativar', 'ACTIVE')).toBe(false);
    expect(acaoDisponivelDe('reativar', null)).toBe(false);
  });

  it('as 4 ações do painel não existem a partir do próprio destino, nem do funil de admissão', () => {
    expect(acaoDisponivelDe('pausar', 'ON_HOLD')).toBe(false);
    expect(acaoDisponivelDe('dar_baja', 'DISCHARGED')).toBe(false);
    expect(acaoDisponivelDe('pausar', 'ADMISSION')).toBe(false);
    expect(acaoDisponivelDe('pausar', 'ACTIVE')).toBe(true);
  });

  it('sair de SUSPENDED acrescenta o motivo de saída a qualquer ação; fora dele, só o que a tabela manda', () => {
    expect(exigenciasDe('retomar', 'SUSPENDED')).toEqual(['suspensionExitReason']);
    expect(exigenciasDe('dar_baja', 'SUSPENDED')).toEqual(['suspensionExitReason']);
    expect(exigenciasDe('pausar', 'SUSPENDED')).toEqual(['onHoldReason', 'suspensionExitReason']);
    expect(exigenciasDe('retomar', 'ON_HOLD')).toEqual([]);
    expect(exigenciasDe('pausar', 'ACTIVE')).toEqual(['onHoldReason']);
  });
});
