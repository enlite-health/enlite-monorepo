jest.mock('@shared/logging', () => {
  const actual = jest.requireActual('@shared/logging');
  return { ...actual, reportError: jest.fn() };
});

// D350/F2: `AnaCareSessionClient`/`AnaCareShiftsSourceReal` MOCKADOS — este teste prova só a
// SELEÇÃO do adapter pela env (fail-closed), não a sessão HTTP de verdade (isso é o próprio
// teste de `AnaCareSessionClient`/e2e).
jest.mock('@modules/integration', () => ({
  AnaCareSessionClient: jest.fn(),
  AnaCareShiftsSourceReal: jest.fn(),
}));

import { FakeAnaCareShiftsSource, createAnaCareShiftsSource, ANACARE_HOURS_SOURCE_ENV } from '../FakeAnaCareShiftsSource';
import { AnaCareSessionClient, AnaCareShiftsSourceReal } from '@modules/integration';
import { reportError } from '@shared/logging';

describe('FakeAnaCareShiftsSource', () => {
  describe('generateMonth', () => {
    it('gera 100 turnos sintéticos (10 pacientes x 2 prestadores x 5 turnos)', () => {
      expect(FakeAnaCareShiftsSource.generateMonth('2026-09')).toHaveLength(100);
    });

    it('respeita a proporção medida F16 (46 app / 35 web_admin / 19 sem check-in)', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const app = shifts.filter((s) => s.checkinSource === 'app').length;
      const webAdmin = shifts.filter((s) => s.checkinSource === 'web_admin').length;
      const semCheckin = shifts.filter((s) => s.checkinSource === null).length;
      expect({ app, webAdmin, semCheckin }).toEqual({ app: 46, webAdmin: 35, semCheckin: 19 });
    });

    it('é determinístico — o mesmo mês gera os mesmos ids na mesma ordem', () => {
      const a = FakeAnaCareShiftsSource.generateMonth('2026-09').map((s) => s.sourceShiftId);
      const b = FakeAnaCareShiftsSource.generateMonth('2026-09').map((s) => s.sourceShiftId);
      expect(a).toEqual(b);
    });

    it('sourceShiftId é único por turno', () => {
      const ids = FakeAnaCareShiftsSource.generateMonth('2026-09').map((s) => s.sourceShiftId);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('turno sem check-in (checkinSource null) tem actualStart/actualEnd null e isFinalized false', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const semCheckin = shifts.filter((s) => s.checkinSource === null);
      expect(semCheckin.length).toBeGreaterThan(0);
      for (const s of semCheckin) {
        expect(s.actualStart).toBeNull();
        expect(s.actualEnd).toBeNull();
        expect(s.isFinalized).toBe(false);
      }
    });

    it('turno com check-in mas AINDA sem checkout (em andamento) tem actualEnd null e isFinalized false — medido 17/09: 7/30 turnos não finalizados têm check-in', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const emAndamento = shifts.filter((s) => s.checkinSource !== null && s.actualEnd === null);
      expect(emAndamento.length).toBeGreaterThan(0);
      for (const s of emAndamento) {
        expect(s.actualStart).not.toBeNull();
        expect(s.isFinalized).toBe(false);
      }
    });

    it('turno finalizado tem actualStart/actualEnd preenchidos, datas dentro do mês, e ao menos um caso com hora real MENOR que a prevista (achado 2 do defeito medido 17/09)', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const finalizados = shifts.filter((s) => s.isFinalized);
      expect(finalizados.length).toBeGreaterThan(0);
      for (const s of finalizados) {
        expect(typeof s.actualStart).toBe('string');
        expect(typeof s.actualEnd).toBe('string');
        expect(s.date.startsWith('2026-09')).toBe(true);
      }
      const comRealMenorQuePrevisto = finalizados.filter((s) => {
        const previsto = (new Date(s.scheduledEnd).getTime() - new Date(s.scheduledStart).getTime()) / 3_600_000;
        const real = (new Date(s.actualEnd as string).getTime() - new Date(s.actualStart as string).getTime()) / 3_600_000;
        return real < previsto;
      });
      expect(comRealMenorQuePrevisto.length).toBeGreaterThan(0);
    });

    it('mês de 30 dias (setembro) não gera dia 31', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      for (const s of shifts) expect(s.date <= '2026-09-30').toBe(true);
    });

    it('fevereiro (28 dias em 2026, não bissexto) não gera dia 29', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-02');
      for (const s of shifts) expect(s.date <= '2026-02-28').toBe(true);
    });
  });

  describe('listShifts', () => {
    it('sem patientId devolve todos os turnos do mês', async () => {
      const source = new FakeAnaCareShiftsSource();
      const shifts = await source.listShifts({ month: '2026-09' });
      expect(shifts).toHaveLength(100);
    });

    it('com patientId filtra só os turnos daquele paciente sintético', async () => {
      const source = new FakeAnaCareShiftsSource();
      const shifts = await source.listShifts({ month: '2026-09', patientId: 'AC-PAT-0' });
      expect(shifts.length).toBeGreaterThan(0);
      for (const s of shifts) expect(s.anaCarePatientId).toBe('AC-PAT-0');
    });

    it('patientId desconhecido devolve lista vazia', async () => {
      const source = new FakeAnaCareShiftsSource();
      const shifts = await source.listShifts({ month: '2026-09', patientId: 'AC-PAT-999' });
      expect(shifts).toEqual([]);
    });
  });

  describe('getShift', () => {
    it('encontra o turno pelo id sintético (extrai o mês do próprio id)', async () => {
      const source = new FakeAnaCareShiftsSource();
      const shift = await source.getShift('FAKE-2026-09-0-0-0');
      expect(shift?.sourceShiftId).toBe('FAKE-2026-09-0-0-0');
    });

    it('id em formato desconhecido devolve null', async () => {
      const source = new FakeAnaCareShiftsSource();
      expect(await source.getShift('nao-e-um-id-fake')).toBeNull();
    });

    it('id no formato certo mas turno inexistente devolve null', async () => {
      const source = new FakeAnaCareShiftsSource();
      expect(await source.getShift('FAKE-2026-09-99-99-99')).toBeNull();
    });
  });

  describe('getRetratoStatus', () => {
    it('fase 1: sempre fresco — nenhum job real de sync/disjuntor existe neste adapter falso', async () => {
      const source = new FakeAnaCareShiftsSource();
      expect(await source.getRetratoStatus()).toEqual({ stale: false, circuitBreakerOpen: false });
    });
  });
});

