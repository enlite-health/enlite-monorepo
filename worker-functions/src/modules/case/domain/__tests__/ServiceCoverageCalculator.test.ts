import * as fs from 'fs';
import * as path from 'path';
import {
  computeServiceCoverage,
  type ServiceCoverageSlot,
  type ServiceWeeklyCoveredHours,
  type ItineraryAssignmentStatus,
} from '../ServiceCoverageCalculator';
// Import só de TIPO — o critério 8 proíbe tocar `AddressAvailabilityCalculator.ts`; o teste
// importa apenas o tipo (regra (ii)) e, à parte, a função pura (regra (iii)) para provar que as
// duas grandezas não podem ser confundidas nem por engano.
import type { AddressAvailability } from '../../application/AddressAvailabilityCalculator';
import {
  computeAddressAvailability,
  type ActiveVacancy,
} from '../../application/AddressAvailabilityCalculator';

// FATO-06 (2026-09-23a#FATO-06): seg-sex 08:00-20:00 (5 × 12h = 60h) com 1 alocação vigente cada;
// sáb-dom 08:00-20:00 (12h cada, 24h no total) SEM alocação. É esta fixture que o P15 sabota.
const FATO06_WEEKDAY_SLOTS: ServiceCoverageSlot[] = [1, 2, 3, 4, 5].map((weekday) => ({
  weekday,
  startTime: '08:00',
  endTime: '20:00',
  active: true,
  assignments: [{ validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' as const }],
}));

const FATO06_WEEKEND_SLOTS: ServiceCoverageSlot[] = [6, 0].map((weekday) => ({
  weekday,
  startTime: '08:00',
  endTime: '20:00',
  active: true,
  assignments: [],
}));

const FATO06_SLOTS: ServiceCoverageSlot[] = [...FATO06_WEEKDAY_SLOTS, ...FATO06_WEEKEND_SLOTS];

describe('computeServiceCoverage', () => {
  it('FATO-06: 120 contratadas / 60 cobertas', () => {
    const result = computeServiceCoverage({
      contractedHours: { weekly: 120, authorized: null },
      slots: FATO06_SLOTS,
      asOf: '2026-09-28',
    });
    expect(result.contratadas).toEqual({ weekly: 120, authorized: null });
    expect(result.cobertas).toBe(60);
  });

  it('sem alocação vigente: 0/120', () => {
    const result = computeServiceCoverage({
      contractedHours: { weekly: 120, authorized: null },
      slots: [
        { weekday: 1, startTime: '08:00', endTime: '20:00', active: true, assignments: [] },
      ],
      asOf: '2026-09-28',
    });
    expect(result.contratadas).toEqual({ weekly: 120, authorized: null });
    expect(result.cobertas).toBe(0);
  });

  describe('vigência (comparação de string YYYY-MM-DD, sem Date)', () => {
    const slotWith = (validFrom: string, validTo: string | null, status: ItineraryAssignmentStatus): ServiceCoverageSlot => ({
      weekday: 1,
      startTime: '08:00',
      endTime: '12:00',
      active: true,
      assignments: [{ validFrom, validTo, status }],
    });

    it('validFrom = asOf → conta', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-28', null, 'ACTIVE')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(4);
    });

    it('validTo = asOf → conta (inclusivo: o último dia trabalhado)', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-01', '2026-09-28', 'ACTIVE')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(4);
    });

    it('validTo = véspera de asOf → NÃO conta', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-01', '2026-09-27', 'ACTIVE')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(0);
    });

    it('validFrom = amanhã de asOf → NÃO conta', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-29', null, 'ACTIVE')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(0);
    });

    it('status ENDED (mesmo dentro da vigência) → NÃO conta', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-01', '2026-10-01', 'ENDED')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(0);
    });

    it('status CANCELLED (mesmo dentro da vigência) → NÃO conta', () => {
      const r = computeServiceCoverage({
        contractedHours: { weekly: null, authorized: null },
        slots: [slotWith('2026-09-01', '2026-10-01', 'CANCELLED')],
        asOf: '2026-09-28',
      });
      expect(r.cobertas).toBe(0);
    });
  });

  it('P2 — 2 alocações vigentes no MESMO slot contam as horas do slot uma vez só', () => {
    const r = computeServiceCoverage({
      contractedHours: { weekly: null, authorized: null },
      slots: [
        {
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
          active: true,
          assignments: [
            { validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
            { validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' },
          ],
        },
      ],
      asOf: '2026-09-28',
    });
    expect(r.cobertas).toBe(4);
  });

  it('slot active:false com alocação vigente pendurada → NÃO conta, mas aparece em slots[] com covered:false', () => {
    const r = computeServiceCoverage({
      contractedHours: { weekly: null, authorized: null },
      slots: [
        {
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
          active: false,
          assignments: [{ validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
        },
      ],
      asOf: '2026-09-28',
    });
    expect(r.cobertas).toBe(0);
    expect(r.slots).toHaveLength(1);
    expect(r.slots[0]!.covered).toBe(false);
  });

  it('frações: 08:00-08:20 × 3 slots vigentes → 1 (exato, sem deriva de ponto flutuante)', () => {
    const slot = (weekday: number): ServiceCoverageSlot => ({
      weekday,
      startTime: '08:00',
      endTime: '08:20',
      active: true,
      assignments: [{ validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
    });
    const r = computeServiceCoverage({
      contractedHours: { weekly: null, authorized: null },
      slots: [slot(1), slot(2), slot(3)],
      asOf: '2026-09-28',
    });
    expect(r.cobertas).toBe(1);
  });

  it('contratadas com os dois nulos → { weekly: null, authorized: null } e a conta roda', () => {
    const r = computeServiceCoverage({
      contractedHours: { weekly: null, authorized: null },
      slots: [
        {
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
          active: true,
          assignments: [{ validFrom: '2026-09-01', validTo: null, status: 'ACTIVE' }],
        },
      ],
      asOf: '2026-09-28',
    });
    expect(r.contratadas).toEqual({ weekly: null, authorized: null });
    expect(r.cobertas).toBe(4);
  });
});

// ── DX-7.4 — a régua tripla de "grandezas diferentes" (Plano B) ────────────────────────────────
describe('DX-7.4 — ServiceCoverageCalculator não se confunde com AddressAvailabilityCalculator', () => {
  it('(i) fonte: o arquivo de produção não cita AddressAvailabilityCalculator/computeAddressAvailability/contracted_service_providers — só código', () => {
    const filePath = path.join(__dirname, '../ServiceCoverageCalculator.ts');
    const source = fs.readFileSync(filePath, 'utf8');
    const lines = source.split('\n');

    const forbidden = [
      /from\s+['"][^'"]*AddressAvailabilityCalculator['"]/,
      /computeAddressAvailability\s*\(/,
      /contracted_service_providers/,
    ];
    for (const line of lines) {
      for (const pattern of forbidden) {
        expect(pattern.test(line)).toBe(false);
      }
    }

    // Controle positivo: o critério 11 (a fonte é o itinerário, não a alocação antiga) precisa
    // estar citado em algum lugar do arquivo — se este teste passasse com o arquivo vazio, a
    // régua (i) não provaria nada.
    expect(/patient_itinerary_assignment/.test(source)).toBe(true);
  });

  it('(ii) tipo: ocupação por endereço (number cru) não é atribuível a ServiceWeeklyCoveredHours', () => {
    const addressAvailability: AddressAvailability = {
      totalCoveredHours: 40,
      maxHours: 168,
      isFull: false,
      perDay: [],
      activeVacanciesCount: 1,
      hasUnknownSchedule: false,
    };
    // @ts-expect-error — ocupação por endereço (number cru) não é ServiceWeeklyCoveredHours
    const x: ServiceWeeklyCoveredHours = addressAvailability.totalCoveredHours;
    expect(x).toBe(40); // só para o `x` não ficar "unused" — o teste é a linha de cima
  });

  it('(iii) valor: o MESMO cenário (1 vaga/serviço, 40h de schedule, 0 alocação) dá números diferentes nas duas funções — ocupação de slot × cobertura por pessoa (F14)', () => {
    const vacancy: ActiveVacancy = {
      id: 'vacancy-1',
      patient_address_id: 'address-1',
      status: 'SEARCHING',
      schedule: [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '16:00' })),
    };
    const availability = computeAddressAvailability('address-1', [vacancy]);
    expect(availability.totalCoveredHours).toBe(40);

    const coverage = computeServiceCoverage({
      contractedHours: { weekly: 40, authorized: null },
      slots: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        startTime: '08:00',
        endTime: '16:00',
        active: true,
        assignments: [], // 0 alocação: a vaga existe (ocupa o endereço), ninguém está alocado ainda
      })),
      asOf: '2026-09-28',
    });
    expect(coverage.cobertas).toBe(0);

    // Esperado: `totalCoveredHours` mede a VAGA ocupando o endereço; `cobertas` mede QUANTAS
    // horas têm ALGUÉM alocado. Uma vaga aberta sem prestador ocupa o endereço (40) e não cobre
    // ninguém (0) — são a mesma janela de horário, duas grandezas diferentes.
    expect(availability.totalCoveredHours).not.toBe(coverage.cobertas as number);
  });
});
