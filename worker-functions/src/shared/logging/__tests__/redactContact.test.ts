import { redactContact } from '../redactContact';

describe('redactContact', () => {
  const SENSITIVE_PHONE = '5491122334455';
  const SENSITIVE_EMAIL = 'joao.garcia@example.com';

  it('telefone: mostra só os 4 últimos dígitos, preservando o prefixo AR (549)', () => {
    const out = redactContact(SENSITIVE_PHONE, 'phone');
    expect(out).toBe('549***4455');
    expect(out).not.toContain(SENSITIVE_PHONE);
    // O miolo do número (tudo entre o prefixo de país e os últimos 4 dígitos)
    // nunca aparece — nem em pedaços.
    expect(out).not.toContain('112233');
  });

  it('telefone sem prefixo AR reconhecível: mascara sem assumir país', () => {
    const out = redactContact('551198887777', 'phone'); // BR, não bate 54/549
    expect(out).toBe('***7777');
    expect(out).not.toContain('551198887777');
  });

  it('telefone com formatação (espaços, +, parênteses): normaliza antes de mascarar', () => {
    const out = redactContact('+54 9 11 2233-4455', 'phone');
    expect(out).toBe('549***4455');
  });

  it('telefone curtíssimo (≤4 dígitos): não tenta extrair prefixo, só marca', () => {
    expect(redactContact('123', 'phone')).toBe('***123');
    expect(redactContact('4455', 'phone')).toBe('***4455');
  });

  it('e-mail: domínio visível, local-part vira hash curto (nunca o valor original)', () => {
    const out = redactContact(SENSITIVE_EMAIL, 'email');
    expect(out).toMatch(/^[0-9a-f]{6}@example\.com$/);
    expect(out).not.toContain('joao');
    expect(out).not.toContain('garcia');
    expect(out).not.toContain(SENSITIVE_EMAIL);
  });

  it('e-mail: o hash é ESTÁVEL — a mesma entrada gera sempre a mesma saída', () => {
    const a = redactContact(SENSITIVE_EMAIL, 'email');
    const b = redactContact(SENSITIVE_EMAIL, 'email');
    const c = redactContact(SENSITIVE_EMAIL, 'email');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('e-mail: local-parts diferentes no MESMO domínio geram hashes diferentes', () => {
    const a = redactContact('ana@example.com', 'email');
    const b = redactContact('bruno@example.com', 'email');
    expect(a).not.toBe(b);
  });

  it('e-mail malformado (sem @, @ no início ou @ no fim): nunca ecoa o valor cru', () => {
    expect(redactContact('nao-e-email', 'email')).toBe('***');
    expect(redactContact('@dominio.com', 'email')).toBe('***');
    expect(redactContact('local@', 'email')).toBe('***');
  });

  it('nulo/undefined/vazio: marcador fixo, nunca string vazia', () => {
    expect(redactContact(null, 'phone')).toBe('(vazio)');
    expect(redactContact(undefined, 'phone')).toBe('(vazio)');
    expect(redactContact('', 'phone')).toBe('(vazio)');
    expect(redactContact('   ', 'phone')).toBe('(vazio)');
    expect(redactContact(null, 'email')).toBe('(vazio)');
    expect(redactContact('', 'email')).toBe('(vazio)');
  });

  it('telefone só com caracteres não numéricos (sem dígito nenhum): marcador fixo', () => {
    expect(redactContact('+++---', 'phone')).toBe('(vazio)');
  });
});
