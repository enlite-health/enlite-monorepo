/** Parte pura do CLI da linha de corte (spec 084 F3): flags, mapa do grupo c e relatório só com IDs/contagens. */
import {
  countByGroup, formatGroupLine, formatMergeLine, formatTotals, parseCutoffArgs, parseCutoffMap, planGroupC,
} from '../linha-de-corte-vagas-lib';
import type { ClassifiedVacancy } from '../../src/modules/case/infrastructure/LegacyVacancyCutoffRepository';
import { FUSION_COUNTED_TABLES, type FusionCounts } from '../../src/modules/case/infrastructure/DraftFusionRepository';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const v = (n: number, group: ClassifiedVacancy['group'], caso: number | null, patient: string | null = U(900 + n)): ClassifiedVacancy => ({
  vacancyId: U(n), caseNumber: caso, patientId: patient, status: 'SEARCHING', group,
});

describe('parseCutoffArgs', () => {
  it('exatamente um de --dry-run / --apply (sem modo, recusa: nunca grava por omissão)', () => {
    expect(parseCutoffArgs(['--dry-run'])).toEqual({ mode: 'dry-run', mapCsv: null, pauseTalentum: false });
    expect(parseCutoffArgs(['--apply', '--map', 'c.csv'])).toEqual({ mode: 'apply', mapCsv: 'c.csv', pauseTalentum: false });
    expect(() => parseCutoffArgs([])).toThrow('exatamente um');
    expect(() => parseCutoffArgs(['--dry-run', '--apply'])).toThrow('exatamente um');
  });
  it('--pause-talentum só com --apply: o ensaio NUNCA chama o Talentum', () => {
    expect(parseCutoffArgs(['--apply', '--pause-talentum']).pauseTalentum).toBe(true);
    expect(() => parseCutoffArgs(['--dry-run', '--pause-talentum'])).toThrow('--pause-talentum só vale com --apply');
  });
  it('--map sem arquivo → recusa', () => {
    expect(() => parseCutoffArgs(['--dry-run', '--map'])).toThrow('faltou o arquivo');
    expect(() => parseCutoffArgs(['--dry-run', '--map', '--apply'])).toThrow();
  });
});

describe('parseCutoffMap', () => {
  it('lê antiga → destino', () => {
    const m = parseCutoffMap(`legacy_vacancy_id,target_vacancy_id\n${U(1)},${U(2)}\n${U(3)},${U(4)}\n`);
    expect([...m]).toEqual([[U(1), U(2)], [U(3), U(4)]]);
  });
  it('erros: vazio, sem coluna, não-UUID, antiga repetida', () => {
    expect(() => parseCutoffMap('')).toThrow('vazio');
    expect(() => parseCutoffMap('a,b\n1,2')).toThrow('sem coluna');
    expect(() => parseCutoffMap(`legacy_vacancy_id,target_vacancy_id\nxx,${U(2)}`)).toThrow('não é UUID'.replace('não é UUID', 'UUID'));
    expect(() => parseCutoffMap(`legacy_vacancy_id,target_vacancy_id\n${U(1)},${U(2)}\n${U(1)},${U(3)}`)).toThrow('repetida');
  });
});

describe('planGroupC — caso sem destino NÃO é aplicado (nunca por chute)', () => {
  it('só o par com destino no mapa entra; o resto fica em semDestino', () => {
    const grupo = [v(1, 'c', 817), v(2, 'c', 494), v(3, 'c', 603)];
    const plan = planGroupC(grupo, new Map([[U(1), U(50)]]));
    expect(plan.pairs).toEqual([{ patientId: U(901), legacyId: U(1), targetId: U(50) }]);
    expect(plan.semDestino.map((x) => x.caseNumber)).toEqual([494, 603]);
  });
  it('mapa vazio → ninguém é tocado', () => {
    expect(planGroupC([v(1, 'c', 817)], new Map()).pairs).toEqual([]);
  });
});

describe('relatório', () => {
  it('countByGroup/formatGroupLine: contagens e números de caso, nada de nome', () => {
    const rows = [v(1, 'a', 10), v(2, 'a', 10), v(3, 'x', null), v(4, 'revisao', 7)];
    const out = countByGroup(rows);
    expect(out.find((c) => c.group === 'a')).toEqual({ group: 'a', vacancies: 2, cases: [10] });
    expect(formatGroupLine(out.find((c) => c.group === 'x')!)).toBe('grupo=x vagas=1 casos=[-]');
  });

  it('formatMergeLine: antes→depois por tabela, bloqueados e a baixa; sem PII', () => {
    const z = (): FusionCounts => Object.fromEntries(FUSION_COUNTED_TABLES.map((t) => [t, { draft: 0, official: 0 }])) as FusionCounts;
    const before = z(); before.worker_job_applications = { draft: 2, official: 1 };
    const after = z(); after.worker_job_applications = { draft: 0, official: 3 };
    const line = formatMergeLine(
      { patientId: U(9), legacyId: U(1), targetId: U(2) },
      { status: 'MERGED', committed: false, result: { before, after, merged: {}, collisionStages: { PRE_SCREENING: 1 }, addressAligned: false, vigentesNoServico: 0, gateWaived: [], blockedMoved: 1, blockedLeft: 0, blockedBefore: 1, blockedAfter: 0 } },
    );
    expect(line).toContain('FUNDIDO+BAIXADA');
    expect(line).toContain('worker_job_applications=2+1->0+3');
    expect(line).toContain('bloqueados=1->0');
    expect(line).not.toMatch(/@|phone|nome/i);
  });

  it('formatTotals: avisa se a contagem de vagas vivas divergir (nunca apaga)', () => {
    const base = { mode: 'dry-run' as const, abertasSemServicoAntes: 60, abertasSemServicoDepois: 2, vagasVivasAntes: 360, vagasVivasDepois: 360, baixadas: 58, mergeadas: 8, semDestino: 2, emEspera: 1, revisao: 30, talentumComProjeto: 59 };
    expect(formatTotals(base).join('\n')).toContain('nenhuma apagada: OK');
    expect(formatTotals({ ...base, vagasVivasDepois: 359 }).join('\n')).toContain('DIVERGE');
  });
});
