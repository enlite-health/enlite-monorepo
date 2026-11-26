/**
 * talentumFunnel — mudança MANUAL do Talentum = decisão humana (T-095-33, spec 095 §3.4).
 * Regra de decisão com fake de client; o SQL real é provado no e2e T10/T11 (T-095-35).
 *  - `talentum:manual` NÃO é ator automático (nem é movimento humano "nosso");
 *  - detecção: marcador `source: MANUAL`, ou ANALYZED com veredito ≠ veredito já gravado;
 *  - guarda da última movimentação: manual × uid nosso → HUMAN_CONFLICT; automático × talentum:manual → AFTER_MANUAL.
 */
import {
  TALENTUM_MANUAL_ACTOR_ID, isAutomaticActor, isOurHumanActor, detectManualChange, evaluateFunnelGuard,
} from '../talentumFunnel';

const analyzed = (statusLabel: string, source?: string) => ({
  subtype: 'ANALYZED', data: { response: { statusLabel, ...(source ? { source } : {}) } },
});

function fakeDb(lastChangedBy: string | null | 'sem-trilha') {
  return {
    query: jest.fn(async (sql: string) => {
      if (!sql.includes('worker_job_application_stage_history')) return { rows: [] };
      return { rows: lastChangedBy === 'sem-trilha' ? [] : [{ changed_by: lastChangedBy }] };
    }),
  };
}

describe('atores da trilha', () => {
  it("isAutomaticActor('talentum:manual') === false (decisão humana, nunca automática)", () => {
    expect(TALENTUM_MANUAL_ACTOR_ID).toBe('talentum:manual');
    expect(isAutomaticActor(TALENTUM_MANUAL_ACTOR_ID)).toBe(false);
  });
  it.each([[null], [undefined], [''], ['system:reconciliar']])('automático: %p', (v) => {
    expect(isAutomaticActor(v as string | null | undefined)).toBe(true);
  });
  it('humano NOSSO = nem automático nem talentum:manual', () => {
    expect(isOurHumanActor('staff:uid-1')).toBe(true);
    expect(isOurHumanActor('luz:apply')).toBe(true);
    expect(isOurHumanActor('talentum:manual')).toBe(false);
    expect(isOurHumanActor('')).toBe(false);
    expect(isOurHumanActor('system:x')).toBe(false);
  });
});

describe('detectManualChange', () => {
  it("marcador explícito `response.source === 'MANUAL'` → manual, mesmo sem veredito gravado", () => {
    expect(detectManualChange(analyzed('QUALIFIED', 'MANUAL'), null)).toBe(true);
    expect(detectManualChange(analyzed('QUALIFIED', 'MANUAL'), 'COMPLETED')).toBe(true);
  });
  it('sem marcador: ANALYZED com veredito DIFERENTE do já gravado → manual', () => {
    expect(detectManualChange(analyzed('QUALIFIED'), 'NOT_QUALIFIED')).toBe(true);
    expect(detectManualChange(analyzed('NOT_QUALIFIED'), 'IN_DOUBT')).toBe(true);
  });
  it('sem marcador: veredito IGUAL, ainda sem veredito, PENDING ou outro subtype → automático', () => {
    expect(detectManualChange(analyzed('QUALIFIED'), 'QUALIFIED')).toBe(false);
    expect(detectManualChange(analyzed('QUALIFIED'), 'COMPLETED')).toBe(false);
    expect(detectManualChange(analyzed('QUALIFIED'), null)).toBe(false);
    expect(detectManualChange(analyzed('PENDING'), 'QUALIFIED')).toBe(false);
    expect(detectManualChange({ subtype: 'COMPLETED', data: { response: {} } }, 'QUALIFIED')).toBe(false);
    expect(detectManualChange(analyzed('QUALIFIED', 'AUTO'), 'COMPLETED')).toBe(false);
  });
});

describe('evaluateFunnelGuard (a última movimentação da candidatura)', () => {
  it('manual + última linha de uid NOSSO → HUMAN_CONFLICT (só o espelho muda; o chamador avisa)', async () => {
    expect(await evaluateFunnelGuard(fakeDb('staff:uid-1'), 'w', 'j', true)).toBe('HUMAN_CONFLICT');
  });
  it('manual + última linha automática, talentum:manual ou sem trilha → segue (null)', async () => {
    expect(await evaluateFunnelGuard(fakeDb(''), 'w', 'j', true)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb(null), 'w', 'j', true)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('system:x'), 'w', 'j', true)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('talentum:manual'), 'w', 'j', true)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('sem-trilha'), 'w', 'j', true)).toBeNull();
  });
  it('automático + última linha talentum:manual → AFTER_MANUAL (nunca reverte decisão manual)', async () => {
    expect(await evaluateFunnelGuard(fakeDb('talentum:manual'), 'w', 'j', false)).toBe('AFTER_MANUAL');
  });
  it('automático + última linha automática, humana nossa ou sem trilha → segue (null)', async () => {
    expect(await evaluateFunnelGuard(fakeDb(''), 'w', 'j', false)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('staff:uid-1'), 'w', 'j', false)).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('sem-trilha'), 'w', 'j', false)).toBeNull();
  });
  it('lê a ÚLTIMA linha (ORDER BY created_at DESC, id DESC LIMIT 1) da etapa do WJA do par worker×vaga', async () => {
    const db = fakeDb('');
    await evaluateFunnelGuard(db, 'w1', 'j1', false);
    const [sql, params] = db.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toMatch(/ORDER BY h\.created_at DESC, h\.id DESC\s+LIMIT 1/);
    expect(sql).toContain("h.field_name = 'application_funnel_stage'");
    expect(params).toEqual(['w1', 'j1']);
  });
});
