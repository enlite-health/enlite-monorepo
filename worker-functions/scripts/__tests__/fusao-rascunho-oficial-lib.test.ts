/** Parte pura do CLI da fusão rascunho→oficial: flags, mapa CSV (só PAR_UNICO) e relatório só com IDs/contagens. */
import {
  formatPatientLine,
  formatTotals,
  parseFusionArgs,
  parseFusionCsv,
  splitCsvLine,
  totalize,
  type PatientLine,
} from '../fusao-rascunho-oficial-lib';
import { FUSION_COUNTED_TABLES, type FusionCounts } from '../../src/modules/case/infrastructure/DraftFusionRepository';

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const HEADER = 'patient_id,case_number,rascunho_id,contracted_service_id,ativa_id,classe,motivo';

describe('parseFusionArgs', () => {
  it('--dry-run / --apply com --csv', () => {
    expect(parseFusionArgs(['--dry-run', '--csv', 'm.csv'])).toEqual({ mode: 'dry-run', csv: 'm.csv' });
    expect(parseFusionArgs(['--csv', 'm.csv', '--apply'])).toEqual({ mode: 'apply', csv: 'm.csv' });
  });
  it('sem modo ou com os dois → recusa (nunca grava por omissão)', () => {
    expect(() => parseFusionArgs(['--csv', 'm.csv'])).toThrow('exatamente um');
    expect(() => parseFusionArgs(['--dry-run', '--apply', '--csv', 'm.csv'])).toThrow('exatamente um');
  });
  it('sem --csv, ou --csv seguido de outra flag → recusa', () => {
    expect(() => parseFusionArgs(['--dry-run'])).toThrow('--csv');
    expect(() => parseFusionArgs(['--dry-run', '--csv'])).toThrow('--csv');
    expect(() => parseFusionArgs(['--csv', '--apply'])).toThrow('--csv');
  });
});

describe('splitCsvLine', () => {
  it('aspas, vírgula dentro de aspas e "" escapado', () => {
    expect(splitCsvLine('a,"b,c","d""e",')).toEqual(['a', 'b,c', 'd"e', '']);
  });
});

describe('parseFusionCsv', () => {
  it('só PAR_UNICO entra; aceita CRLF e linha vazia', () => {
    const csv = [
      HEADER,
      `${U(1)},614,${U(2)},${U(3)},${U(4)},PAR_UNICO,""`,
      `${U(5)},615,${U(6)},${U(7)},${U(8)},AMBIGUO,"ativas_abertas>1"`,
      '',
    ].join('\r\n');
    expect(parseFusionCsv(csv)).toEqual([{ patientId: U(1), draftId: U(2), officialId: U(4), serviceId: U(3) }]);
  });
  it('mapa vazio → erro', () => {
    expect(() => parseFusionCsv('\n')).toThrow('mapa vazio');
  });
  it('coluna obrigatória faltando → erro nomeando a coluna', () => {
    expect(() => parseFusionCsv('patient_id,classe\n')).toThrow('mapa sem coluna: rascunho_id, ativa_id, contracted_service_id');
  });
  it('id que não é UUID numa linha PAR_UNICO → erro com a linha', () => {
    const csv = `${HEADER}\n${U(1)},614,nao-uuid,${U(3)},${U(4)},PAR_UNICO,`;
    expect(() => parseFusionCsv(csv)).toThrow('linha 2: draftId não é UUID');
  });
});

const counts = (d: number, o: number): FusionCounts =>
  Object.fromEntries(FUSION_COUNTED_TABLES.map((t) => [t, { draft: d, official: o }])) as FusionCounts;
const pair = (n: number) => ({ patientId: `p${n}`, draftId: `d${n}`, officialId: `o${n}`, serviceId: `s${n}` });

