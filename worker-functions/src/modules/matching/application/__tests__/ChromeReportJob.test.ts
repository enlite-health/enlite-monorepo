/**
 * spec 050 F15 — o job do relatório do Chrome SEM banco (repositório e publicador de mentira): o que não depende de SQL.
 *  A15-x: porta no default de produção = 0 chamadas de rede ao Google (espião em `fetch`); controle: dublê "disponível" → ≥ 1 chamada.
 *  A15-2: lista vazia com o controle `countInstalledApps` > 0 falha ALTO e não grava nada.
 *  A15-5: política ausente → log de alarme.
 * As transições, o evento e o sino (que precisam do banco) estão em `tests/e2e/admission-050-chrome-*`.
 */
import { ChromeReportJob } from '../ChromeReportJob';
import { FakeChromeReport } from '../../infrastructure/doubles/FakeChromeReport';
import { GoogleChromeManagementClient } from '../../infrastructure/GoogleChromeManagementClient';
import { createAdmissionExternals } from '../../infrastructure/admissionExternals';
import { InMemoryAdmissionReminderTasks } from '../../infrastructure/doubles/InMemoryAdmissionReminderTasks';
import { capturingLogger } from '../../infrastructure/doubles/admissionTestKit';
import { ChromeReportEmptyListError, TACTIQ_EXTENSION_ID } from '../ports/ChromeReportPort';

const NOW = new Date('2026-10-11T12:00:00Z');

function repoStub(emails: string[] = []) {
  const touched: string[] = [];
  const repo = {
    listActiveRosterEmails: jest.fn(async () => {
      touched.push('list');
      return emails;
    }),
  };
  return { repo: repo as never, touched, listActiveRosterEmails: repo.listActiveRosterEmails };
}
const poolStub = { connect: jest.fn(), query: jest.fn() } as never;

describe('A15-x: o default de produção não chama o Google', () => {
  let fetchSpy: jest.SpyInstance;
  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'));
  });
  afterEach(() => fetchSpy.mockRestore());

  it('a fábrica em produção, sem variável nenhuma, entrega o adaptador real; o job devolve "unavailable", 0 fetch, 0 leitura do banco, sem run_done', async () => {
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp: () => ({ sendWithContentSid: jest.fn() }) as never, realReminderTasks: () => new InMemoryAdmissionReminderTasks() });
    expect(ext.chrome).toBeInstanceOf(GoogleChromeManagementClient);
    const logs = capturingLogger();
    const stub = repoStub(['a@example.test']);
    const summary = await new ChromeReportJob({ repo: stub.repo, chrome: ext.chrome, db: poolStub, publisher: {} as never, log: logs.log, now: () => NOW }).run();
    expect(summary).toMatchObject({ status: 'unavailable', rosterHosts: 0, transitions: 0, notified: 0, policy: 'unchecked' });
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(stub.touched).toEqual([]);
    expect(logs.output()).toContain('admission.chrome_report.unavailable');
    expect(logs.output()).not.toContain('admission.chrome_report.run_done');
  });

  it('o espião funciona (controle): um fetch qualquer é contado', async () => {
    await fetch('https://exemplo.test');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('controle positivo: com o dublê "disponível" o job CHAMA a porta (≥ 1) e conclui, ainda com 0 fetch', async () => {
    const fake = new FakeChromeReport();
    fake.setInstalled(['a@example.test']);
    const logs = capturingLogger();
    const stub = repoStub([]); // roster vazio: o job lê a lista e o controle, confere a política e termina
    const summary = await new ChromeReportJob({ repo: stub.repo, chrome: fake, db: poolStub, publisher: {} as never, log: logs.log, now: () => NOW }).run();
    expect(summary.status).toBe('ok');
    expect(fake.calls.length).toBeGreaterThanOrEqual(1);
    expect(fake.calls).toEqual(['findInstalledEmails', 'countInstalledProfiles', 'resolveForcedInstall']);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    expect(logs.output()).toContain('admission.chrome_report.run_done');
  });

  it('o adaptador real lança no construtor com NODE_ENV=test; fora de teste não lança', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new GoogleChromeManagementClient()).toThrow(/não pode ser instanciado com NODE_ENV=test/);
    expect(() => new GoogleChromeManagementClient({ NODE_ENV: 'production' })).not.toThrow();
  });
});

describe('A15-2: lista vazia com o controle > 0 NÃO vira "ninguém tem"', () => {
  it('lista vazia + profileCount 3 → falha alto (ChromeReportEmptyListError), log de erro, nenhum estado lido ou gravado, sem run_done', async () => {
    const fake = new FakeChromeReport();
    fake.setInstalled([]);
    fake.profileCount = 3;
    const logs = capturingLogger();
    const stub = repoStub(['a@example.test']);
    await expect(new ChromeReportJob({ repo: stub.repo, chrome: fake, db: poolStub, publisher: {} as never, log: logs.log, now: () => NOW }).run()).rejects.toBeInstanceOf(ChromeReportEmptyListError);
    expect(stub.touched).toEqual([]);
    expect(logs.output()).toContain('admission.chrome_report.empty_list');
    expect(logs.output()).not.toContain('admission.chrome_report.run_done');
  });

  it('controle: lista vazia com controle 0 é "ninguém tem" legítimo e o job conclui (o job lê o roster)', async () => {
    const fake = new FakeChromeReport();
    fake.setInstalled([]);
    fake.profileCount = 0;
    const stub = repoStub([]);
    const summary = await new ChromeReportJob({ repo: stub.repo, chrome: fake, db: poolStub, publisher: {} as never, log: capturingLogger().log, now: () => NOW }).run();
    expect(summary.status).toBe('ok');
    expect(stub.touched).toEqual(['list']);
  });
});

describe('A15-5: a política de instalação forçada', () => {
  async function runWith(policy: 'applied' | 'absent' | 'unknown') {
    const fake = new FakeChromeReport();
    fake.policy = policy;
    const logs = capturingLogger();
    const summary = await new ChromeReportJob({ repo: repoStub([]).repo, chrome: fake, db: poolStub, publisher: {} as never, log: logs.log, now: () => NOW }).run();
    return { summary, out: logs.output(), fake };
  }

  it('política ausente → log de ALARME (nível error) com o nome que o alerta filtra, e o veredito sai no resumo', async () => {
    const { summary, out, fake } = await runWith('absent');
    const alarm = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.message === 'admission.chrome_report.policy_missing');
    expect(alarm).toBeDefined();
    expect(alarm?.level).toBe(50); // pino: error
    expect(summary.policy).toBe('absent');
    expect(fake.calls).toContain('resolveForcedInstall');
  });

  it('política aplicada → sem alarme (controle); esquema não medido ("unknown") → aviso, não alarme', async () => {
    const aplicada = await runWith('applied');
    expect(aplicada.out).not.toContain('policy_missing');
    expect(aplicada.out).not.toContain('policy_unverifiable');
    const desconhecida = await runWith('unknown');
    expect(desconhecida.out).toContain('admission.chrome_report.policy_unverifiable');
    expect(desconhecida.out).not.toContain('policy_missing');
  });

  it('o id da extensão que a porta recebe é o do Tactiq da spec', () => {
    expect(TACTIQ_EXTENSION_ID).toBe('fggkaccpbmombhnjkjokndojfgagejfb');
  });
});
