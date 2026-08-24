#!/usr/bin/env ts-node
/**
 * inspect-clickup-fields — dump resolver map da lista "Estado de Pacientes".
 *
 * Uso:
 *   set -a && source worker-functions/.env && set +a
 *   npx ts-node worker-functions/scripts/inspect-clickup-fields.ts
 *
 * Saída:
 *   - JSON estruturado com todos os dropdowns e labels resolvidos
 *   - Útil pra (1) validar cobertura antes do importer, (2) referência rápida.
 */
// Direct import (bypass barrel — barrel pulls WebhookPartnerRepository → @shared,
// which requires tsconfig-paths for ts-node. Resolver itself has zero deps.)
import { ClickUpFieldResolver } from '../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';

const LIST_ID = '901304883903'; // Estado de Pacientes

async function main() {
  const resolver = await ClickUpFieldResolver.fromList(LIST_ID);

  console.log('\n=== Drop-down fields (orderindex → label) ===\n');
  for (const name of resolver.dropdownFieldNames.sort()) {
    // INSPECTION path: ask the resolver for the whole map at once.
    // The old range probe (`for (let i = 0; i < 50; i++) resolveDropdown(name, i)`) missed
    // ~45 times per field, and since task 1.3 every miss emits a warning — the real alarm
    // would drown in the probe's own noise (criterion 9.4: an alarm drowned in noise is an
    // absent alarm). getDropdownOptions() is the read-only accessor, and it never warns.
    // The SYNC path (ClickUpPatientMapper → resolveDropdown) keeps warning: that is the point.
    const options = resolver.getDropdownOptions(name);
    console.log(`${name}:`);
    for (const [idx, label] of Object.entries(options)) {
      console.log(`  [${idx}] ${label}`);
    }
    console.log();
  }

  console.log('\n=== Labels fields (id → label) ===\n');
  for (const name of resolver.labelsFieldNames.sort()) {
    const options = resolver.getLabelsOptions(name);
    console.log(`${name} (${Object.keys(options).length} opções):`);
    for (const [id, label] of Object.entries(options)) {
      console.log(`  ${id}  →  ${label}`);
    }
    console.log();
  }

  console.log('\n=== Spot-check de mapeamento ===\n');
  console.log(`Dependencia[1]       = ${resolver.resolveDropdown('Dependencia', 1)}`);
  console.log(`Sexo Asignado al Nacer (Uso Clínico)[1] = ${resolver.resolveDropdown('Sexo Asignado al Nacer (Uso Clínico)', 1)}`);
  console.log(`Servicio[0]          = ${resolver.resolveDropdown('Servicio', 0)}`);
  console.log(`Tipo de Documento Paciente[0] = ${resolver.resolveDropdown('Tipo de Documento Paciente', 0)}`);
  console.log(`Relación con el Paciente[1]   = ${resolver.resolveDropdown('Relación con el Paciente', 1)}`);
  console.log(`Cobertura Verificada[00469b61-9b2f-496a-9fc8-0a112e5ceb8c] = ${resolver.resolveLabel('Cobertura Verificada', '00469b61-9b2f-496a-9fc8-0a112e5ceb8c')}`);
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exit(1);
});
