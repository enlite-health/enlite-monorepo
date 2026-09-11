/**
 * Carga PONTUAL manual do ClickUp (decisão 11/09/2026 — sem sync automático) — parsing dos
 * flags do CLI. Puro: sem rede, sem DB, sem process.exit. Prova que `--apply` é a ÚNICA
 * combinação que sai do dry-run (gate 5 da remoção do sync automático).
 */
import { parseImportPatientsFlags } from '../import-patients-from-clickup-flags';

describe('parseImportPatientsFlags', () => {
  it('sem argumentos: dry-run (default) — apply=false', () => {
    expect(parseImportPatientsFlags([])).toEqual({
      apply: false, taskId: null, limit: null, statusFilter: [], verbose: false,
    });
  });

  it('--apply: sai do dry-run', () => {
    const flags = parseImportPatientsFlags(['--apply']);
    expect(flags.apply).toBe(true);
  });

  it('flag desconhecida ou ausência de --apply nunca liga a escrita', () => {
    expect(parseImportPatientsFlags(['--dry-run']).apply).toBe(false);
    expect(parseImportPatientsFlags(['--live']).apply).toBe(false);
    expect(parseImportPatientsFlags(['--verbose', '--limit', '3']).apply).toBe(false);
  });

  it('--task-id <id>: carga pontual de UMA task (substitui resync-one-clickup-task.ts)', () => {
    expect(parseImportPatientsFlags(['--task-id', '86abq2pzg']).taskId).toBe('86abq2pzg');
    expect(parseImportPatientsFlags([]).taskId).toBeNull();
  });

  it('flag presente sem valor depois (último argv) → null, não undefined', () => {
    expect(parseImportPatientsFlags(['--task-id']).taskId).toBeNull();
    expect(parseImportPatientsFlags(['--limit']).limit).toBeNull();
  });

  it('--limit N: parseia inteiro; ausente = null (sem limite)', () => {
    expect(parseImportPatientsFlags(['--limit', '5']).limit).toBe(5);
    expect(parseImportPatientsFlags([]).limit).toBeNull();
  });

  it('--status X,Y,Z: lista normalizada para minúsculas', () => {
    expect(parseImportPatientsFlags(['--status', 'Busqueda,Activo']).statusFilter).toEqual(['busqueda', 'activo']);
    expect(parseImportPatientsFlags([]).statusFilter).toEqual([]);
  });

  it('--verbose liga o flag de log completo', () => {
    expect(parseImportPatientsFlags(['--verbose']).verbose).toBe(true);
    expect(parseImportPatientsFlags([]).verbose).toBe(false);
  });

  it('combinação real de uma carga pontual: --task-id + --apply', () => {
    expect(parseImportPatientsFlags(['--task-id', 'abc123', '--apply'])).toEqual({
      apply: true, taskId: 'abc123', limit: null, statusFilter: [], verbose: false,
    });
  });
});
