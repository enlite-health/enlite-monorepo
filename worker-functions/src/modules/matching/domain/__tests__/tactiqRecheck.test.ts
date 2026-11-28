import { CONSENT_SCOPE_FROZEN, effectiveScopeHasDetails, isRecheckable, isSeatCause } from '../tactiqRecheck';

const B = 'tactiq_link.broken';
const W = 'tactiq_link.wrong_account';
const D = 'tactiq_link.recheck_dead';

describe('isRecheckable (design D3)', () => {
  const cases: Array<[string, string, { kind: string; reason: string | null; source?: string | null } | null, boolean]> = [
    ['wrong_account legado', 'wrong_account', { kind: W, reason: 'meeting_not_visible' }, true],
    ['broken access_action:request_seat (legado)', 'broken', { kind: B, reason: 'access_action:request_seat' }, true],
    ['broken access_action:upgrade', 'broken', { kind: B, reason: 'access_action:upgrade', source: 'daily_check' }, true],
    ['broken unauthorized sem source (legado)', 'broken', { kind: B, reason: 'unauthorized' }, true],
    ['broken unauthorized source null', 'broken', { kind: B, reason: 'unauthorized', source: null }, true],
    ['broken unauthorized daily_check', 'broken', { kind: B, reason: 'unauthorized', source: 'daily_check' }, true],
    ['broken source=link (F1)', 'broken', { kind: B, reason: 'access_action:request_seat', source: 'link' }, true],
    ['broken invalid_grant', 'broken', { kind: B, reason: 'invalid_grant' }, false],
    ['broken token_endpoint_401_403', 'broken', { kind: B, reason: 'token_endpoint_401_403' }, false],
    ['broken mcp_transport_401_403', 'broken', { kind: B, reason: 'mcp_transport_401_403' }, false],
    ['broken source=import', 'broken', { kind: B, reason: 'unauthorized', source: 'import' }, false],
    ['broken access_action com source=import', 'broken', { kind: B, reason: 'access_action:request_seat', source: 'import' }, false],
    ['recheck_dead', 'broken', { kind: D, reason: 'invalid_grant' }, false],
    ['recheck_dead com razão que seria re-testável', 'broken', { kind: D, reason: 'unauthorized' }, false],
    ['sem evento de queda (broken)', 'broken', null, false],
    ['sem evento de queda (wrong_account)', 'wrong_account', null, false],
    ['status linked', 'linked', { kind: B, reason: 'unauthorized' }, false],
    ['broken com razão desconhecida', 'broken', { kind: B, reason: 'algo_novo' }, false],
  ];
  it.each(cases)('%s', (_name, status, lastDegrade, expected) => {
    expect(isRecheckable({ status, lastDegrade })).toBe(expected);
  });
});

describe('isSeatCause (design D9)', () => {
  it('só request_seat', () => {
    expect(isSeatCause('access_action:request_seat')).toBe(true);
    expect(isSeatCause('access_action:upgrade')).toBe(false);
    expect(isSeatCause('access_action:unrecognized_value')).toBe(false);
    expect(isSeatCause('unauthorized')).toBe(false);
    expect(isSeatCause(null)).toBe(false);
  });
});

describe('effectiveScopeHasDetails (design D5)', () => {
  const own = 'mcp:meetings:own';
  const both = 'mcp:meetings:own mcp:meetings:details';
  // [refreshScope, lastLinkScope, frozen, esperado]
  const cases: Array<[string | null | undefined, string | null | undefined, boolean, boolean]> = [
    // a renovação traz escopo: autoritativo nos dois valores de frozen
    [both, own, true, true],
    [both, own, false, true],
    [own, both, true, false],
    [own, both, false, false],
    ['', both, true, false],
    // sem escopo na renovação: congelado → último escopo gravado
    [undefined, own, true, false],
    [undefined, both, true, true],
    [null, own, true, false],
    // sem escopo na renovação: não congelado → só o ready
    [undefined, own, false, true],
    [undefined, both, false, true],
    // sem nada gravado (legado) → só o ready, nos dois valores
    [undefined, undefined, true, true],
    [undefined, null, true, true],
    [undefined, undefined, false, true],
  ];
  it.each(cases)('refresh=%j last=%j frozen=%s → %s', (refreshScope, lastLinkScope, frozen, expected) => {
    expect(effectiveScopeHasDetails({ refreshScope, lastLinkScope, frozen })).toBe(expected);
  });
});

describe('CONSENT_SCOPE_FROZEN', () => {
  it('default true enquanto a F38 não foi medida', () => {
    expect(CONSENT_SCOPE_FROZEN).toBe(true);
  });
});
