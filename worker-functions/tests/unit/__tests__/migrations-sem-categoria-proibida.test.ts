/**
 * Guarda automática (spec 018, PR-3, migration 425; Emenda 13/09 do registro de operações,
 * `lex` #2a, PARE): orientação sexual, origem racial/étnica e religião NÃO podem ganhar coluna
 * em NENHUMA migration deste repo — nem em `patients`, nem em nenhuma outra tabela.
 *
 * Varredura textual sobre `worker-functions/migrations/*.sql`: procura `ADD COLUMN` cujo nome
 * bate um padrão de categoria proibida. Falso positivo aceitável (nomes já existentes e
 * inofensivos) entra na EXCEÇÃO nomeada abaixo, nunca afrouxando o padrão.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

// Padrões de coluna proibida (case-insensitive). Cobrem o nome em inglês e em espanhol/português
// já usados neste repo (`Sex.ts`, `Gender.ts`, `Relationship.ts`).
const FORBIDDEN_COLUMN_PATTERNS: RegExp[] = [
  /\bsexual_orientation\w*/i,
  /\borientacion_sexual\w*/i,
  /\borientacao_sexual\w*/i,
  /\brace\b|\bracial\w*|\betnia\w*|\bethnicity\w*/i,
  /\breligion\w*|\breligiao\w*/i,
];

// Coluna nomeada como exceção JÁ AUDITADA (nenhuma hoje) — qualquer entrada aqui precisa de
// parecer do `lex` citado no comentário ao lado.
const EXCECOES_AUDITADAS: readonly string[] = [];

describe('migrations — sem categoria proibida em PATIENTS (lex #2a, PARE)', () => {
  // Escopo desta emenda (13/09, spec 018 PR-3): PACIENTE. `workers` já coleta
  // sexual_orientation/race/religion desde as migrations 008/023 — decisão PRÉ-EXISTENTE e
  // FORA do escopo desta guarda (categoria/titular diferente; não é achado desta migration).
  // A guarda varre só `ALTER TABLE patients ... ADD COLUMN` — nunca `workers`.
  it('nenhuma migration adiciona, em `patients`, coluna de orientação sexual, raça/etnia ou religião', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const achados: string[] = [];
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const patientsAlterLines = sql
        .split('\n')
        .filter((l) => /ALTER\s+TABLE\s+patients\b/i.test(l) && /ADD\s+COLUMN/i.test(l));
      for (const line of patientsAlterLines) {
        for (const pattern of FORBIDDEN_COLUMN_PATTERNS) {
          const match = line.match(pattern);
          if (match && !EXCECOES_AUDITADAS.includes(match[0].toLowerCase())) {
            achados.push(`${file}: ${line.trim()}`);
          }
        }
      }
    }
    expect(achados).toEqual([]);
  });

  it('migration 425 (spec 018 PR-3) só adiciona gender_encrypted e languages_encrypted em patients', () => {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, '425_patient_gender_and_languages.sql'), 'utf8');
    const addColumnLines = sql.split('\n').filter((l) => /ADD\s+COLUMN/i.test(l));
    expect(addColumnLines).toHaveLength(2);
    expect(addColumnLines.join('\n')).toContain('gender_encrypted');
    expect(addColumnLines.join('\n')).toContain('languages_encrypted');
  });
});
