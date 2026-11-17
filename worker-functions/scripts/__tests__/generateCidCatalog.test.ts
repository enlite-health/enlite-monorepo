/**
 * T105 (change 091): gerador do catálogo por CID. Planilha mínima montada em memória com `xlsx.utils`
 * (sem texto clínico: títulos sintéticos). Cada erro nomeado de §9.3 tem um caso.
 */
import fs from 'fs';
import path from 'path';
import * as XLSX from 'xlsx';
import {
  readWorkbook, normalize, renderSql, SERVICOS,
  UnknownServiceError, InvalidCategoryError, UnknownObjectiveError, ObjectiveFieldConflictError,
  ActivityFrequencyConflictError, ActivityCategoryOutsideObjectiveError, KeyCollisionError, MissingColumnError,
} from '../therapeutic-catalog/generateCidCatalog';

type Obj = { id: string; svc?: string; cat?: string; t?: string; d?: string; p?: string; e?: string; i?: string };
type Atv = { id: string; svc?: string; cat?: string; t?: string; d?: string; obj: string; f?: string; e?: string };

const HDR_OBJ = ['ID', 'Tipo de servicio', 'Código CIE-11', 'Diagnóstico', 'Título', 'Descripción',
  'Pregunta del registro diario (EnLite)', 'Escala del registro diario (EnLite)', 'Indicador operativo (EnLite)'];
const HDR_ATV = ['ID', 'Tipo de servicio', 'Código CIE-11', 'Diagnóstico', 'Título', 'Descripción', 'ID objetivo',
  'Objetivo relacionado', 'Frecuencia sugerida', 'Escala del registro diario (EnLite)'];

const o = (x: Obj) => [x.id, x.svc ?? 'AT', x.cat ?? '2A00', 'dx', x.t ?? 'Obj A', x.d ?? 'Desc A', x.p ?? 'P?', x.e ?? 'E1', x.i ?? 'I1'];
const a = (x: Atv) => [x.id, x.svc ?? 'AT', x.cat ?? '2A00', 'dx', x.t ?? 'Act A', x.d ?? 'Desc act', x.obj, 'rel', x.f ?? 'Diaria', x.e ?? 'E2'];

function livro(objs: Obj[], atvs: Atv[], hdrObj = HDR_OBJ): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([hdrObj, ...objs.map(o)]), 'Objetivos específicos');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HDR_ATV, ...atvs.map(a)]), 'Actividades de rutina');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
const gerar = (objs: Obj[], atvs: Atv[]) => normalize(readWorkbook(livro(objs, atvs)));

const OBJS: Obj[] = [{ id: '2A00-AT-O1' }, { id: '2A01-AT-O3', cat: '2A01' }];
const ATVS: Atv[] = [{ id: '2A00-AT-A1', obj: '2A00-AT-O1' }, { id: '2A01-AT-A2', cat: '2A01', obj: '2A01-AT-O3' }];

