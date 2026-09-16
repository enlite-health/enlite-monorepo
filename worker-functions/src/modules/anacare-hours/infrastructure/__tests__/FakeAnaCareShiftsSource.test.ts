import { FakeAnaCareShiftsSource, createAnaCareShiftsSource, ANACARE_HOURS_SOURCE_ENV } from '../FakeAnaCareShiftsSource';

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

    it('turno sem check-in (checkinSource null) tem actualStart/actualEnd/durationHours null', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const semCheckin = shifts.filter((s) => s.checkinSource === null);
      expect(semCheckin.length).toBeGreaterThan(0);
      for (const s of semCheckin) {
        expect(s.actualStart).toBeNull();
        expect(s.actualEnd).toBeNull();
        expect(s.durationHours).toBeNull();
      }
    });

    it('turno com check-in tem durationHours numérico e datas dentro do mês', () => {
      const shifts = FakeAnaCareShiftsSource.generateMonth('2026-09');
      const comCheckin = shifts.filter((s) => s.checkinSource !== null);
      expect(comCheckin.length).toBeGreaterThan(0);
      for (const s of comCheckin) {
        expect(typeof s.durationHours).toBe('number');
        expect(s.date.startsWith('2026-09')).toBe(true);
      }
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
  it(`com ${ANACARE_HOURS_SOURCE_ENV}=fake devolve o adapter falso`, () => {
    const source = createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'fake' } as NodeJS.ProcessEnv);
    expect(source).toBeInstanceOf(FakeAnaCareShiftsSource);
  });

  it('sem a env devolve null (fail-closed)', () => {
    expect(createAnaCareShiftsSource({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it('com valor desconhecido devolve null (nunca serve dado falso por omissão/typo)', () => {
    expect(createAnaCareShiftsSource({ [ANACARE_HOURS_SOURCE_ENV]: 'real' } as NodeJS.ProcessEnv)).toBeNull();
  });
});
