import { safeErrorFields } from '../safeErrorFields';

describe('safeErrorFields', () => {
  it('extrai errorName e code (SQLSTATE) de um erro do pg, nunca message/stack', () => {
    const sensitiveValue = 'VALOR_SENSIVEL_ABC123';
    const pgErr = Object.assign(
      new Error(`invalid input syntax for type uuid: "${sensitiveValue}"`),
      { code: '22P02' },
    );

    const fields = safeErrorFields(pgErr);

    expect(fields).toEqual({ errorName: 'Error', code: '22P02' });
    expect(JSON.stringify(fields)).not.toContain(sensitiveValue);
    expect(fields).not.toHaveProperty('message');
    expect(fields).not.toHaveProperty('stack');
  });

  it('code é null quando o erro não tem .code (erro comum de JS)', () => {
    const err = new TypeError('boom');
    expect(safeErrorFields(err)).toEqual({ errorName: 'TypeError', code: null });
  });

  it('lida com valor não-Error lançado (string, objeto solto)', () => {
    expect(safeErrorFields('string lançada como erro')).toEqual({ errorName: 'string', code: null });
    expect(safeErrorFields({ code: 'X1' })).toEqual({ errorName: 'object', code: 'X1' });
    expect(safeErrorFields(null)).toEqual({ errorName: 'object', code: null });
    expect(safeErrorFields(undefined)).toEqual({ errorName: 'undefined', code: null });
  });
});
