/**
 * Carga PONTUAL manual do ClickUp (decisão 11/09/2026 — sem sync automático) — parsing dos
 * flags do CLI. Puro: sem rede, sem DB, sem process.exit. Prova as travas fail-safe do gate
 * revisao-pr:
 *   1. `--dry-run` presente VENCE `--apply`, sempre (nunca grava).
 *   2. `--task-id`, `--limit` e `--status` sem valor (ou seguidos de outra flag) são `ok:false`
 *      (ERRO), nunca um valor "ausente" silencioso — sem isto, digitar errado cairia muda na
 *      paginação da lista INTEIRA (task-id), em "sem limite"/"zero" (limit), ou em
 *      `statusFilter: []` lido como "sem filtro" = LISTA INTEIRA gravando (status — achado numa
 *      2ª rodada do gate, DEPOIS de task-id/limit já corrigidos: mesma classe de defeito).
 *   3. `--apply` SÓ é permitido junto de `--task-id` (parecer do lex) — carga em massa nunca
 *      grava, só criação pontual de UM paciente por vez, com autorização escrita do Gabriel.
 */
import { parseImportPatientsFlags, type ParseFlagsResult } from '../import-patients-from-clickup-flags';

function ok(r: ParseFlagsResult) {
  if (!r.ok) throw new Error(`esperava ok:true, veio erro: ${r.error}`);
  return r.flags;
}

describe('parseImportPatientsFlags — caminho feliz', () => {
  it('sem argumentos: dry-run (default) — apply=false', () => {
    expect(ok(parseImportPatientsFlags([]))).toEqual({
      apply: false, taskId: null, limit: null, statusFilter: [], verbose: false,
    });
  });

  it('--apply + --task-id: sai do dry-run', () => {
    expect(ok(parseImportPatientsFlags(['--apply', '--task-id', 'x'])).apply).toBe(true);
  });

  it('--task-id <id>: carga pontual de UMA task (substitui resync-one-clickup-task.ts)', () => {
    expect(ok(parseImportPatientsFlags(['--task-id', '86abq2pzg'])).taskId).toBe('86abq2pzg');
    expect(ok(parseImportPatientsFlags([])).taskId).toBeNull();
  });

  it('--limit N: parseia inteiro positivo; ausente = null (sem limite)', () => {
    expect(ok(parseImportPatientsFlags(['--limit', '5'])).limit).toBe(5);
    expect(ok(parseImportPatientsFlags([])).limit).toBeNull();
  });

  it('--status X,Y,Z: lista normalizada para minúsculas', () => {
    expect(ok(parseImportPatientsFlags(['--status', 'Busqueda,Activo'])).statusFilter).toEqual(['busqueda', 'activo']);
    expect(ok(parseImportPatientsFlags([])).statusFilter).toEqual([]);
  });

  it('--verbose liga o flag de log completo', () => {
    expect(ok(parseImportPatientsFlags(['--verbose'])).verbose).toBe(true);
    expect(ok(parseImportPatientsFlags([])).verbose).toBe(false);
  });

  it('combinação real de uma carga pontual: --task-id + --apply', () => {
    expect(ok(parseImportPatientsFlags(['--task-id', 'abc123', '--apply']))).toEqual({
      apply: true, taskId: 'abc123', limit: null, statusFilter: [], verbose: false,
    });
  });
});

describe('parseImportPatientsFlags — --dry-run VENCE --apply, sempre (fail-safe)', () => {
  it.each([
    [[], false],
    [['--apply', '--task-id', 'x'], true],
    [['--dry-run'], false],
    [['--dry-run', '--apply'], false],
    [['--apply', '--dry-run'], false],
  ] as ReadonlyArray<[string[], boolean]>)('%j → apply=%s', (args, esperado) => {
    expect(ok(parseImportPatientsFlags(args)).apply).toBe(esperado);
  });

  it('--dry-run sozinho não é erro — é só a mesma coisa que o default, explícita', () => {
    const r = parseImportPatientsFlags(['--dry-run']);
    expect(r.ok).toBe(true);
  });
});

