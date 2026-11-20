/**
 * Spec 077 (PR-INF-18, ensaio B): o use case do "Cómo llegar" é só portas + domínio. Este teste MORRE se o arquivo voltar a
 * importar `pg`, `@shared/database/*` ou qualquer `/infrastructure/` (adapter concreto ou infra de outro módulo). Escopo: SÓ
 * este arquivo (generalizar para o repo é LISTA). Molde: `no-x-auth-uid.test.ts` (leitura do fonte + regex, com controle).
 * A leitura é do TEXTO INTEIRO (regex multilinha): pega também `import {\n ...\n} from 'pg'`, `require('pg')` e `import('pg')`.
 */
import * as fs from 'fs';
import * as path from 'path';

const ALVO = path.resolve(__dirname, '../../modules/matching/application/GetWorkerTransitToPatientUseCase.ts');
const ESPECIFICADOR = `(?:pg|@shared\\/database\\/[^'"]*|[^'"]*\\/infrastructure\\/[^'"]*)`;
const PROIBIDO = new RegExp(`(?:\\bfrom\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s+)['"]${ESPECIFICADOR}['"]`);

describe('arquitetura: GetWorkerTransitToPatientUseCase só depende de portas e domínio', () => {
  it('T-F4-04 o regex acusa os 3 imports proibidos (controle positivo) e o arquivo existe', () => {
    for (const linha of ["import type { PoolClient } from 'pg';", "import { withActorContext } from '@shared/database/actorContext';", "import { X } from '../infrastructure/GoogleTransitDirections';", "import { readWorkerWindow } from '@modules/case/infrastructure/WorkerItineraryReader';"]) {
      expect(PROIBIDO.test(linha)).toBe(true);
    }
    expect(PROIBIDO.test("import type { TransitPort } from './ports/WorkerTransitPorts';")).toBe(false);
    expect(fs.readFileSync(ALVO, 'utf8').length).toBeGreaterThan(0);
  });

  it('T-F4-04 o regex acusa import em várias linhas, require e import dinâmico (controle positivo multilinha)', () => {
    for (const texto of ["import {\n  Pool,\n  PoolClient,\n} from 'pg';", "const pg = require('pg');", "const m = await import('pg');", "import {\n  X,\n} from '../../infrastructure/Y';", "import 'pg';"]) {
      expect(PROIBIDO.test(texto)).toBe(true);
    }
    expect(PROIBIDO.test("import {\n  A,\n  B,\n} from './ports/WorkerTransitPorts';")).toBe(false);
  });

  it('T-F4-04 o use case não importa pg, @shared/database nem /infrastructure/', () => {
    const fonte = fs.readFileSync(ALVO, 'utf8');
    expect(/^\s*import\b/m.test(fonte)).toBe(true);
    expect(PROIBIDO.exec(fonte)).toBeNull();
  });
});
