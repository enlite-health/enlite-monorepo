/**
 * cli-guards.ts — spec 016 F4, Parte 2 (backfill). Parsing PURO dos flags do CLI.
 *
 * `--dry-run` é o DEFAULT — escrever exige `--write` EXPLÍCITO. `--dry-run` sempre GANHA de
 * `--write` quando os dois aparecem juntos: é o mesmo espírito do D10 do ingestor CID-11
 * ("falha visível na configuração, nunca cai silenciosamente no ramo perigoso") — aqui
 * aplicado ao lado seguro: um `--dry-run` digitado nunca é silenciosamente ignorado.
 */

export interface BackfillFlags {
  readonly dryRun: boolean;
  readonly write: boolean;
}

export function parseBackfillFlags(args: readonly string[]): BackfillFlags {
  const write = args.includes('--write');
  const explicitDryRun = args.includes('--dry-run');
  const dryRun = explicitDryRun || !write;
  return { dryRun, write };
}
