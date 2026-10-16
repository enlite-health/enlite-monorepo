/**
 * A4-8 (trava de teste): teste nunca toca o Tactiq. O adapter REAL lança no construtor com NODE_ENV=test; a fábrica
 * NÃO lança no boot de teste (entrega dublês); em produção constrói os reais sem exigir config (ela é lida na chamada).
 */
import { TactiqNotConfiguredError, TactiqRealClientInTestError } from '../../../application/ports/TactiqPorts';
import { createAdmissionExternals } from '../../admissionExternals';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../doubles/FakeTactiq';
import { TactiqMcpClient } from '../TactiqMcpClient';
import { TactiqOAuthClient } from '../TactiqOAuthClient';

const realWhatsApp = jest.fn(() => ({ sendWithContentSid: jest.fn() }));

describe('A4-8 — a trava de teste do Tactiq', () => {
  it('new TactiqMcpClient() e new TactiqOAuthClient() com NODE_ENV=test LANÇAM', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new TactiqMcpClient()).toThrow(TactiqRealClientInTestError);
    expect(() => new TactiqOAuthClient()).toThrow(TactiqRealClientInTestError);
    expect(() => new TactiqMcpClient({ NODE_ENV: 'test' })).toThrow(/NODE_ENV=test/);
  });

  it('fora de test o construtor NÃO lança (a config é lida na chamada): chamar sem env dá TactiqNotConfiguredError, sem rede', async () => {
    const mcp = new TactiqMcpClient({ NODE_ENV: 'production' });
    await expect(mcp.ping('at')).rejects.toBeInstanceOf(TactiqNotConfiguredError);
    const oauth = new TactiqOAuthClient({ NODE_ENV: 'production' });
    await expect(oauth.buildAuthorizeUrl({ state: 's', codeChallenge: 'c' })).rejects.toBeInstanceOf(TactiqNotConfiguredError);
  });

  it('a fábrica em NODE_ENV=test NÃO lança no boot e entrega os DUBLÊS do Tactiq', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp });
    expect(ext.tactiq.oauth).toBeInstanceOf(FakeTactiqOAuth);
    expect(ext.tactiq.mcp).toBeInstanceOf(FakeTactiqMcp);
  });

  it('a fábrica em test + ADMISSION_EXTERNALS=real LANÇA (e não constrói canal real)', () => {
    expect(() => createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'real' }, { realWhatsApp })).toThrow();
  });

  it('produção → os clientes REAIS do Tactiq (a fábrica passa o env dela, não o do processo de teste)', () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp, realReminderTasks: () => ({ schedule: jest.fn(), cancel: jest.fn() }) as never });
    expect(ext.tactiq.oauth).toBeInstanceOf(TactiqOAuthClient);
    expect(ext.tactiq.mcp).toBeInstanceOf(TactiqMcpClient);
  });
});
