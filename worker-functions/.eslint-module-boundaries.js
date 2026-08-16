/**
 * Module boundary patterns + overrides factory for .eslintrc.js.
 *
 * Each module exposes exactly one barrel (index.ts). External code must
 * import from the barrel — direct imports into subdirs are blocked so
 * internal reshuffling stays cheap and future extraction to MS is mechanical.
 */

const DEFAULT_SUBDIRS = ['domain', 'ports', 'infrastructure', 'application', 'interfaces'];

const MODULES = [
  { name: 'case',         barrel: 'src/modules/case',         pathBase: 'modules',  subdirs: ['domain', 'infrastructure', 'application'] },
  { name: 'audit',        barrel: '@modules/audit',           pathBase: 'modules',  subdirs: ['domain', 'infrastructure'] },
  { name: 'shared',       barrel: '@shared',                  pathBase: 'shared',   subdirs: ['database', 'security', 'events', 'utils', 'services'] },
  { name: 'notification', barrel: '@modules/notification',    pathBase: 'modules' },
  { name: 'identity',     barrel: '@modules/identity',        pathBase: 'modules' },
  { name: 'integration',  barrel: '@modules/integration',     pathBase: 'modules' },
  { name: 'worker',       barrel: '@modules/worker',          pathBase: 'modules' },
  { name: 'matching',     barrel: '@modules/matching',        pathBase: 'modules',  subdirs: ['domain', 'infrastructure', 'application', 'interfaces'] },
  // Submódulo de identity com fronteira PRÓPRIA (D115 §7: extraível para
  // permission-service). Fica listado à parte porque o override de `identity`
  // desliga a regra dentro de `src/modules/identity/**` — sem esta entrada,
  // qualquer arquivo poderia importar `.../permissions/application/...` direto e
  // a extração deixaria de ser mecânica. O caminho relativo (`*/`) cobre quem
  // importa de dentro de identity; o alias cobre o resto do repo.
  { name: 'identity/permissions', barrel: '@modules/identity/permissions', pathBase: 'modules',
    subdirs: ['domain', 'application', 'infrastructure', 'interface'] },
  { name: 'ops',          barrel: '@modules/ops',             pathBase: 'modules',  scaffold: true },
  { name: 'consent',      barrel: '@modules/consent',         pathBase: 'modules',  scaffold: true },
];

function buildGroups(mod) {
  const subdirs = mod.subdirs || DEFAULT_SUBDIRS;
  const prefix = mod.pathBase === 'shared' ? 'shared' : `modules/${mod.name}`;
  const groups = [];
  for (const sub of subdirs) {
    groups.push(`*/${prefix}/${sub}/*`);
    if (mod.pathBase !== 'shared') groups.push(`@modules/${mod.name}/${sub}/*`);
  }
  return groups;
}

function buildPatterns() {
  return MODULES.map(mod => ({
    group: buildGroups(mod),
    message: `Import ${mod.name} via the barrel: import { ... } from '${mod.barrel}'.`,
  }));
}

function buildOverrides() {
  return MODULES.map(mod => ({
    files: [mod.pathBase === 'shared' ? 'src/shared/**/*.ts' : `src/modules/${mod.name}/**/*.ts`],
    rules: { 'no-restricted-imports': 'off' },
  }));
}

module.exports = { buildPatterns, buildOverrides };
