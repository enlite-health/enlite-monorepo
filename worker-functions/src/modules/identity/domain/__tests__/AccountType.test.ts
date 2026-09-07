/**
 * AccountType — a fronteira staff × prestador em um lugar (D294).
 *
 * `lex` C1: o mapa é ALLOWLIST — só os 3 papéis de staff viram `staff`; os 7 valores
 * legados da migration 003/101 e um inventado passam aqui, e nenhum caminho fora dos
 * 3 produz `staff`. `lex` C5: sem tipo e sem papel → não-staff (a ponte só nega).
 */
import {
  ACCOUNT_TYPES,
  accountTypeForRole,
  isAccountType,
  isStaffAccount,
  resolveAccountType,
} from '../AccountType';

const LEGADOS = ['worker', 'admin', 'manager', 'client', 'support', 'recruiter', 'community_manager'] as const;

describe('accountTypeForRole — allowlist (lex C1)', () => {
  it.each([
    ['admin', 'staff'],
    ['recruiter', 'staff'],
    ['community_manager', 'staff'],
    ['worker', 'worker'],
    ['manager', null],
    ['client', null],
    ['support', null],
    ['inventado', null],
    ['', null],
    [null, null],
    [undefined, null],
  ] as const)('%s → %s', (role, esperado) => {
    expect(accountTypeForRole(role as string | null | undefined)).toBe(esperado);
  });

  it('dos 7 valores legados, EXATAMENTE os 3 de staff viram staff', () => {
    const viramStaff = LEGADOS.filter((r) => accountTypeForRole(r) === 'staff');
    expect(viramStaff).toEqual(['admin', 'recruiter', 'community_manager']);
  });
});

describe('isAccountType', () => {
  it('só o vocabulário declarado', () => {
    for (const t of ACCOUNT_TYPES) expect(isAccountType(t)).toBe(true);
    expect(isAccountType('patient')).toBe(false);
    expect(isAccountType('')).toBe(false);
    expect(isAccountType(null)).toBe(false);
    expect(isAccountType(42)).toBe(false);
  });
});

describe('isStaffAccount — o tipo declarado vence; a ponte só nega (lex C5)', () => {
  it('accountType declarado decide, ignorando roles', () => {
    expect(isStaffAccount({ accountType: 'staff', roles: [] })).toBe(true);
    expect(isStaffAccount({ accountType: 'staff', roles: ['worker'] })).toBe(true);
    expect(isStaffAccount({ accountType: 'worker', roles: ['admin'] })).toBe(false);
    expect(isStaffAccount({ accountType: 'patient', roles: ['admin'] })).toBe(false);
  });

  it('sem tipo, a ponte pelo papel: staff só com papel de staff', () => {
    expect(isStaffAccount({ roles: ['recruiter'] })).toBe(true);
    expect(isStaffAccount({ accountType: null, roles: ['admin'] })).toBe(true);
    expect(isStaffAccount({ roles: ['worker'] })).toBe(false);
    expect(isStaffAccount({ roles: ['manager'] })).toBe(false);
  });

  it('sem tipo e sem papel → NÃO é staff (nunca concede por ausência)', () => {
    expect(isStaffAccount({})).toBe(false);
    expect(isStaffAccount({ roles: [] })).toBe(false);
    expect(isStaffAccount({ roles: null, accountType: undefined })).toBe(false);
  });
});

describe('resolveAccountType', () => {
  it('declarado válido → ele; inválido → ponte; nada → null', () => {
    expect(resolveAccountType({ accountType: 'worker', roles: ['admin'] })).toBe('worker');
    expect(resolveAccountType({ accountType: 'lixo', roles: ['admin'] })).toBe('staff');
    expect(resolveAccountType({ roles: ['manager', 'worker'] })).toBe('worker');
    expect(resolveAccountType({ roles: ['manager'] })).toBeNull();
    expect(resolveAccountType({})).toBeNull();
  });
});
