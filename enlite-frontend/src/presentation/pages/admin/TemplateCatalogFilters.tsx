/**
 * A faixa de filtros do catálogo (Tela 1).
 *
 * Extraída da página porque ela passou o teto de 400 linhas do monorepo — e o
 * teto existe justamente para forçar esse tipo de corte.
 *
 * 🔒 DOIS CONJUNTOS COM UNIDADES DIFERENTES, e a tela precisa dizer isso. Os
 * filtros de estado contam TEMPLATES (é o que sempre contaram, e mudar a conta
 * trocaria o significado de números que já estão na tela); "Falta una versión"
 * conta MENSAGENS, porque é uma afirmação sobre o PAR. Somar os dois daria um
 * total que não existe — daí a barra separando, e não é enfeite.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { FILTER_ORDER, type GroupCounts } from './templateCatalogView';
import { MISSING, type CatalogFilter } from './templateCatalogPairs';

export interface TemplateCatalogFiltersProps {
  filter: CatalogFilter;
  counts: GroupCounts;
  /** Quantas MENSAGENS estão sem uma das versões — unidade diferente da acima. */
  faltamVersao: number;
  syncAge: { valor: number; unidade: string } | null;
  onFilter: (f: CatalogFilter) => void;
}

export function TemplateCatalogFilters({
  filter, counts, faltamVersao, syncAge, onFilter,
}: TemplateCatalogFiltersProps): JSX.Element {
  const { t } = useTranslation();
  const base = 'inline-flex items-center gap-1.5 rounded-pill border px-3 py-1';

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-gray-300 pb-4" data-testid="tc-filters">
      {FILTER_ORDER.map((key) => (
        <button
          key={key}
          type="button"
          data-testid={`tc-filter-${key}`}
          aria-pressed={filter === key}
          onClick={() => onFilter(key)}
          className={`${base} ${
            filter === key ? 'border-primary bg-primary text-white' : 'border-gray-600 bg-white text-gray-800'
          }`}
        >
          <Text as="span" size="xs" color="inherit">{t(`admin.templateCatalog.filter.${key}`)}</Text>
          <Text as="span" size="xs" weight="semibold" color="inherit">{counts[key]}</Text>
        </button>
      ))}

      <span className="mx-1 h-5 w-px bg-gray-300" aria-hidden="true" />
      <button
        type="button"
        data-testid={`tc-filter-${MISSING}`}
        aria-pressed={filter === MISSING}
        onClick={() => onFilter(MISSING)}
        /* Vermelho como no desenho: é o único filtro que aponta uma LACUNA
           NOSSA, e não um estado que a Meta decidiu. */
        className={`${base} ${
          filter === MISSING
            ? 'border-pink-cancel bg-pink-cancel text-white'
            : 'border-pink-cancel bg-white text-[#8E1230]'
        }`}
      >
        <Text as="span" size="xs" color="inherit">{t('admin.templateCatalog.filter.missing')}</Text>
        <Text as="span" size="xs" weight="semibold" color="inherit">{faltamVersao}</Text>
      </button>

      {/* A idade do dado fica ao lado dos filtros, não numa coluna: um catálogo
          verificado há três dias diz coisa diferente de um verificado há três
          minutos, e isso vale para a lista INTEIRA — o sync roda de uma vez. */}
      {syncAge && (
        <span className="ml-auto" data-testid="tc-sync-age">
          <Text as="span" size="xs" color="secondary">
            {t(`admin.templateCatalog.syncAge.${syncAge.unidade}`, { count: syncAge.valor })}
          </Text>
        </span>
      )}
    </div>
  );
}
