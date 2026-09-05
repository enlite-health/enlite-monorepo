/**
 * transitCorridor.test.ts — a regra do corredor, sem banco.
 *
 * O que se afirma aqui é o TERRENO, não a aritmética: em Buenos Aires não há
 * terminal e baldear se paga de novo (REGRA-10), então "nenhuma linha em comum"
 * tem de sair como recusa explícita, e nunca como uma rota com transbordo
 * apresentada como se fosse equivalente.
 */
import { buildCorridor, blocks, WALK_RADIUS_METERS, BLOCK_METERS, type TransitStop } from '../transitCorridor';

const stop = (over: Partial<TransitStop> & Pick<TransitStop, 'externalId' | 'lines' | 'distanceMeters'>): TransitStop => ({
  name: `Parada ${over.externalId}`,
  mode: 'bus',
  ...over,
});

describe('transitCorridor', () => {
  describe('buildCorridor', () => {
    it('devolve as linhas que servem AS DUAS pontas, com a caminhada de cada lado', () => {
      const origem = [stop({ externalId: 'a1', lines: ['8', '24'], distanceMeters: 210, name: '459 Libertad' })];
      const destino = [stop({ externalId: 'b1', lines: ['8', '50'], distanceMeters: 90, name: '340 H. Yrigoyen' })];

      const r = buildCorridor(origem, destino);

      expect(r.outcome).toBe('ok');
      expect(r.lines).toEqual([{
        line: '8',
        mode: 'bus',
        originWalkMeters: 210,
        originStopName: '459 Libertad',
        destinationWalkMeters: 90,
        destinationStopName: '340 H. Yrigoyen',
      }]);
      // a 24 só serve a origem e a 50 só o destino: nenhuma das duas é corredor
      expect(r.lines.map((l) => l.line)).not.toContain('24');
      expect(r.lines.map((l) => l.line)).not.toContain('50');
    });

    it('para cada linha usa a parada MAIS PRÓXIMA que a serve, não a primeira da lista', () => {
      const origem = [
        stop({ externalId: 'longe', lines: ['8'], distanceMeters: 380, name: 'longe' }),
        stop({ externalId: 'perto', lines: ['8'], distanceMeters: 120, name: 'perto' }),
      ];
      const destino = [
        stop({ externalId: 'd-longe', lines: ['8'], distanceMeters: 350, name: 'd-longe' }),
        stop({ externalId: 'd-perto', lines: ['8'], distanceMeters: 60, name: 'd-perto' }),
      ];

      const r = buildCorridor(origem, destino);

      expect(r.lines[0]).toMatchObject({
        originWalkMeters: 120, originStopName: 'perto',
        destinationWalkMeters: 60, destinationStopName: 'd-perto',
      });
    });

    it('ordena pela caminhada TOTAL, e desempata pelo nome da linha (saída estável)', () => {
      const origem = [
        stop({ externalId: 'o', lines: ['24', '8', '111'], distanceMeters: 100 }),
        stop({ externalId: 'o2', lines: ['50'], distanceMeters: 300 }),
      ];
      const destino = [
        stop({ externalId: 'd', lines: ['8', '111'], distanceMeters: 100 }),
        stop({ externalId: 'd2', lines: ['24'], distanceMeters: 50 }),
        stop({ externalId: 'd3', lines: ['50'], distanceMeters: 20 }),
      ];

      const r = buildCorridor(origem, destino);

      // 24 = 150 · 8 e 111 = 200 (empate, desempata por nome) · 50 = 320
      expect(r.lines.map((l) => l.line)).toEqual(['24', '111', '8', '50']);
      // e a ordem não muda ao repetir a chamada com a entrada embaralhada
      const outra = buildCorridor([...origem].reverse(), [...destino].reverse());
      expect(outra.lines.map((l) => l.line)).toEqual(['24', '111', '8', '50']);
    });

    it('REGRA-10: sem linha em comum é RECUSA explícita, não uma rota com baldeação', () => {
      const origem = [stop({ externalId: 'a', lines: ['8'], distanceMeters: 100 })];
      const destino = [stop({ externalId: 'b', lines: ['152'], distanceMeters: 100 })];

      const r = buildCorridor(origem, destino);

      expect(r.outcome).toBe('sem_conexion_directa');
      expect(r.lines).toEqual([]);
    });

    it('sem paradas em QUALQUER das pontas é falta de cobertura — que é outra coisa', () => {
      const comParadas = [stop({ externalId: 'a', lines: ['8'], distanceMeters: 100 })];

      // A recusa por cobertura precede a por conexão: fora da CABA não há dado de
      // parada, e dizer "não há linha direta" ali afirmaria algo que não medimos.
      expect(buildCorridor([], comParadas).outcome).toBe('sem_cobertura');
      expect(buildCorridor(comParadas, []).outcome).toBe('sem_cobertura');
      expect(buildCorridor([], []).outcome).toBe('sem_cobertura');
    });

    it('parada sem nenhuma linha não inventa corredor', () => {
      const r = buildCorridor(
        [stop({ externalId: 'a', lines: [], distanceMeters: 10 })],
        [stop({ externalId: 'b', lines: [], distanceMeters: 10 })],
      );
      expect(r.outcome).toBe('sem_conexion_directa');
    });

    it('o modo vem da parada — trem e subte entram pelo mesmo caminho que colectivo', () => {
      const r = buildCorridor(
        [stop({ externalId: 'a', lines: ['Mitre'], distanceMeters: 300, mode: 'train' })],
        [stop({ externalId: 'b', lines: ['Mitre'], distanceMeters: 200, mode: 'train' })],
      );
      expect(r.lines[0]).toMatchObject({ line: 'Mitre', mode: 'train' });
    });
  });

  describe('blocks', () => {
    it('converte metros em quadras, que é a unidade em que a operação fala (REQ-19)', () => {
      expect(blocks(0)).toBe(1);      // nunca "0 quadras": há sempre uma caminhada
      expect(blocks(40)).toBe(1);
      expect(blocks(210)).toBe(2);
      expect(blocks(350)).toBe(4);
    });
  });

  it('as constantes são as que a tela e a query compartilham', () => {
    expect(WALK_RADIUS_METERS).toBe(400);
    expect(BLOCK_METERS).toBe(100);
  });
});
