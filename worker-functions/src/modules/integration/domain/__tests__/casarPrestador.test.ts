import { casarPrestador } from '../casarPrestador';
import { normalizarDocumento } from '../normalizacaoDeCasamento';

describe('casarPrestador', () => {
  it('normaliza documento igual quando muda so a pontuacao', () => {
    expect(normalizarDocumento('12.345.678')).toBe(normalizarDocumento('12345678'));
  });

  it('normaliza documento diferente quando ha zero a esquerda', () => {
    expect(normalizarDocumento('012345678')).not.toBe(normalizarDocumento('12345678'));
  });

  it('devolve nenhum quando nada casa', () => {
    const worker = {
      documento: '11111111',
      telefone: '+54 11 1111 1111',
      email: 'uno.exemplo' + '@' + 'example.test',
      nome: 'Ana Uno',
    };
    const enfermeiras = [
      {
        id: 401,
        cedula_ciudadania: '99999999',
        telefono: '+54 11 9999 9999',
        email: 'beatriz@example.test',
        nombre: 'Beatriz Nueve',
      },
      {
        id: 402,
        cedula_ciudadania: '88888888',
        telefono: '+54 11 8888 8888',
        email: 'carla@example.test',
        nombre: 'Carla Ocho',
      },
    ];
    const resultado = casarPrestador(worker, enfermeiras);
    expect(resultado).toEqual({ tipo: 'nenhum' });
  });

  it('devolve unico quando documento e telefone apontam para a mesma enfermeira', () => {
    const worker = {
      documento: '11111111',
      telefone: '+54 11 1111 1111',
      email: 'uno.exemplo@example.test',
      nome: 'Ana Uno',
    };
    const enfermeiras = [
      {
        id: 501,
        cedula_ciudadania: '11111111',
        telefono: '+54 11 1111 1111',
        email: 'ana@example.test',
        nombre: 'Ana Uno',
      },
    ];
    const resultado = casarPrestador(worker, enfermeiras);
    if (resultado.tipo !== 'unico') throw new Error('tipo inesperado: ' + resultado.tipo);
    expect(resultado.nurseId).toBe(501);
    expect(resultado.criterios).toContain('documento');
    expect(resultado.criterios).toContain('telefone_nome');
  });

  it('devolve ambiguo com motivo multiplos-no-criterio quando o telefone casa com duas enfermeiras', () => {
    const worker = {
      documento: '11111111',
      telefone: '+54 11 1111 1111',
      email: 'uno.exemplo@example.test',
      nome: 'Ana Uno',
    };
    const enfermeiras = [
      {
        id: 601,
        cedula_ciudadania: null,
        telefono: '+54 11 1111 1111',
        email: 'ana601@example.test',
        nombre: 'Ana Uno',
      },
      {
        id: 602,
        cedula_ciudadania: null,
        telefono: '+54 11 1111 1111',
        email: 'ana602@example.test',
        nombre: 'Ana Uno',
      },
    ];
    const resultado = casarPrestador(worker, enfermeiras);
    if (resultado.tipo !== 'ambiguo') throw new Error('tipo inesperado: ' + resultado.tipo);
    expect(resultado.motivo).toBe('multiplos-no-criterio');
    expect(resultado.candidatos).toContain(601);
    expect(resultado.candidatos).toContain(602);
  });

  it('devolve ambiguo com motivo criterios-discordam quando telefone aponta para uma e documento para outra', () => {
    const worker = {
      documento: '11111111',
      telefone: '+54 11 1111 1111',
      email: 'uno.exemplo@example.test',
      nome: 'Ana Uno',
    };
    const enfermeiras = [
      {
        id: 701,
        cedula_ciudadania: '22222222',
        telefono: '+54 11 1111 1111',
        email: 'ana701@example.test',
        nombre: 'Ana Uno',
      },
      {
        id: 702,
        cedula_ciudadania: '11111111',
        telefono: '+54 11 3333 3333',
        email: 'zulema@example.test',
        nombre: 'Zulema Dos',
      },
    ];
    const resultado = casarPrestador(worker, enfermeiras);
    if (resultado.tipo !== 'ambiguo') throw new Error('tipo inesperado: ' + resultado.tipo);
    expect(resultado.motivo).toBe('criterios-discordam');
    expect(resultado.candidatos).toContain(701);
    expect(resultado.candidatos).toContain(702);
    expect(resultado).not.toHaveProperty('nurseId');
  });
});
