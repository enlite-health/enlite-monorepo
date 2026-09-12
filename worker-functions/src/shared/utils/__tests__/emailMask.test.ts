import { maskEmailForLog } from '../emailMask';

// ── maskEmailForLog — SEMPRE `***@dominio`, nunca o local part ────────────────
// Casos migrados do extinto `redactContact` (D-11/09, item 1 do gate): mesma
// política de e-mail (`***@dominio`, sem hash — parecer do lex C4), agora
// dona única em `emailMask.ts` ao lado de `maskEmail` (a máscara de TELA).
describe('maskEmailForLog', () => {
  const SENSITIVE_EMAIL = 'joao.garcia@example.com';

  it('domínio visível, local-part NUNCA aparece (nem em claro, nem hash)', () => {
    const out = maskEmailForLog(SENSITIVE_EMAIL);
    expect(out).toBe('***@example.com');
    expect(out).not.toContain('joao');
    expect(out).not.toContain('garcia');
    expect(out).not.toContain(SENSITIVE_EMAIL);
  });

  // Parecer do lex (C4, 11/09): a 1ª versão do extinto `redactContact` usava
  // sha256(local-part).slice(0,6) — REVERSÍVEL por dicionário (local-part de
  // e-mail tem entropia baixa: não é senha, é nome.sobrenome). A queda segura
  // aceita pelo lex é esta: e-mails diferentes do MESMO domínio ficam
  // INDISTINGUÍVEIS no log — não dá pra saber se são a mesma pessoa ou duas.
  it('local-parts DIFERENTES no MESMO domínio ficam INDISTINGUÍVEIS (queda segura do lex)', () => {
    const a = maskEmailForLog('ana@example.com');
    const b = maskEmailForLog('bruno@example.com');
    expect(a).toBe(b);
    expect(a).toBe('***@example.com');
  });

  it('é determinístico — mesmo e-mail 2x continua com a mesma saída', () => {
    const a = maskEmailForLog(SENSITIVE_EMAIL);
    const b = maskEmailForLog(SENSITIVE_EMAIL);
    expect(a).toBe(b);
  });

  it('e-mail malformado (sem @, @ no início ou @ no fim): nunca ecoa o valor cru', () => {
    expect(maskEmailForLog('nao-e-email')).toBe('***');
    expect(maskEmailForLog('@dominio.com')).toBe('***');
    expect(maskEmailForLog('local@')).toBe('***');
  });

  it('nulo/undefined/vazio: marcador fixo, nunca string vazia', () => {
    expect(maskEmailForLog(null)).toBe('(vazio)');
    expect(maskEmailForLog(undefined)).toBe('(vazio)');
    expect(maskEmailForLog('')).toBe('(vazio)');
    expect(maskEmailForLog('   ')).toBe('(vazio)');
  });
});