const LINES: PatientLine[] = [
  {
    pair: pair(1),
    outcome: {
      status: 'FUSED',
      committed: true,
      result: {
        before: counts(2, 3),
        after: counts(0, 4),
        merged: { worker_job_applications: 1 },
        collisionStages: { QUALIFIED: 1 },
        addressAligned: true,
        vigentesNoServico: 2,
        gateWaived: ['SERVICE_PAYMENT_DAY'],
      },
    },
  },
  {
    pair: pair(2),
    outcome: {
      status: 'FUSED',
      committed: false,
      result: { before: counts(0, 1), after: counts(0, 1), merged: {}, collisionStages: {}, addressAligned: false, vigentesNoServico: 0, gateWaived: [] },
    },
  },
  { pair: pair(3), outcome: { status: 'SKIPPED', reason: 'LINK_BLOCKED:SERVICE_PAYMENT_DAY' } },
  { pair: pair(4), outcome: { status: 'SKIPPED', reason: 'LINK_BLOCKED:SERVICE_REQUIRED_SEX' } },
  { pair: pair(5), outcome: { status: 'CONFLICT', conflicts: [{ workerId: 'w9', officialStage: 'SELECTED', draftStage: 'REJECTED' }] } },
  { pair: pair(6), error: 'Error: boom' },
];

describe('formatPatientLine', () => {
  it('uma linha por desfecho, só ids/etapas/contagens', () => {
    expect(LINES.map(formatPatientLine)).toEqual([
      `paciente=p1 rascunho=d1 oficial=o1 FUNDIDO ${FUSION_COUNTED_TABLES.map((t) => `${t}=2+3->0+4`).join(' ')} colisoes=[QUALIFIED:1] endereco_alinhado=true vigentes=2 sem_portao=[SERVICE_PAYMENT_DAY]`,
      `paciente=p2 rascunho=d2 oficial=o2 FUNDIDO(rollback) ${FUSION_COUNTED_TABLES.map((t) => `${t}=0+1->0+1`).join(' ')} colisoes=[] endereco_alinhado=false vigentes=0 sem_portao=[]`,
      'paciente=p3 rascunho=d3 oficial=o3 PULADO LINK_BLOCKED:SERVICE_PAYMENT_DAY',
      'paciente=p4 rascunho=d4 oficial=o4 PULADO LINK_BLOCKED:SERVICE_REQUIRED_SEX',
      'paciente=p5 rascunho=d5 oficial=o5 CONFLITO w9:SELECTED<>REJECTED',
      'paciente=p6 rascunho=d6 oficial=o6 ERRO Error: boom',
    ]);
  });
});

describe('totalize + formatTotals', () => {
  it('soma antes/depois/fundidas só dos fundidos; agrupa pulos pelo motivo; lista conflitos e erros', () => {
    const t = totalize(LINES);
    expect(t.fused).toBe(2);
    expect(t.skipped).toEqual({ LINK_BLOCKED: 2 });
    expect(t.conflicts).toEqual(['p5']);
    expect(t.errors).toEqual(['p6']);
    expect(t.tables.worker_job_applications).toEqual({ before: 6, after: 5, merged: 1 });
    expect(t.tables.encuadres).toEqual({ before: 6, after: 5, merged: 0 });
    expect(t.collisionStages).toEqual({ QUALIFIED: 1 });
    const out = formatTotals(t, 'apply');
    expect(out[0]).toBe('TOTAL modo=apply fundidos=2 pulados=2 conflitos=1 erros=1');
    expect(out).toContain('worker_job_applications | 6 | 5 | 1');
    expect(out).toContain('conflitos_pacientes p5');
    expect(out).toContain('colisoes_etapa_final {"QUALIFIED":1}');
    expect(out[out.length - 1]).toBe('fundidos_sem_portao_campos_vazios 1 p1');
  });
  it('sem conflito nem erro → "-"', () => {
    const out = formatTotals(totalize([]), 'dry-run');
    expect(out).toContain('conflitos_pacientes -');
    expect(out).toContain('erros_pacientes -');
    expect(out).toContain('fundidos_sem_portao_campos_vazios 0 -');
  });
});