describe('createAnaCareShiftsSource — fail-closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it(`com ${ANACARE_HOURS_SOURCE_ENV}=fake devolve o adapter falso`, () => {
    const source = createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'fake' } as NodeJS.ProcessEnv);
    expect(source).toBeInstanceOf(FakeAnaCareShiftsSource);
  });

  it('sem a env devolve null (fail-closed)', () => {
    expect(createAnaCareShiftsSource({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('com valor desconhecido (nem fake nem real) devolve null (nunca serve dado falso por omissão/typo)', () => {
    expect(createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'lixo' } as NodeJS.ProcessEnv)).toBeNull();
    expect(AnaCareSessionClient).not.toHaveBeenCalled();
  });

  // D350/F2: `real` liga o cliente de sessão da F2 — construído aqui, não escolhido no vazio.
  it(`com ${ANACARE_HOURS_SOURCE_ENV}=real e credencial OK, devolve AnaCareShiftsSourceReal montado sobre o AnaCareSessionClient`, () => {
    const fakeClient = { circuitBreakerOpen: false };
    (AnaCareSessionClient as unknown as jest.Mock).mockImplementation(() => fakeClient);
    const fakeRealSource = { listShifts: jest.fn() };
    (AnaCareShiftsSourceReal as unknown as jest.Mock).mockImplementation(() => fakeRealSource);

    const source = createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'real', ANACARE_USERNAME: 'u', ANACARE_PASS: 'p' } as unknown as NodeJS.ProcessEnv);

    expect(AnaCareSessionClient).toHaveBeenCalledTimes(1);
    expect(AnaCareShiftsSourceReal).toHaveBeenCalledWith(fakeClient);
    expect(source).toBe(fakeRealSource);
  });

  // D350: sem `ANACARE_USERNAME`/`ANACARE_PASS`, `AnaCareSessionClient` LANÇA no construtor
  // (guarda já existente) — a fábrica não pode deixar isso subir como exceção não tratada nem
  // cair silenciosamente no adapter falso: reporta o erro e devolve null (mesmo 503 fail-closed).
  it(`com ${ANACARE_HOURS_SOURCE_ENV}=real e SEM credencial (construtor lança), devolve null e REPORTA o erro (nunca silencioso)`, () => {
    const erroCredencial = new Error('[AnaCareSessionClient] ANACARE_USERNAME/ANACARE_PASS ausentes');
    (AnaCareSessionClient as unknown as jest.Mock).mockImplementation(() => {
      throw erroCredencial;
    });

    const source = createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'real' } as NodeJS.ProcessEnv);

    expect(source).toBeNull();
    expect(AnaCareShiftsSourceReal).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(erroCredencial, expect.objectContaining({ source: expect.stringContaining('createAnaCareShiftsSource') }));
  });

  it('com falha de construção que NÃO é Error (string solta), ainda reporta (envolvida em Error) e devolve null', () => {
    (AnaCareSessionClient as unknown as jest.Mock).mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string-solta';
    });

    const source = createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'real' } as NodeJS.ProcessEnv);

    expect(source).toBeNull();
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'string-solta' }), expect.objectContaining({ source: expect.stringContaining('createAnaCareShiftsSource') }));
  });
});
