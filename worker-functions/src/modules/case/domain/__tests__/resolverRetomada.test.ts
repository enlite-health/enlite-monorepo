/**
 * resolverRetomada (F3, D5/D9, design §6): o destino de retomar/reativar sai das HORAS do itinerário; sem decisão → `SEARCHING`,
 * mesmo que o paciente tenha estado ACTIVE antes da pausa/baja. A função só recebe as horas (a trilha não existe para ela).
 */
import { resolverRetomada } from '../resolverRetomada';
import type { EntradaDerivacao, ServicoParaDerivar } from '../derivarEstadoPaciente';

const servico = (cobertas: number, total = 8, temVacanteViva = true): ServicoParaDerivar => ({ temVacanteViva, cobertas, total });
const horas = (servicos: ServicoParaDerivar[], montado = true, status: string | null = 'ON_HOLD'): EntradaDerivacao => ({ status, montado, servicos });

describe('resolverRetomada', () => {
  it('itinerário cobrindo todas as horas com vaga viva → ACTIVE (derivado)', () => {
    expect(resolverRetomada({ horas: horas([servico(8)]) })).toBe('ACTIVE');
  });

  it('cobertura parcial → REPLACEMENT', () => {
    expect(resolverRetomada({ horas: horas([servico(4)]) })).toBe('REPLACEMENT');
  });

  it('itinerário montado e zero horas cobertas → SEARCHING (regra de horas)', () => {
    expect(resolverRetomada({ horas: horas([servico(0)]) })).toBe('SEARCHING');
  });

  it.each([
    ['sem itinerário montado', horas([servico(8)], false)],
    ['montado mas sem vaga viva', horas([servico(8, 8, false)])],
    ['serviço vivo sem faixa vigente', horas([servico(0, 0)])],
    ['nenhum serviço', horas([])],
  ])('a regra de horas não decide (%s) → SEARCHING', (_nome, e) => {
    expect(resolverRetomada({ horas: e })).toBe('SEARCHING');
  });

  it('S1: sem itinerário → SEARCHING para QUALQUER estado de partida, inclusive quando o anterior era ACTIVE (a função não vê a trilha)', () => {
    for (const status of ['ON_HOLD', 'SUSPENDED', 'DISCHARGED']) {
      expect(resolverRetomada({ horas: horas([], false, status) })).toBe('SEARCHING');
    }
  });

  it('o estado de partida (humano) não bloqueia a regra de horas: DISCHARGED com cobertura total → ACTIVE', () => {
    expect(resolverRetomada({ horas: horas([servico(8)], true, 'DISCHARGED') })).toBe('ACTIVE');
  });
});