describe('generateCidCatalog', () => {
  it('caminho feliz: junta linhas do mesmo objetivo, ordem = n do ID por categoria', () => {
    const cat = gerar(OBJS, ATVS);
    expect(cat.objetivos).toHaveLength(1);
    expect(cat.objetivos[0].categorias).toEqual([{ codigo: '2A00', ordem: 1 }, { codigo: '2A01', ordem: 3 }]);
    expect(cat.atividades).toHaveLength(1);
    expect(cat.atividades[0].objetivoId).toBe(cat.objetivos[0].id);
    expect(cat.servicos).toEqual(SERVICOS);
  });

  it('lê colunas pelo cabeçalho, não pela posição', () => {
    const embaralhado = [...HDR_OBJ].reverse();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([embaralhado, ...OBJS.map(o).map((r) => [...r].reverse())]), 'Objetivos específicos');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HDR_ATV, ...ATVS.map(a)]), 'Actividades de rutina');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    expect(normalize(readWorkbook(buf))).toEqual(gerar(OBJS, ATVS));
  });

  it('coluna ausente lança MissingColumnError', () => {
    expect(() => readWorkbook(livro(OBJS, ATVS, HDR_OBJ.filter((h) => h !== 'Título')))).toThrow(MissingColumnError);
  });

  it('faz trim em toda célula', () => {
    const cat = gerar([{ id: '2A00-AT-O1', t: '  Obj A  ' }], [{ id: '2A00-AT-A1', obj: '2A00-AT-O1' }]);
    expect(cat.objetivos[0].titulo).toBe('Obj A');
  });

  it('UUID v5 estável: mesma chave -> mesmo id em 2 chamadas; texto diferente -> id diferente', () => {
    const x = gerar(OBJS, ATVS);
    const y = gerar(OBJS, ATVS);
    expect(y.objetivos[0].id).toBe(x.objetivos[0].id);
    expect(y.atividades[0].id).toBe(x.atividades[0].id);
    expect(x.objetivos[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const z = gerar([{ id: '2A00-AT-O1', t: 'Obj B' }], [{ id: '2A00-AT-A1', obj: '2A00-AT-O1' }]);
    expect(z.objetivos[0].id).not.toBe(x.objetivos[0].id);
  });

  describe('erros nomeados de §9.3', () => {
    it('serviço fora de {AT, Cuidado}', () => {
      expect(() => gerar([{ id: '2A00-AT-O1', svc: 'Otro' }], [])).toThrow(UnknownServiceError);
    });
    it('categoria fora de ^[0-9A-Z]{4}$', () => {
      expect(() => gerar([{ id: '2A00-AT-O1', cat: '2a0' }], [])).toThrow(InvalidCategoryError);
      expect(() => gerar([{ id: '2A00-AT-O1', cat: '2A00.1' }], [])).toThrow(InvalidCategoryError);
    });
    it('atividade com ID objetivo inexistente', () => {
      expect(() => gerar(OBJS, [{ id: '2A00-AT-A1', obj: '2A00-AT-O99' }])).toThrow(UnknownObjectiveError);
    });
    it('pregunta/escala/indicador variando para o mesmo objetivo', () => {
      for (const campo of [{ p: 'outra' }, { e: 'outra' }, { i: 'outro' }]) {
        expect(() => gerar([{ id: '2A00-AT-O1' }, { id: '2A01-AT-O1', cat: '2A01', ...campo }], [])).toThrow(ObjectiveFieldConflictError);
      }
    });
    it('frecuencia variando para a mesma atividade', () => {
      expect(() => gerar(OBJS, [
        { id: '2A00-AT-A1', obj: '2A00-AT-O1', f: 'Diaria' },
        { id: '2A01-AT-A1', cat: '2A01', obj: '2A01-AT-O3', f: 'Semanal' },
      ])).toThrow(ActivityFrequencyConflictError);
    });
    it('categoria da atividade fora das do objetivo', () => {
      expect(() => gerar(OBJS, [{ id: '2A09-AT-A1', cat: '2A09', obj: '2A00-AT-O1' }])).toThrow(ActivityCategoryOutsideObjectiveError);
    });
    it('lower(btrim()) colapsando duas chaves distintas (DD-1)', () => {
      expect(() => gerar([{ id: '2A00-AT-O1', t: 'Obj A' }, { id: '2A00-AT-O2', t: 'OBJ a' }], [])).toThrow(KeyCollisionError);
    });
  });

  describe('renderSql', () => {
    const cat = normalize(readWorkbook(livro(OBJS, ATVS)), { arquivo: 'x.xlsx', sha256: 'abc' });
    const sql = renderSql(cat);
    it('cabeçalho, idempotência e created_by seed:587', () => {
      expect(sql).toContain('-- GERADO por scripts/therapeutic-catalog/generateCidCatalog.ts — não editar à mão; fonte sha256 abc');
      expect(sql).toMatch(/md5 vínculos objetivo.*: [0-9a-f]{32}/);
      expect(sql).toMatch(/md5 vínculos atividade.*: [0-9a-f]{32}/);
      expect(sql).toContain('ON CONFLICT (id) DO NOTHING');
      expect(sql).toContain("'seed:587'");
      expect(sql).not.toMatch(/sort_order\) VALUES|, sort_order, created_by, updated_by/);
    });
    it('vínculos compactos por unnest e é determinístico', () => {
      expect(sql).toContain("ARRAY['2A00','2A01'], ARRAY[1,3]");
      expect(sql).toContain('unnest(v.codes, v.ords) AS c(code, ord)');
      expect(renderSql(cat)).toBe(sql);
    });
    it("escapa aspas simples", () => {
      const q = normalize(readWorkbook(livro([{ id: '2A00-AT-O1', t: "Obj 'A'" }], [])));
      expect(renderSql(q)).toContain("'Obj ''A'''");
    });
  });

  const FONTE = path.resolve(__dirname, '../therapeutic-catalog/fonte/Catalogo_objetivos_actividades_por_diagnostico_CIE11.xlsx');
  (fs.existsSync(FONTE) ? it : it.skip)('planilha real: números da carga (F-pl-2/3/6)', () => {
    const cat = normalize(readWorkbook(fs.readFileSync(FONTE)));
    expect(cat.objetivos).toHaveLength(128);
    expect(cat.atividades).toHaveLength(254);
    expect(cat.objetivos.reduce((n, x) => n + x.categorias.length, 0)).toBe(11910);
    expect(cat.atividades.reduce((n, x) => n + x.categorias.length, 0)).toBe(19699);
  });
});
