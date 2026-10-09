/**
 * admissionExternals.test.ts — a TRAVA é código (spec 049 regra transversal 2, A2-9): teste nunca toca canal real.
 * Os dois sentidos da fábrica + o adapter real que lança no construtor. A fábrica NÃO lança no boot de teste.
 */
import { AdmissionRealAdapterInTestError } from '../../application/ports/AdmissionMessagingPorts';
import { createAdmissionExternals } from '../admissionExternals';
import { InMemoryAdmissionReminderTasks } from '../doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from '../doubles/RecordingAdmissionWhatsApp';
import { RealAdmissionReminderTasks } from '../RealAdmissionReminderTasks';

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

describe('RealAdmissionReminderTasks (trava de construtor)', () => {
  it('A2-9: new RealAdmissionReminderTasks() com NODE_ENV=test LANÇA', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new RealAdmissionReminderTasks()).toThrow(AdmissionRealAdapterInTestError);
  });
});
