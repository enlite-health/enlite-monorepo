/**
 * LeadContact — testes de domínio.
 *
 * Duas funções puras que sustentam condições do parecer do lex de 30/08:
 * `isLeadPlaceholderName` é o corte de escopo (C2 — quem NÃO é placeholder não
 * tem contato descriptografado nem exposto) e `maskEmail` é a máscara de
 * servidor (C1 — a finalidade é desempatar cards, não entregar o endereço).
 *
 * Testadas aqui, sem banco, porque é onde o erro seria silencioso: uma regressão
 * em `isLeadPlaceholderName` que devolvesse `true` demais vazaria contato do
 * board inteiro sem nenhum teste de integração acusar.
 */

import {
  LEAD_PLACEHOLDER_FIRST_NAME,
  isLeadPlaceholderName,
  maskEmail,
} from '../LeadContact';

describe('isLeadPlaceholderName — o corte de escopo (C2)', () => {
  it('reconhece o placeholder exatamente como o CreateLeadUseCase o grava', () => {
    // firstName='Solicitante', lastName=null — ver CreateLeadUseCase:67-68.
    expect(isLeadPlaceholderName(LEAD_PLACEHOLDER_FIRST_NAME, null)).toBe(true);
    expect(isLeadPlaceholderName('Solicitante', '')).toBe(true);
    expect(isLeadPlaceholderName('  solicitante  ', null)).toBe(true);
  });

  it('NÃO reconhece ficha com nome real — é o que mantém o board fora do payload', () => {
    expect(isLeadPlaceholderName('Ana', 'García')).toBe(false);
    expect(isLeadPlaceholderName('Solicitud', null)).toBe(false);
    expect(isLeadPlaceholderName(null, null)).toBe(false);
    expect(isLeadPlaceholderName('', null)).toBe(false);
  });

  it('paciente que POR ACASO se chame Solicitante mas tenha sobrenome não é lead anônimo', () => {
    // Sobrenome preenchido significa ficha real; o placeholder nunca tem um.
    expect(isLeadPlaceholderName('Solicitante', 'Pereyra')).toBe(false);
  });
});

describe('maskEmail — a máscara de servidor (C1)', () => {
  it('mantém 2 caracteres e o domínio, esconde o resto', () => {
    expect(maskEmail('joana@gmail.com')).toBe('jo***@gmail.com');
    expect(maskEmail('gabriel.stein@enlite.health')).toBe('ga***@enlite.health');
  });

  it('local part de 1 caractere não vira string vazia', () => {
    expect(maskEmail('a@gmail.com')).toBe('a***@gmail.com');
  });

  it('nunca devolve o endereço inteiro — a parte escondida some de verdade', () => {
    const masked = maskEmail('joana@gmail.com');
    expect(masked).not.toContain('joana');
    expect(masked).not.toBe('joana@gmail.com');
  });

  it('entrada que não é e-mail vira null em vez de ecoar a string', () => {
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail(undefined)).toBeNull();
    expect(maskEmail('')).toBeNull();
    expect(maskEmail('sem-arroba')).toBeNull();
    expect(maskEmail('@gmail.com')).toBeNull();
    expect(maskEmail('joana@localhost')).toBeNull();
  });
});
