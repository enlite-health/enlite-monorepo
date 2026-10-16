/**
 * admissionExternals.test.ts — a TRAVA é código (spec 049 regra transversal 2, A2-9): teste nunca toca canal real.
 * Os dois sentidos da fábrica + o adapter real que lança no construtor. A fábrica NÃO lança no boot de teste.
 */
import { AdmissionRealAdapterInTestError } from '../../application/ports/AdmissionMessagingPorts';
import { AdmissionCalendarService, admissionCalendarService } from '../AdmissionCalendarService';
import { createAdmissionExternals } from '../admissionExternals';
import { FakeAdmissionCalendar } from '../doubles/FakeAdmissionCalendar';
import { UnavailableAdmissionCalendar } from '../doubles/UnavailableAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from '../doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../doubles/RecordingAdmissionWhatsApp';
import { RealAdmissionReminderTasks } from '../RealAdmissionReminderTasks';
import { InMemoryTranscriptVault } from '../doubles/InMemoryTranscriptVault';
import { FakeAdmissionSummaryGenerator } from '../doubles/FakeAdmissionSummaryGenerator';
import { GcsTranscriptVault } from '../GcsTranscriptVault';
import { VertexAdmissionSummaryGenerator } from '../VertexAdmissionSummaryGenerator';

const realWhatsApp = jest.fn(() => ({ sendWithContentSid: jest.fn() }));

describe('createAdmissionExternals', () => {
  beforeEach(() => realWhatsApp.mockClear());

  it('A2-9: NODE_ENV=test + ADMISSION_EXTERNALS=real → LANÇA (e não constrói canal real)', () => {
    expect(() => createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'real' }, { realWhatsApp })).toThrow(AdmissionRealAdapterInTestError);
    expect(realWhatsApp).not.toHaveBeenCalled();
  });

  it('A2-9: NODE_ENV=production + ADMISSION_EXTERNALS=fake → LANÇA', () => {
    expect(() => createAdmissionExternals({ NODE_ENV: 'production', ADMISSION_EXTERNALS: 'fake' }, { realWhatsApp })).toThrow(/proibido em produção/);
  });

  it('NODE_ENV=test sem a variável → dublês, SEM lançar (a stack do CI roda NODE_ENV=test; lançar no boot a derrubaria) e sem tocar o canal real', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp });
    expect(ext.mode).toBe('fake');
    expect(ext.reminderTasks).toBeInstanceOf(InMemoryAdmissionReminderTasks);
    expect(ext.whatsapp).toBeInstanceOf(RecordingAdmissionWhatsApp);
    expect(realWhatsApp).not.toHaveBeenCalled();
  });

  it('ADMISSION_EXTERNALS=fake fora de produção (dev) → dublês', () => {
    expect(createAdmissionExternals({ NODE_ENV: 'development', ADMISSION_EXTERNALS: 'fake' }, { realWhatsApp }).mode).toBe('fake');
  });

  it('produção sem a variável → adapters reais (o canal real é pedido à fábrica só aqui)', () => {
    const tasks = new InMemoryAdmissionReminderTasks();
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp, realReminderTasks: () => tasks });
    expect(ext.mode).toBe('real');
    expect(ext.reminderTasks).toBe(tasks);
    expect(realWhatsApp).toHaveBeenCalledTimes(1);
  });

  it('produção sem override do agendador → constrói o adapter REAL (fora de test, não lança)', () => {
    const OLD = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp });
      expect(ext.reminderTasks).toBeInstanceOf(RealAdmissionReminderTasks);
    } finally {
      process.env.NODE_ENV = OLD;
    }
  });
});

describe('createAdmissionExternals — o Calendar (spec 049 F3)', () => {
  it('ADMISSION_EXTERNALS=fake explícito → FakeAdmissionCalendar (a stack e2e da 049)', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'fake' }, { realWhatsApp });
    expect(ext.calendar).toBeInstanceOf(FakeAdmissionCalendar);
  });

  it('R-17: NODE_ENV=test SEM a variável também devolve o DUBLÊ do Calendar (nunca o real, que manda e-mail)', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp });
    expect(ext.mode).toBe('fake');
    expect(ext.calendar).toBeInstanceOf(FakeAdmissionCalendar);
    expect(ext.calendar).not.toBe(admissionCalendarService);
  });

  it('R-17: ADMISSION_CALENDAR_DOUBLE=unavailable → dublê que FALHA de propósito (o e2e do roster: "agenda inacessível → 500")', async () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_CALENDAR_DOUBLE: 'unavailable' }, { realWhatsApp });
    expect(ext.calendar).toBeInstanceOf(UnavailableAdmissionCalendar);
    await expect(ext.calendar.getFreeBusyByCalendar(['a@b.test'], 'x@y.test', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z')).rejects.toThrow(/agenda inacessível/);
    await expect(ext.calendar.getCalendarTimezone('cal', 'x@y.test')).rejects.toThrow(/agenda inacessível/);
  });

  it('R-17: ADMISSION_EXTERNALS=fake vence ADMISSION_CALENDAR_DOUBLE (a stack da 049 não pode herdar a agenda quebrada)', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'fake', ADMISSION_CALENDAR_DOUBLE: 'unavailable' }, { realWhatsApp });
    expect(ext.calendar).toBeInstanceOf(FakeAdmissionCalendar);
  });

  it('R-17: instanciar o cliente REAL do Calendar com NODE_ENV=test LANÇA (o singleton só o constrói na 1ª chamada, e aí lança)', async () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new AdmissionCalendarService()).toThrow(AdmissionRealAdapterInTestError);
    await expect(admissionCalendarService.getCalendarTimezone('cal', 'x@y.test')).rejects.toThrow(AdmissionRealAdapterInTestError);
    // controle: fora de teste o mesmo construtor NÃO lança
    expect(() => new AdmissionCalendarService({ NODE_ENV: 'production' })).not.toThrow();
  });

  it('produção → Calendar real', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp, realReminderTasks: () => new InMemoryAdmissionReminderTasks() });
    expect(ext.calendar).toBe(admissionCalendarService);
  });
});

describe('RealAdmissionReminderTasks (trava de construtor)', () => {
  it('A2-9: new RealAdmissionReminderTasks() com NODE_ENV=test LANÇA', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new RealAdmissionReminderTasks()).toThrow(AdmissionRealAdapterInTestError);
  });
});

describe('createAdmissionExternals — cofre e Vertex (spec 049 F6, A6-10)', () => {
  it('NODE_ENV=test → cofre em memória e gerador dublê, SEM lançar no boot', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp });
    expect(ext.vault).toBeInstanceOf(InMemoryTranscriptVault);
    expect(ext.summary).toBeInstanceOf(FakeAdmissionSummaryGenerator);
  });

  it('A6-10: new GcsTranscriptVault() e new VertexAdmissionSummaryGenerator() com NODE_ENV=test LANÇAM', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new GcsTranscriptVault()).toThrow(AdmissionRealAdapterInTestError);
    expect(() => new VertexAdmissionSummaryGenerator()).toThrow(AdmissionRealAdapterInTestError);
  });

  it('produção sem as envs → constrói os adapters REAIS no boot sem lançar (o bucket só é exigido na CHAMADA)', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp, realReminderTasks: () => new InMemoryAdmissionReminderTasks() });
    expect(ext.vault).toBeInstanceOf(GcsTranscriptVault);
    expect(ext.summary).toBeInstanceOf(VertexAdmissionSummaryGenerator);
  });
});
