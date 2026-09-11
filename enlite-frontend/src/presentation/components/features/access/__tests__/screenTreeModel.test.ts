import { describe, it, expect } from 'vitest';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';
import type { ScreenDef } from '@presentation/config/screenRegistry';
import { celulasForaDasTelas, filtraBlocosPorTexto, montaBlocosPorTela, ROTULOS_CRUS } from '../screenTreeModel';

const cell = (resource: string, action: string, category = 'Pacientes') => ({ resource, action, category, ownerService: 'wf' });
const CATALOG: CatalogCategory[] = [
  { category: 'Pacientes', cells: [cell('patient', 'read'), cell('patient', 'write'), cell('patient_family', 'read'), cell('patient_family', 'write')] },
  { category: 'Operações', cells: [cell('dedup', 'read', 'Operações'), cell('dedup', 'execute', 'Operações'), cell('upload', 'write', 'Importação')] },
];
const REGISTRY: ScreenDef[] = [
  { id: 'patients.list', route: '/admin/patients', cells: ['patient:read', 'patient:write'] },
  {
    id: 'patients.detail', route: '/admin/patients/:id', tabs: ['a'],
    cells: ['patient:read'],
    containers: [{ id: 'family', resource: 'patient_family', tabs: ['a'], cells: ['patient_family:read', 'patient_family:write'] }],
  },
  { id: 'fantasma', route: '/admin/x', cells: ['inventada:read'] },
];

describe('montaBlocosPorTela', () => {
  const blocos = montaBlocosPorTela(CATALOG, ROTULOS_CRUS, REGISTRY);

  it('um bloco por tela, na ordem do registro; tela cujas células o back não tem NÃO vira bloco', () => {
    expect(blocos.map((b) => b.category)).toEqual(['patients.list', 'patients.detail', '__outras__']);
  });

  it('container vira linha rotulada pelo container; ação da própria tela vira linha do recurso', () => {
    const detalhe = blocos[1];
    expect(detalhe.grade.map((l) => [l.rotulo, l.resource, Object.keys(l.porAcao).sort()])).toEqual([
      ['family', 'patient_family', ['read', 'write']],
      ['patient', 'patient', ['read']],
    ]);
    // colunas = só as ações que ESTA tela usa (+ as básicas), nunca `execute`
    expect(detalhe.colunas).toEqual(['read', 'write', 'delete']);
  });

  it('célula compartilhada: a linha diz em que OUTRAS telas ela aparece — é uma só', () => {
    const lista = blocos[0].grade.find((l) => l.resource === 'patient')!;
    expect(lista.tambemEm).toEqual(['patients.detail']);
    expect(lista.nota).toBe('patients.detail');
    const detalhe = blocos[1].grade.find((l) => l.resource === 'patient')!;
    expect(detalhe.tambemEm).toEqual(['patients.list']);
    // a de familiares só existe no detalhe: sem nota
    expect(blocos[1].grade.find((l) => l.resource === 'patient_family')!.nota).toBeUndefined();
  });

  it('o que nenhuma tela lista cai em "Outras células", por recurso, sem sumir', () => {
    const outras = blocos[2];
    expect(outras.outras).toBe(true);
    expect(outras.grade.map((l) => [l.resource, Object.keys(l.porAcao).sort()])).toEqual([
      ['dedup', ['execute', 'read']],
      ['upload', ['write']],
    ]);
    expect(celulasForaDasTelas(CATALOG, REGISTRY)).toEqual(['dedup:execute', 'dedup:read', 'upload:write']);
  });

  it('célula do registro que o back não conhece NÃO desenha caixa (e não vira bloco)', () => {
    expect(blocos.some((b) => b.category === 'fantasma')).toBe(false);
  });

  it('catálogo que cobre todas as telas: sem bloco "Outras"', () => {
    const so = montaBlocosPorTela([CATALOG[0]], ROTULOS_CRUS, REGISTRY);
    expect(so.map((b) => b.category)).toEqual(['patients.list', 'patients.detail']);
  });

  it('os rótulos vêm por injeção (o modelo não sabe i18n)', () => {
    const b = montaBlocosPorTela(CATALOG, {
      tela: (id) => `T:${id}`, container: (s, c) => `C:${s}/${c}`, recurso: (r) => `R:${r}`,
      tambemEm: (t) => `também em ${t.join('+')}`, outras: 'RESTO',
    }, REGISTRY);
    expect(b[0].rotulo).toBe('T:patients.list');
    expect(b[1].grade[0].rotulo).toBe('C:patients.detail/family');
    expect(b[0].grade[0].nota).toBe('também em T:patients.detail');
    expect(b[2].rotulo).toBe('RESTO');
  });
});

