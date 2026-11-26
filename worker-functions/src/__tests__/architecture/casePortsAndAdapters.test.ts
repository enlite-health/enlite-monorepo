/**
 * Fronteira ports & adapters do módulo `case` (estado-automatico-do-paciente, D7 / E1 — teste jest, não ESLint: o ESLint não roda
 * neste pacote, F23). Os use cases da allowlist dependem só de ports: nenhum import de `infrastructure/`, de `interfaces/`, de
 * `@shared/database` nem de `pg` (inclusive `import type`). A allowlist CRESCE por fase (F3 acrescentou os use cases de ação: 4 arquivos).
 *
 * Limite declarado: import pelo barrel de outro módulo (`@modules/matching`) não é inspecionado transitivamente; o logger
 * `firebase-functions` é transversal e fica fora da regra.
 */
import * as fs from 'fs';
import * as path from 'path';

const CASE = path.resolve(__dirname, '../../modules/case');

/** Use cases que dependem só de ports. Cresce por fase. */
export const ALLOWLIST = [
  'application/PatientStatusWriter.ts',
  'application/ActivateRecruitmentUseCase.ts',
  'application/PatientStatusActionUseCase.ts',
  'application/ListPatientStatusActionsUseCase.ts',
];

/** Especificador proibido dentro de um arquivo da allowlist. */
export const ESPECIFICADOR_PROIBIDO = /\/infrastructure\/|\/interfaces\/|^@shared\/database|^pg$/;

/** Todo especificador de import/export-from/require/import() do fonte (inclui `import type`). */
export function especificadoresDe(fonte: string): string[] {
  const sem = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const achados: string[] = [];
  const re = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},$]*?\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sem)) !== null) achados.push(m[1] ?? m[2] ?? m[3]);
  return achados;
}

/** Direção de dependência: `application/` nunca importa `interfaces/` (a composição é quem monta). Dívida declarada, fora do escopo desta change. */
export const DIVIDA_APPLICATION_IMPORTA_INTERFACES = ['CreateLeadUseCase.ts', 'PatientService.ts'];
export const IMPORTA_INTERFACES = /^\.\.\/interfaces\//; // o `interfaces/` do PRÓPRIO módulo case

const violacoesDe = (fonte: string): string[] => especificadoresDe(fonte).filter((e) => ESPECIFICADOR_PROIBIDO.test(e));
const ler = (rel: string): string => fs.readFileSync(path.join(CASE, rel), 'utf8');

describe('case: ports & adapters (D7)', () => {
  it('anti-vácuo: a allowlist tem os 4 arquivos (F1 + F3), todos existem e cada um tem ≥ 1 import lido', () => {
    expect(ALLOWLIST).toHaveLength(4);
    for (const rel of ALLOWLIST) {
      expect(fs.existsSync(path.join(CASE, rel))).toBe(true);
      expect(especificadoresDe(ler(rel)).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('controle positivo do detector: pega import de infrastructure, de interfaces, de @shared/database e de pg (inclusive import type)', () => {
    expect(violacoesDe("import { countVivasForPatient } from '../infrastructure/VacancyAllocationProbe';")).toHaveLength(1);
    expect(violacoesDe("import { x } from '../../matching/interfaces/controllers/vacancyCrudAuditHelpers';")).toHaveLength(1);
    expect(violacoesDe("import { inPatientTransaction } from '@shared/database/DatabaseConnection';")).toHaveLength(1);
    expect(violacoesDe("import type { PoolClient } from 'pg';")).toHaveLength(1);
    expect(violacoesDe("import type { StatusTx } from './ports/patientStatusPorts';\nimport * as functions from 'firebase-functions';")).toHaveLength(0);
  });

  it.each(ALLOWLIST)('%s não importa infraestrutura, interfaces, @shared/database nem pg', (rel) => {
    expect(violacoesDe(ler(rel))).toEqual([]);
  });

  it('application/ não importa interfaces/ (exceto a dívida declarada): controle positivo e varredura', () => {
    expect(especificadoresDe("import { movePatientStatus } from '../interfaces/composition/patientStatusComposition';").filter((e) => IMPORTA_INTERFACES.test(e))).toHaveLength(1);
    expect(especificadoresDe("import { movePatientStatus } from '../infrastructure/patientStatusWriterInstance';").filter((e) => IMPORTA_INTERFACES.test(e))).toHaveLength(0);
    const dir = path.join(CASE, 'application');
    const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(arquivos.length).toBeGreaterThan(10);
    const violadores = arquivos.filter((f) => especificadoresDe(ler(`application/${f}`)).some((e) => IMPORTA_INTERFACES.test(e)));
    expect(violadores).toEqual(DIVIDA_APPLICATION_IMPORTA_INTERFACES);
  });
});
