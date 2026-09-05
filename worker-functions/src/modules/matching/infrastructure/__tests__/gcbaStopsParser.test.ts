/**
 * gcbaStopsParser.test.ts
 *
 * ⚠️ As linhas do CSV aqui são REAIS — copiadas do arquivo publicado pelo GCBA
 * em 05/09/2026 (`paradas-de-colectivo.csv`, `Last-Modified: 28/10/2024`), não
 * escritas por mim. Fixture que eu invento confirma a MINHA suposição sobre o
 * formato; foi assim que a `fid=190` entrou no arquivo: ela tem VÍRGULAS DENTRO
 * do campo `DIRECCION` (`"3083 CHUTRO, PEDRO, PROF., DR."`), que é exatamente o
 * caso que um `split(',')` ingênuo quebra — e que eu não teria inventado.
 */
import { parseGcbaStops, parseCoordinate, splitCsvLine, isPlausibleCoordinate } from '../gcbaStopsParser';

const HEADER = 'fid,CALLE,ALT PLANO,DIRECCION,coord_X,coord_Y,COMUNA,BARRIO,L1,l1_sen,L2,l2_sen,L3,l3_sen,L4,l4_sen,L5,l5_sen,L6,l6_sen';
// Reais, verbatim:
const FID_1 = '1,DEFENSA,"1524",1524 DEFENSA,"-58,3709946","-34,62565880","1",SAN TELMO,"22",V,"53",I,,,,,,,,';
const FID_84 = '84,CABILDO AV.,"5070",5070 CABILDO AV.,"-58,4760952","-34,53894170","12",SAAVEDRA,"59",V,"71",V,"151",V,"152",V,,,,';
// Real e DEFEITUOSA: a fonte publica a longitude sem separador decimal.
const FID_4412 = '4412,ASAMBLEA AV.,"1493",1493 ASAMBLEA AV.,"-583445535","-34,63657000","7",PARQUE CHACABUCO,"4",V,,,,,,,,,,';
const FID_190 = '190,DR. PROF. PEDRO CHUTRO,"3083","3083 CHUTRO, PEDRO, PROF., DR.","-58,4057742","-34,64219780","4",PARQUE PATRICIOS,"91",I,"150",I,,,,,,,,';

const csv = (...rows: string[]): string => [HEADER, ...rows].join('\n');

