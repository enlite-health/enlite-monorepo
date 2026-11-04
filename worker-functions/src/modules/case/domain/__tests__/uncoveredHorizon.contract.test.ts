/**
 * uncoveredHorizon.contract — spec 069, P7/P8/FR-35: o horizonte do aviso "turnos sin cubrir" é UMA constante
 * (`UNCOVERED_HORIZON_DAYS`, `serviceOccurrences.ts`). Este teste LÊ o fonte dos consumidores e exige (1) que importem a
 * constante (ou `uncoveredWindow`, que a usa) de `serviceOccurrences` e (2) que nenhum tenha `7`/`6` literal fora de comentário
 * — a janela `[hoje, hoje+6]` e o teto do prefiltro SQL (`CURRENT_DATE + 7`) saem da constante. Molde
 * `workerProgressValidation.contract.test.ts`. O varredor tem controle positivo (acerta uma fonte com o literal).
 *
 * Os 4 consumidores de hoje: o cartão do serviço (caso de uso + leitor) e o Kanban (caso de uso + leitor do agregado). O
 * `UncoveredShiftsAlertUseCase` (alerta diário, F4) entra nesta lista quando nascer. `itineraryAlerts.ts` (a regra) usa
 * `uncoveredWindow` e também é varrido.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { UNCOVERED_HORIZON_DAYS, uncoveredWindow } from '../serviceOccurrences';

const CASE = join(__dirname, '..', '..');
const CONSUMERS = [
  'application/GetPatientItineraryUseCase.ts',
  'application/ListKanbanServicesUseCase.ts',
  'infrastructure/PatientKanbanServicesReader.ts',
  'infrastructure/PatientItineraryReader.ts',
] as const;
const RULE = 'domain/itineraryAlerts.ts';

/** Fonte sem comentários (de bloco e de linha). */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/(^|[^:\w])\/\/.*$/gm, '$1');
}
const literalHorizon = (source: string): string[] => code(source).split('\n').filter((l) => /\b[67]\b/.test(l));
const importsHorizon = (source: string): boolean =>
  /import\s*\{[^}]*\b(UNCOVERED_HORIZON_DAYS|uncoveredWindow)\b[^}]*\}\s*from\s*'[^']*serviceOccurrences'/.test(source);
const read = (rel: string): string => readFileSync(join(CASE, rel), 'utf8');

describe('horizonte do aviso de turnos sin cubrir (UMA constante)', () => {
  it('controle positivo: o varredor ACHA um 7 literal e um import ausente numa fonte sabotada', () => {
    const sabotada = "import { x } from './outro';\nconst sql = `... CURRENT_DATE + 7 ...`; // + 7 em comentário não conta\n";
    expect(literalHorizon(sabotada)).toHaveLength(1);
    expect(importsHorizon(sabotada)).toBe(false);
    expect(literalHorizon("const w = addDays(asOf, 6);")).toHaveLength(1);
    expect(literalHorizon('// só comentário 7\n/* 6 */ const ok = UNCOVERED_HORIZON_DAYS;')).toEqual([]);
  });

  it.each(CONSUMERS)('%s importa o horizonte de serviceOccurrences e não tem 7/6 literal', (rel) => {
    const source = read(rel);
    expect(importsHorizon(source)).toBe(true);
    expect(literalHorizon(source)).toEqual([]);
  });

  it('a regra do alerta (itineraryAlerts) usa a janela da constante e não tem literal', () => {
    const source = read(RULE);
    expect(importsHorizon(source)).toBe(true);
    expect(literalHorizon(source)).toEqual([]);
  });

  it('o valor: horizonte 7; a janela é [hoje, hoje+6] — hoje+6 entra e hoje+7 não', () => {
    expect(UNCOVERED_HORIZON_DAYS).toBe(7);
    const { from, to } = uncoveredWindow('2026-10-23');
    expect([from, to]).toEqual(['2026-10-23', '2026-10-29']);
    expect('2026-10-29' <= to && '2026-10-30' > to).toBe(true);
  });
});
