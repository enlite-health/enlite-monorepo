/**
 * T107 (change 091, CA-4): teste de atualização. Se alguém trocar a planilha, o JSON ou a 587 sem regenerar,
 * este teste reprova: xlsx -> JSON = commitado; JSON -> SQL = commitado.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { readWorkbook, normalize, renderSql } from '../therapeutic-catalog/generateCidCatalog';
import type { CatalogoNormalizado } from '../therapeutic-catalog/generateCidCatalog';

const DIR = path.resolve(__dirname, '../therapeutic-catalog');
const XLSX_PATH = path.join(DIR, 'fonte/Catalogo_objetivos_actividades_por_diagnostico_CIE11.xlsx');
const JSON_PATH = path.join(DIR, 'catalogo-cid.normalizado.json');
const SQL_PATH = path.resolve(__dirname, '../../migrations/587_carga_catalogo_terapeutico_cid.sql');

describe('catálogo por CID: JSON e 587 commitados = gerados da planilha', () => {
  const buf = fs.readFileSync(XLSX_PATH);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const arquivo = path.basename(XLSX_PATH);
  const commitado = fs.readFileSync(JSON_PATH, 'utf8');

  it('xlsx -> JSON: regenerar da planilha dá exatamente o JSON commitado', () => {
    const gerado = JSON.stringify(normalize(readWorkbook(buf), { arquivo, sha256 }), null, 2) + '\n';
    expect(gerado === commitado).toBe(true);
  });

  it('JSON -> SQL: renderizar o JSON commitado dá exatamente a 587 commitada', () => {
    const cat = JSON.parse(commitado) as CatalogoNormalizado;
    expect(renderSql(cat) === fs.readFileSync(SQL_PATH, 'utf8')).toBe(true);
  });

  it('o JSON aponta para a planilha versionada (sha256) e traz os números da carga', () => {
    const cat = JSON.parse(commitado) as CatalogoNormalizado;
    expect(cat.fonte).toEqual({ arquivo, sha256 });
    expect(cat.objetivos).toHaveLength(128);
    expect(cat.atividades).toHaveLength(254);
  });
});