describe('gcbaStopsParser', () => {
  describe('parseCoordinate', () => {
    it('a fonte usa VÍRGULA decimal entre aspas — um parseFloat direto erra 40 km em silêncio', () => {
      expect(parseCoordinate('"-58,3709946"')).toBeCloseTo(-58.3709946, 7);
      expect(parseCoordinate('"-34,62565880"')).toBeCloseTo(-34.6256588, 7);
      // a prova de que a armadilha é real:
      expect(parseFloat('-58,3709946')).toBe(-58);
    });

    it('devolve null para vazio, lixo e ausente — nunca NaN escondido', () => {
      expect(parseCoordinate('')).toBeNull();
      expect(parseCoordinate('   ')).toBeNull();
      expect(parseCoordinate('""')).toBeNull();
      expect(parseCoordinate('sin dato')).toBeNull();
      expect(parseCoordinate(undefined)).toBeNull();
    });

    it('aceita ponto decimal também — a fonte pode normalizar sem avisar', () => {
      expect(parseCoordinate('-58.37')).toBeCloseTo(-58.37, 2);
    });
  });

  describe('splitCsvLine', () => {
    it('respeita vírgula DENTRO de aspas (o caso real da fid=190)', () => {
      const cols = splitCsvLine(FID_190);
      expect(cols[0]).toBe('190');
      expect(cols[3]).toBe('3083 CHUTRO, PEDRO, PROF., DR.');
      expect(cols[4]).toBe('-58,4057742');
      expect(cols[7]).toBe('PARQUE PATRICIOS');
    });

    it('aspa escapada (`""`) vira uma aspa literal', () => {
      expect(splitCsvLine('a,"di""cho",b')).toEqual(['a', 'di"cho', 'b']);
    });

    it('campo vazio no fim não some', () => {
      expect(splitCsvLine('a,b,,')).toEqual(['a', 'b', '', '']);
    });
  });

  describe('isPlausibleCoordinate', () => {
    it('aceita a faixa do planeta e recusa o que estourou o separador decimal', () => {
      expect(isPlausibleCoordinate(-34.6, -58.4)).toBe(true);
      expect(isPlausibleCoordinate(-90, -180)).toBe(true);
      expect(isPlausibleCoordinate(90, 180)).toBe(true);
      expect(isPlausibleCoordinate(-34.63657, -583445535)).toBe(false);
      expect(isPlausibleCoordinate(-91, 0)).toBe(false);
      expect(isPlausibleCoordinate(91, 0)).toBe(false);
      expect(isPlausibleCoordinate(0, 181)).toBe(false);
    });
  });

  describe('parseGcbaStops', () => {
    it('lê uma parada real: coordenada, nome com bairro e as linhas', () => {
      const { stops, skipped } = parseGcbaStops(csv(FID_1));
      expect(stops).toHaveLength(1);
      expect(stops[0]).toEqual({
        externalId: '1',
        name: '1524 DEFENSA · SAN TELMO',
        latitude: -34.6256588,
        longitude: -58.3709946,
        lines: ['22', '53'],
      });
      expect(skipped).toEqual({ semCoordenada: 0, foraDeFaixa: 0, semLinha: 0, semId: 0 });
    });

    it('junta as até SEIS colunas de linha, sem repetir', () => {
      const { stops } = parseGcbaStops(csv(FID_84));
      expect(stops[0].lines).toEqual(['59', '71', '151', '152']);
    });

    it('o nome preserva a vírgula do endereço real', () => {
      const { stops } = parseGcbaStops(csv(FID_190));
      expect(stops[0].name).toBe('3083 CHUTRO, PEDRO, PROF., DR. · PARQUE PATRICIOS');
      expect(stops[0].lines).toEqual(['91', '150']);
    });

    it('descarta e CONTA o que não serve — parada sem linha não responde corredor nenhum', () => {
      const semLinha = '999,X,"1",1 X,"-58,4","-34,6","1",BARRIO,,,,,,,,,,,,';
      const semCoord = '998,X,"1",1 X,"","","1",BARRIO,"8",I,,,,,,,,,,';
      const semId = ',X,"1",1 X,"-58,4","-34,6","1",BARRIO,"8",I,,,,,,,,,,';
      const { stops, skipped } = parseGcbaStops(csv(FID_1, semLinha, semCoord, semId));
      expect(stops).toHaveLength(1);
      // contagem ZERO seria "não olhei"; aqui cada descarte é nomeado
      expect(skipped).toEqual({ semCoordenada: 1, foraDeFaixa: 0, semLinha: 1, semId: 1 });
    });

    it('CSV vazio ou só com cabeçalho devolve nada, sem estourar', () => {
      expect(parseGcbaStops('')).toEqual({ stops: [], skipped: { semCoordenada: 0, foraDeFaixa: 0, semLinha: 0, semId: 0 } });
      expect(parseGcbaStops(HEADER).stops).toEqual([]);
    });

    it('tolera BOM no cabeçalho e CRLF nas linhas (o arquivo vem de um export Windows)', () => {
      const { stops } = parseGcbaStops(`﻿${HEADER}\r\n${FID_1}\r\n`);
      expect(stops).toHaveLength(1);
      expect(stops[0].externalId).toBe('1');
    });

    it('coluna ausente no cabeçalho não derruba o parser (a fonte pode mudar)', () => {
      const semBarrio = 'fid,DIRECCION,coord_X,coord_Y,L1';
      const { stops } = parseGcbaStops(`${semBarrio}\n7,7 ALGUNA,"-58,4","-34,6","8"`);
      expect(stops[0]).toMatchObject({ externalId: '7', name: '7 ALGUNA', lines: ['8'] });
    });

    it('DEFEITO REAL DA FONTE: a fid=4412 publica longitude -583445535 e é DESCARTADA, não corrigida', () => {
      const { stops, skipped } = parseGcbaStops(csv(FID_1, FID_4412));
      // a boa entra, a defeituosa não — e o descarte é CONTADO, não silencioso
      expect(stops.map((s) => s.externalId)).toEqual(['1']);
      expect(skipped.foraDeFaixa).toBe(1);
      // e ninguém "consertou" o valor para -58.3445535: isso seria dado inventado
      expect(stops.find((s) => s.externalId === '4412')).toBeUndefined();
    });

    it('linha TRUNCADA (menos colunas que o cabeçalho) não estoura — cai como sem coordenada', () => {
      // Export interrompido: a linha existe, o cabeçalho promete 20 colunas e
      // chegaram 3. Sem a guarda isto seria um TypeError no meio da carga.
      const { stops, skipped } = parseGcbaStops(csv('55,ALGUNA CALLE,"100"'));
      expect(stops).toEqual([]);
      expect(skipped.semCoordenada).toBe(1);
    });

    it('sem DIRECCION nem BARRIO o nome cai no id — nunca fica vazio na tela', () => {
      const { stops } = parseGcbaStops(`fid,coord_X,coord_Y,L1\n42,"-58,4","-34,6","8"`);
      expect(stops[0].name).toBe('Parada 42');
    });
  });
});