describe('parseImportPatientsFlags — --task-id sem valor é ERRO, nunca "ausente"', () => {
  it('--task-id como último argumento (sem nada depois) → ok:false', () => {
    const r = parseImportPatientsFlags(['--task-id']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id seguido de OUTRA flag (esqueceu o id) → ok:false, nunca cai na paginação da lista', () => {
    const r = parseImportPatientsFlags(['--task-id', '--apply']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id com valor de verdade → ok:true', () => {
    expect(parseImportPatientsFlags(['--task-id', '86abq2pzg']).ok).toBe(true);
  });
});

describe('parseImportPatientsFlags — --limit não numérico ou ≤ 0 é ERRO, nunca "sem limite"', () => {
  it.each([
    ['--limit', 'abc'],
    ['--limit', '0'],
    ['--limit', '-5'],
    ['--limit', '3.5'],
  ])('%s %s → ok:false', (flag, value) => {
    const r = parseImportPatientsFlags([flag, value]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--limit/);
  });

  it('--limit como último argumento (sem valor) → ok:false', () => {
    const r = parseImportPatientsFlags(['--limit']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--limit/);
  });

  it('--limit seguido de outra flag → ok:false', () => {
    const r = parseImportPatientsFlags(['--limit', '--apply']);
    expect(r.ok).toBe(false);
  });

  it('--limit 1 (positivo, inteiro) → ok:true, limit=1', () => {
    const r = parseImportPatientsFlags(['--limit', '1']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.limit).toBe(1);
  });
});

describe('parseImportPatientsFlags — --status sem valor é ERRO, nunca "sem filtro" (2ª rodada do gate)', () => {
  it('--status como último argumento (sem nada depois) → ok:false', () => {
    const r = parseImportPatientsFlags(['--status']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--status/);
  });

  it('--apply --status (esqueceu o valor) → ok:false, NUNCA grava a lista inteira', () => {
    // Este é o caso exato que o gate achou: sem a guarda, isto virava
    // { ok: true, flags: { apply: true, statusFilter: [] } } — "sem filtro" = TODOS os
    // pacientes da lista, com --apply ligado.
    const r = parseImportPatientsFlags(['--apply', '--status']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--status/);
  });

  it('--status seguido de OUTRA flag → ok:false', () => {
    const r = parseImportPatientsFlags(['--status', '--verbose']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--status/);
  });

  it('--status com valor de verdade → ok:true, lista normalizada para minúsculas', () => {
    const r = parseImportPatientsFlags(['--status', 'Busqueda,Activo']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.statusFilter).toEqual(['busqueda', 'activo']);
  });
});

describe('parseImportPatientsFlags — --apply SÓ com --task-id (parecer do lex): carga em massa nunca grava', () => {
  it('--apply sozinho (sem --task-id) → ok:false — nunca "processa a lista inteira"', () => {
    const r = parseImportPatientsFlags(['--apply']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--apply --limit N (sem --task-id) → ok:false — filtro/limite não substitui a exigência', () => {
    const r = parseImportPatientsFlags(['--apply', '--limit', '5']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--apply --status busqueda (sem --task-id) → ok:false', () => {
    const r = parseImportPatientsFlags(['--apply', '--status', 'busqueda']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--apply + --task-id → ok:true (a única combinação que grava)', () => {
    const r = parseImportPatientsFlags(['--apply', '--task-id', '86abq2pzg']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.apply).toBe(true);
  });

  it('--dry-run + --apply (sem --task-id) → ok:true, apply=false — --dry-run já venceu antes desta trava rodar', () => {
    const r = parseImportPatientsFlags(['--dry-run', '--apply']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.flags.apply).toBe(false);
  });
});

describe('parseImportPatientsFlags — --task-id "" (vazio/só espaço) é ERRO (achado do gate, 4ª rodada)', () => {
  it('--task-id "" (string vazia) → ok:false — nunca vira GET /task/ real', () => {
    const r = parseImportPatientsFlags(['--task-id', '']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id "   " (só espaço) → ok:false', () => {
    const r = parseImportPatientsFlags(['--task-id', '   ']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id com espaço nas pontas mas conteúdo de verdade → ok:true (não é o mesmo caso)', () => {
    const r = parseImportPatientsFlags(['--task-id', ' 86abq2pzg ']);
    expect(r.ok).toBe(true);
  });
});

describe('parseImportPatientsFlags — --task-id NÃO pode ser combinado com --limit/--status (achado do gate, 4ª rodada)', () => {
  it('--task-id + --limit → ok:false, nunca ignora um dos dois em silêncio', () => {
    const r = parseImportPatientsFlags(['--task-id', 'abc', '--limit', '5']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id + --status → ok:false', () => {
    const r = parseImportPatientsFlags(['--task-id', 'abc', '--status', 'busqueda']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/--task-id/);
  });

  it('--task-id + --apply + --limit → ok:false (a incompatibilidade vale mesmo com --apply presente)', () => {
    const r = parseImportPatientsFlags(['--task-id', 'abc', '--apply', '--limit', '5']);
    expect(r.ok).toBe(false);
  });

  it('--task-id sozinho (sem --limit/--status) → ok:true — a trava não reprova o caso normal', () => {
    const r = parseImportPatientsFlags(['--task-id', 'abc']);
    expect(r.ok).toBe(true);
  });
});
