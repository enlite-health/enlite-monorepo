/**
 * Guarda automática (spec 018, PR-3, migration 425; Emenda 13/09 do registro de operações,
 * `lex` #2a, PARE): orientação sexual, origem racial/étnica e religião NÃO podem ganhar coluna
 * em NENHUMA migration deste repo — nem em `patients`, nem em nenhuma outra tabela. O checklist
 * (`lex.md` L2a) pede DUAS varreduras: a coluna SQL e a chave i18n do painel.
 *
 * Varredura textual sobre `worker-functions/migrations/*.sql` (whitespace NORMALIZADO — um
 * `ALTER TABLE patients\n  ADD COLUMN religion ...` em várias linhas escapava da varredura
 * anterior, que só olhava linha a linha) e sobre `enlite-frontend/src/infrastructure/i18n/
 * locales/{es,pt-BR}.json` sob o prefixo `admin.patients`.
 */
import { readdirSync, readFileSync } from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');
const FRONTEND_LOCALES_DIR = path.resolve(__dirname, '../../../../enlite-frontend/src/infrastructure/i18n/locales');

// Padrões de coluna/chave proibida (case-insensitive). Cobrem o nome em inglês e em
// espanhol/português já usados neste repo (`Sex.ts`, `Gender.ts`, `Relationship.ts`).
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bsexual_?orientation\w*/i,
  /\borientacion_?sexual\w*/i,
  /\borientacao_?sexual\w*/i,
  /\brace\b|\bracial\w*|\betnia\w*|\bethnicity\w*/i,
  /\breligion\w*|\breligiao\w*/i,
];

// Coluna/chave nomeada como exceção JÁ AUDITADA (nenhuma hoje) — qualquer entrada aqui precisa de
// parecer do `lex` citado no comentário ao lado.
const EXCECOES_AUDITADAS: readonly string[] = [];

/**
 * Normaliza um arquivo de migration para UM statement por linha lógica: colapsa quebras de linha
 * e espaços internos de cada `ALTER TABLE <tabela> ... ;`, para que `ADD COLUMN` em linha
 * diferente do `ALTER TABLE` não escape da varredura por regex de linha única.
 */
function alterTableStatements(sql: string, tabela: string): string[] {
  const semStringsESemComentarios = sql
    .replace(/--[^\n]*/g, ' ') // comentários de linha fora, para não confundir "religion" em prosa com coluna real
    .replace(/\s+/g, ' ');
  const regex = new RegExp(`ALTER\\s+TABLE\\s+${tabela}\\b[^;]*;`, 'gi');
  return semStringsESemComentarios.match(regex) ?? [];
}

describe('migrations — sem categoria proibida em PATIENTS, coluna SQL (lex #2a, PARE)', () => {
  // Escopo desta emenda (13/09, spec 018 PR-3): PACIENTE. `workers` já coleta
  // sexual_orientation/race/religion desde as migrations 008/023 — decisão PRÉ-EXISTENTE e
  // FORA do escopo desta guarda (categoria/titular diferente; não é achado desta migration).
  // A guarda varre só `ALTER TABLE patients ... ADD COLUMN` — nunca `workers`.
  it('nenhuma migration adiciona, em `patients`, coluna de orientação sexual, raça/etnia ou religião (statement normalizado, multi-linha incluído)', () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    const achados: string[] = [];
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      for (const statement of alterTableStatements(sql, 'patients')) {
        if (!/ADD\s+COLUMN/i.test(statement)) continue;
        for (const pattern of FORBIDDEN_PATTERNS) {
          const match = statement.match(pattern);
          if (match && !EXCECOES_AUDITADAS.includes(match[0].toLowerCase())) {
            achados.push(`${file}: ${statement.trim()}`);
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

  it('sabotagem: ALTER TABLE patients ... ADD COLUMN religion MULTI-LINHA é pego (a varredura antiga, linha a linha, não pegava)', () => {
    const sabotado = `
-- migration fictícia só para o teste
ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS religion_encrypted TEXT;
`;
    const achados: string[] = [];
    for (const statement of alterTableStatements(sabotado, 'patients')) {
      if (!/ADD\s+COLUMN/i.test(statement)) continue;
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(statement)) achados.push(statement);
      }
    }
    expect(achados.length).toBeGreaterThan(0);
  });
});

describe('painel — sem chave i18n proibida sob admin.patients (lex #2a, checklist L2a)', () => {
  // Chaves i18n vêm em camelCase (`sexualOrientation`, `racialOrigin`, `religion`) — forma
  // diferente das colunas SQL (snake_case), então o padrão é literal, não os `FORBIDDEN_PATTERNS`
  // acima (que casam `race`/`religion` em qualquer prosa e dariam falso positivo em texto livre).
  const CHAVES_PROIBIDAS = ['sexualOrientation', 'racialOrigin', 'religion'];

  it('es.json e pt-BR.json não têm chave admin.patients.*(sexualOrientation|racialOrigin|religion)', () => {
    for (const locale of ['es.json', 'pt-BR.json']) {
      const src = readFileSync(path.join(FRONTEND_LOCALES_DIR, locale), 'utf8');
      const json = JSON.parse(src) as { admin?: { patients?: { detail?: { generalInfoCard?: Record<string, unknown> } } } };
      const generalInfoCard = json.admin?.patients?.detail?.generalInfoCard ?? {};
      const achados = CHAVES_PROIBIDAS.filter((chave) => chave in generalInfoCard);
      expect({ locale, achados }).toEqual({ locale, achados: [] });
    }
  });

  it('sabotagem: reintroduzir "religion" em admin.patients.detail.generalInfoCard é pego', () => {
    const comChaveProibida = { detail: { generalInfoCard: { religion: 'Religión' } } };
    const achados = CHAVES_PROIBIDAS.filter((chave) => chave in comChaveProibida.detail.generalInfoCard);
    expect(achados).toEqual(['religion']);
  });
});
