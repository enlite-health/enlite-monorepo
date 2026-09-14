/**
 * pgUniqueViolationConflict.test.ts — o helper único que os dois controllers de endereço de
 * paciente reusam para mapear `23505` (unique_violation) do Postgres para 409. Cobre o positivo
 * (mapeia), o negativo (outro código nunca é mascarado) e as bordas de erro sem `code`.
 */
import { pgUniqueViolationConflict } from '../pgUniqueViolationConflict';

describe('pgUniqueViolationConflict', () => {
  it('23505 → mapeia para o corpo 409 com a mensagem recebida', () => {
    const err = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    expect(pgUniqueViolationConflict(err, 'Concurrent update — try again')).toEqual({
      success: false,
      error: 'Concurrent update — try again',
    });
  });

  it('mensagem é parâmetro — dois sites com mensagens diferentes não colidem', () => {
    const err = Object.assign(new Error('dup'), { code: '23505' });
    expect(pgUniqueViolationConflict(err, 'Outra mensagem')).toEqual({
      success: false,
      error: 'Outra mensagem',
    });
  });

  it('outro código de erro Postgres → null, nunca mascara o erro (deve relançar/deixar passar)', () => {
    const err = Object.assign(new Error('not null violation'), { code: '23502' });
    expect(pgUniqueViolationConflict(err, 'Concurrent update — try again')).toBeNull();
  });

  it('erro sem `code` → null', () => {
    expect(pgUniqueViolationConflict(new Error('boom'), 'msg')).toBeNull();
  });

  it('erro não-objeto (string, número, null) → null, sem lançar', () => {
    expect(pgUniqueViolationConflict('boom', 'msg')).toBeNull();
    expect(pgUniqueViolationConflict(42, 'msg')).toBeNull();
    expect(pgUniqueViolationConflict(null, 'msg')).toBeNull();
    expect(pgUniqueViolationConflict(undefined, 'msg')).toBeNull();
  });
});
