import {
  derivarEstadoPaciente,
  MANUAIS,
  FUNIL,
  type EntradaDerivacao,
  type ServicoParaDerivar,
} from '../derivarEstadoPaciente';
import { PATIENT_STATUSES } from '../enums/PatientStatus';

// Um serviço de 8 h/semana com vacante viva, coberto em `cobertas` horas.
function servico(cobertas: number, contratadas: number | null = 8, temVacanteViva = true): ServicoParaDerivar {
  return { temVacanteViva, cobertas, contratadas };
}

function entrada(status: string | null, servicos: ServicoParaDerivar[], montado = true): EntradaDerivacao {
  return { status, montado, servicos };
}

const ZERO = [servico(0)];
const PARCIAL = [servico(4)];
const TOTAL = [servico(8)];

// Critério 2: as 6 transições que a derivação pode produzir (as 4 do catálogo + as 2 da 485).
const TRANSICOES_DERIVADAS = new Set([
  'SEARCHING->ACTIVE',
  'REPLACEMENT->ACTIVE',
  'ACTIVE->REPLACEMENT',
  'REPLACEMENT->SEARCHING',
  'SEARCHING->REPLACEMENT',
  'ACTIVE->SEARCHING',
]);

describe('derivarEstadoPaciente', () => {
  it('borda 1 — estado manual e as horas mudam: não mexe (ON_HOLD)', () => {
    for (const s of [ZERO, PARCIAL, TOTAL]) expect(derivarEstadoPaciente(entrada('ON_HOLD', s))).toBeNull();
  });

  it('borda 1 — estado manual e as horas mudam: não mexe (SUSPENDED)', () => {
    for (const s of [ZERO, PARCIAL, TOTAL]) expect(derivarEstadoPaciente(entrada('SUSPENDED', s))).toBeNull();
  });

  it('borda 1 — estado manual e as horas mudam: não mexe (ALTA)', () => {
    for (const s of [ZERO, PARCIAL, TOTAL]) expect(derivarEstadoPaciente(entrada('ALTA', s))).toBeNull();
  });

  it('borda 1 — estado manual e as horas mudam: não mexe (DISCHARGED)', () => {
    for (const s of [ZERO, PARCIAL, TOTAL]) expect(derivarEstadoPaciente(entrada('DISCHARGED', s))).toBeNull();
  });

  it('borda 2 — paciente em admisión não mexe', () => {
    for (const status of ['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION']) {
      for (const s of [ZERO, PARCIAL, TOTAL]) expect(derivarEstadoPaciente(entrada(status, s))).toBeNull();
    }
  });

  it('borda 3 — itinerário não montado não mexe', () => {
    // O caso dos ACTIVE da stage sem itinerário: 0 h NÃO vira SEARCHING.
    expect(derivarEstadoPaciente(entrada('ACTIVE', ZERO, false))).toBeNull();
    expect(derivarEstadoPaciente(entrada('SEARCHING', TOTAL, false))).toBeNull();
  });

  it('borda 4 — zero horas → SEARCHING', () => {
    expect(derivarEstadoPaciente(entrada('ACTIVE', ZERO))).toBe('SEARCHING');
    expect(derivarEstadoPaciente(entrada('REPLACEMENT', ZERO))).toBe('SEARCHING');
  });

  it('borda 5 — um serviço cheio e outro vazio → REPLACEMENT', () => {
    expect(derivarEstadoPaciente(entrada('SEARCHING', [servico(8), servico(0)]))).toBe('REPLACEMENT');
    expect(derivarEstadoPaciente(entrada('ACTIVE', [servico(8), servico(0)]))).toBe('REPLACEMENT');
  });

  it('borda 6 — todos cheios → ACTIVE', () => {
    expect(derivarEstadoPaciente(entrada('SEARCHING', [servico(8), servico(6, 6)]))).toBe('ACTIVE');
    expect(derivarEstadoPaciente(entrada('REPLACEMENT', TOTAL))).toBe('ACTIVE');
  });

  it('borda 7 — cheio + serviço sem vacante viva → ACTIVE (Q-D3)', () => {
    expect(derivarEstadoPaciente(entrada('SEARCHING', [servico(8), servico(0, 8, false)]))).toBe('ACTIVE');
    // o sem-vacante é ignorado mesmo com a régua nula
    expect(derivarEstadoPaciente(entrada('SEARCHING', [servico(8), servico(0, null, false)]))).toBe('ACTIVE');
  });

  it('borda 8 — seleção/Equipe/C sem alocação não muda horas: devolve o estado atual', () => {
    expect(derivarEstadoPaciente(entrada('SEARCHING', ZERO))).toBe('SEARCHING');
    expect(derivarEstadoPaciente(entrada('REPLACEMENT', PARCIAL))).toBe('REPLACEMENT');
    expect(derivarEstadoPaciente(entrada('ACTIVE', TOTAL))).toBe('ACTIVE');
  });

  it('borda 10 — arrastado à mão para derivável: a próxima mudança recalcula (Q-D6)', () => {
    expect(derivarEstadoPaciente(entrada('REPLACEMENT', [servico(8), servico(4, 4)]))).toBe('ACTIVE');
  });

  it('borda 11 — ausência e substituição datadas não são entrada: a mesma cobertura semanal dá o mesmo estado', () => {
    const base = entrada('ACTIVE', [servico(8), servico(4)]);
    // Campos a mais (ausência datada, com e sem substituto) não pertencem à entrada e não pesam.
    const comAusencia = {
      ...base,
      ausencias: [{ data: '2026-10-05', substituto: null }, { data: '2026-10-07', substituto: 'w-2' }],
      servicos: base.servicos.map((s) => ({ ...s, ausenciaSemSubstituto: true })),
    } as EntradaDerivacao;
    expect(derivarEstadoPaciente(comAusencia)).toBe(derivarEstadoPaciente(base));
    expect(derivarEstadoPaciente(comAusencia)).toBe('REPLACEMENT');
  });

  it('DISCONTINUED e status nulo → null', () => {
    expect(derivarEstadoPaciente(entrada('DISCONTINUED', ZERO))).toBeNull();
    expect(derivarEstadoPaciente(entrada(null, TOTAL))).toBeNull();
  });

  it('nenhum serviço com vacante viva → null', () => {
    expect(derivarEstadoPaciente(entrada('ACTIVE', []))).toBeNull();
    expect(derivarEstadoPaciente(entrada('ACTIVE', [servico(0, 8, false)]))).toBeNull();
  });

  it('serviço com vacante viva e contratadas nulo → null (Q-15.3)', () => {
    expect(derivarEstadoPaciente(entrada('ACTIVE', [servico(8), servico(0, null)]))).toBeNull();
  });

  it('horas acima do contratado → ACTIVE', () => {
    expect(derivarEstadoPaciente(entrada('SEARCHING', [servico(12)]))).toBe('ACTIVE');
  });

  it('as constantes: MANUAIS são os 4 manuais e FUNIL é o funil de admissão', () => {
    expect([...MANUAIS]).toEqual(['ON_HOLD', 'SUSPENDED', 'ALTA', 'DISCHARGED']);
    expect([...FUNIL]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION']);
  });

  it('exaustivo — toda mudança produzida está nas 6 transições do critério 2', () => {
    const fora: string[] = [];
    let mudancas = 0;
    for (const status of PATIENT_STATUSES) {
      for (const s of [ZERO, PARCIAL, TOTAL]) {
        for (const montado of [true, false]) {
          const alvo = derivarEstadoPaciente(entrada(status, s, montado));
          if (alvo === null || alvo === status) continue;
          mudancas += 1;
          const par = `${status}->${alvo}`;
          if (!TRANSICOES_DERIVADAS.has(par)) fora.push(par);
        }
      }
    }
    expect(fora).toEqual([]);
    expect(mudancas).toBe(6);
  });
});
