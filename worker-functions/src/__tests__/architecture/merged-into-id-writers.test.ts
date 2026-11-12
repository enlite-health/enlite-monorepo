/**
 * T136 (change acesso-do-cliente-areas-e-login-unico, F1 item 18, fatos F19).
 * Teste de arquitetura: todo escritor de `workers.merged_into_id` em código de produção é CONHECIDO e leva o gancho do
 * grafo de identidade (`iam.merge_person` / `iam.unmerge_person`). Escritor novo sem gancho reprova.
 *
 * Limite declarado (D-V2→B): os relinks por e-mail (`InitWorkerUseCase`, `GetAdminProfileUseCase` → `reassignFirebaseUid`)
 * escrevem `auth_uid`/`firebase_uid`, NÃO `merged_into_id`, portanto este teste não os cobre.
 */
import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../..');
const RAIZES = ['src', 'scripts'].map((d) => path.join(WF, d));

const WRITER = /UPDATE\s+workers\s+SET[\s\S]{0,400}?merged_into_id\s*=\s*(\$\d|NULL)/;
const DINAMICO = /UPDATE\s+workers\s+SET\s+\$\{/;

const PHONE = 'WorkerPhoneMergeService.ts';
const DEDUP = 'WorkerDeduplicationService.ts';
const SNAPSHOT = 'WorkerMergeSnapshotService.ts';
const UNDO = 'WorkerMergeUndoService.ts';
const ALLOWLIST = [DEDUP, SNAPSHOT, PHONE].sort();

// `UPDATE workers SET ${...}` medidos em 09/11 (lista de colunas fechada, nenhuma literal `merged_into_id`).
// Um arquivo novo com SET dinâmico reprova até ser auditado e entrar aqui de propósito.
const DINAMICOS_CONHECIDOS = [
  'ExecuteAdminMergeUseCase.ts',
  'SyncTalentumWorkersUseCase.ts',
  'UpdateWorkerProfileFieldsUseCase.ts',
  'WorkerAuthRepository.ts',
  'WorkerImportRepository.ts',
  'WorkerPhoneMergeHelpers.ts',
  'encuadres-worker-upsert.ts',
].sort();

function lista(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) lista(full, out);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') && !e.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

const FONTES = RAIZES.flatMap((r) => lista(r));
const CONTEUDO = new Map(FONTES.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const base = (f: string) => path.basename(f);
const doBase = (nome: string) => FONTES.filter((f) => base(f) === nome);
const rel = (f: string) => path.relative(WF, f);

describe('escritores de workers.merged_into_id (T136)', () => {
  it('o scanner lê o código de produção (contagem zero seria "não medi")', () => {
    expect(FONTES.length).toBeGreaterThan(300);
    for (const n of [PHONE, DEDUP, SNAPSHOT, UNDO]) expect(doBase(n)).toHaveLength(1);
  });

  it('controle positivo e negativo do detector', () => {
    expect(WRITER.test('UPDATE workers SET merged_into_id = $1, updated_at = NOW() WHERE id = $2')).toBe(true);
    expect(WRITER.test('UPDATE workers SET merged_into_id = NULL WHERE id = $1')).toBe(true);
    expect(WRITER.test('SELECT id FROM workers WHERE merged_into_id IS NULL')).toBe(false);
    expect(DINAMICO.test('UPDATE workers SET ${sets.join(", ")} WHERE id = $1')).toBe(true);
  });

  it('(1) o conjunto de arquivos que escrevem merged_into_id == allowlist de 3', () => {
    const achados = FONTES.filter((f) => WRITER.test(CONTEUDO.get(f)!)).map(base).sort();
    expect(achados).toEqual(ALLOWLIST);
  });

  it.each([PHONE, DEDUP])('(2) %s (faz merge) contém iam.merge_person', (nome) => {
    expect(CONTEUDO.get(doBase(nome)[0])).toContain('iam.merge_person');
  });

  it('(3) WorkerMergeUndoService contém iam.unmerge_person', () => {
    expect(CONTEUDO.get(doBase(UNDO)[0])).toContain('iam.unmerge_person');
  });

  it('(4) o único chamador de restoreSnapshot é WorkerMergeUndoService', () => {
    const chamadores = FONTES.filter((f) => base(f) !== SNAPSHOT && /\brestoreSnapshot\s*\(/.test(CONTEUDO.get(f)!)).map(base);
    expect(chamadores).toEqual([UNDO]);
  });

  it('(5) UPDATE workers SET ${...} fora do Snapshot só em arquivo auditado e sem literal merged_into_id', () => {
    const dinamicos = FONTES.filter((f) => base(f) !== SNAPSHOT && DINAMICO.test(CONTEUDO.get(f)!));
    expect(dinamicos.map(base).sort()).toEqual(DINAMICOS_CONHECIDOS);
    for (const f of dinamicos) {
      expect({ arquivo: rel(f), cita: /['"`]merged_into_id['"`]/.test(CONTEUDO.get(f)!) }).toEqual({ arquivo: rel(f), cita: false });
    }
  });
});
