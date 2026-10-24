/**
 * UncoveredAlertRecipients — spec 069 F4 (P9/P10). Pool fantasma: a consulta de staff devolve linhas e `iam.effective_countries`
 * devolve os países de cada um. O e2e `069-rotina-diaria` prova o mesmo contra as funções IAM reais.
 */
import { UncoveredAlertRecipients } from '../UncoveredAlertRecipients';

type StaffRow = { uid: string; email: string | null; cells: string[] | null; master: boolean | null };

function pool(staff: StaffRow[], countries: Record<string, string[] | null>) {
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    if (/FROM users u/.test(sql)) return { rows: staff };
    return { rows: [{ countries: countries[String(params[0])] ?? null }] }; // iam.effective_countries($1, …)
  });
  return { query } as never;
}

describe('UncoveredAlertRecipients', () => {
  const ita = ['patient_itinerary:update'];

  it('P9: célula patient_itinerary:update OU Acesso Master; quem só lê (ou não tem nada) não recebe', async () => {
    const r = await new UncoveredAlertRecipients().resolve(
      pool(
        [
          { uid: 'com-celula', email: 'a@x', cells: [...ita, 'patient_services:read'], master: false },
          { uid: 'master', email: 'm@x', cells: [], master: true },
          { uid: 'master-nulo-celulas-nulas', email: 'n@x', cells: null, master: true },
          { uid: 'so-leitura', email: 'l@x', cells: ['patient_itinerary:read'], master: false },
          { uid: 'nada', email: 'z@x', cells: null, master: null },
        ],
        { 'com-celula': ['AR'], master: ['AR', 'BR'], 'master-nulo-celulas-nulas': ['BR'], 'so-leitura': ['AR'], nada: ['AR'] },
      ),
    );
    expect(r.recipients.map((x) => x.uid)).toEqual(['com-celula', 'master', 'master-nulo-celulas-nulas']);
    expect(r.recipients[1]).toEqual({ uid: 'master', email: 'm@x', countries: ['AR', 'BR'] });
    expect(r.skippedNoCountry).toBe(0);
  });

  it('P10: com a célula mas sem país concedido (lista vazia ou null) → não recebe e entra em skippedNoCountry', async () => {
    const r = await new UncoveredAlertRecipients().resolve(
      pool(
        [
          { uid: 'vazio', email: 'v@x', cells: ita, master: false },
          { uid: 'nulo', email: 'n@x', cells: ita, master: false },
          { uid: 'ok', email: 'o@x', cells: ita, master: false },
        ],
        { vazio: [], nulo: null, ok: ['BR'] },
      ),
    );
    expect(r.recipients).toEqual([{ uid: 'ok', email: 'o@x', countries: ['BR'] }]);
    expect(r.skippedNoCountry).toBe(2);
  });

  it('consulta só staff ATIVO, pelo tenant Enlite, sem escrever; o país vem de iam.effective_countries (a mesma do escopo da request)', async () => {
    const p = pool([{ uid: 'u', email: null, cells: ita, master: false }], { u: ['AR'] }) as unknown as { query: jest.Mock };
    const r = await new UncoveredAlertRecipients().resolve(p as never);
    expect(r.recipients[0].email).toBeNull();
    const [staffSql] = p.query.mock.calls[0];
    expect(staffSql).toMatch(/u\.status = 'ACTIVE' AND u\.is_active IS NOT FALSE/);
    expect(staffSql).toMatch(/iam\.is_master_member/);
    expect(staffSql).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(p.query.mock.calls[1][0]).toMatch(/iam\.effective_countries/);
  });
});
