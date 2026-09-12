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

  it('e-mail: domínio visível, local-part NUNCA aparece (nem em claro, nem hash)', () => {
    const out = redactContact(SENSITIVE_EMAIL, 'email');
    expect(out).toBe('***@example.com');
    expect(out).not.toContain('joao');
    expect(out).not.toContain('garcia');
    expect(out).not.toContain(SENSITIVE_EMAIL);
  });

  // Parecer do lex (C4, 11/09): a versão anterior (hash sha256 do local-part)
  // era REVERSÍVEL por dicionário — local-part de e-mail tem entropia baixa
  // (nome.sobrenome), então o hash curto não protegia de verdade. A queda
  // segura aceita pelo lex é justamente ISTO: e-mails diferentes do MESMO
  // domínio saem INDISTINGUÍVEIS no log — não dá pra saber se são a mesma
  // pessoa ou duas, e é intencional (o custo de dar essa correlação de volta
  // pediria chave em Secret Manager, fora do escopo deste conserto).
  it('e-mail: local-parts DIFERENTES no MESMO domínio ficam INDISTINGUÍVEIS (queda segura do lex)', () => {
    const a = redactContact('ana@example.com', 'email');
    const b = redactContact('bruno@example.com', 'email');
    expect(a).toBe(b);
    expect(a).toBe('***@example.com');
  });

  it('e-mail: o mesmo e-mail chamado 2x continua determinístico (mesma saída, sem precisar de hash)', () => {
    const a = redactContact(SENSITIVE_EMAIL, 'email');
    const b = redactContact(SENSITIVE_EMAIL, 'email');
    expect(a).toBe(b);
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