describe('filtraBlocosPorTexto (US-21, FR-720 — busca da tela de permissões)', () => {
  // Rótulos próximos do real, para o caso "buscar 'familia' → só as células de família" (contrato).
  const rotulos = {
    tela: (id: string) => (id === 'patients.detail' ? 'Pacientes: Detalles' : id),
    container: (_s: string, c: string) => (c === 'family' ? 'Familiares' : c),
    recurso: (r: string) => r,
    tambemEm: (t: readonly string[]) => t.join(', '),
    outras: 'Otras',
  };
  const blocos = montaBlocosPorTela(CATALOG, rotulos, REGISTRY);

  it('sem query devolve tudo, intacto', () => {
    expect(filtraBlocosPorTexto(blocos, '')).toEqual(blocos);
  });

  it('busca por rótulo da LINHA (container) filtra só a linha que bate, dentro do bloco certo', () => {
    const filtrado = filtraBlocosPorTexto(blocos, 'familia');
    expect(filtrado.map((b) => b.category)).toEqual(['patients.detail']);
    expect(filtrado[0].grade.map((l) => l.resource)).toEqual(['patient_family']);
  });

  it('busca por CHAVE TÉCNICA (recurso:ação) também casa, mesmo sem bater o rótulo', () => {
    const filtrado = filtraBlocosPorTexto(blocos, 'patient_family:write');
    expect(filtrado).toHaveLength(1);
    expect(filtrado[0].grade.map((l) => l.resource)).toEqual(['patient_family']);
  });

  it('busca pelo rótulo da TELA mostra TODAS as linhas dela — não só a que bateu no nome', () => {
    const filtrado = filtraBlocosPorTexto(blocos, 'Detalles');
    expect(filtrado).toHaveLength(1);
    expect(filtrado[0].grade.map((l) => l.resource).sort()).toEqual(['patient', 'patient_family']);
  });

  it('busca sem nenhum resultado devolve lista VAZIA — é a tela quem mostra a mensagem', () => {
    expect(filtraBlocosPorTexto(blocos, 'nada-disso-existe-no-catalogo')).toEqual([]);
  });

  it('case-insensitive e ignora espaço nas pontas', () => {
    expect(filtraBlocosPorTexto(blocos, '  FAMILIA  ').map((b) => b.category)).toEqual(['patients.detail']);
  });

  it('🔒 não muda os objetos de entrada — a página decide o que MARCAR, isto só decide o que MOSTRAR', () => {
    const antes = JSON.parse(JSON.stringify(blocos));
    filtraBlocosPorTexto(blocos, 'familia');
    expect(blocos).toEqual(antes);
  });

  // Achado do gate `revisao-pr` (D209): 32 dos 96 rótulos reais do painel têm
  // diacrítico ("Gestión a la Vista", "Mensajería", "Dirección", "Diagnóstico",
  // "Preselección", "Números clave", "Analítica", "Importación"…) — digitar
  // sem acento (o que qualquer teclado ES-AR sem morto faz) tinha que achar
  // "nenhum resultado" para permissão que existe. `normalizeText` (o MESMO
  // util do `SearchableSelect`) fecha isso.
  it('🔒 "gestion" (sem acento) bate rótulo de TELA "Gestión a la Vista"', () => {
    const comAcento = montaBlocosPorTela(CATALOG, {
      ...rotulos,
      tela: (id) => (id === 'patients.list' ? 'Gestión a la Vista' : rotulos.tela(id)),
    }, REGISTRY);
    const filtrado = filtraBlocosPorTexto(comAcento, 'gestion');
    expect(filtrado.map((b) => b.category)).toEqual(['patients.list']);
  });

  it('🔒 "mensajeria" (sem acento) bate rótulo de LINHA "Mensajería"', () => {
    const comAcento = montaBlocosPorTela(CATALOG, {
      ...rotulos,
      recurso: (r) => (r === 'dedup' ? 'Mensajería' : rotulos.recurso(r)),
    }, REGISTRY);
    const filtrado = filtraBlocosPorTexto(comAcento, 'mensajeria');
    expect(filtrado.some((b) => b.grade.some((l) => l.resource === 'dedup'))).toBe(true);
  });
});
