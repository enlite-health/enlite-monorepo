import { Text } from '@presentation/components/atoms/Text';
import { TableCell } from '@presentation/components/atoms/Table';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const EMPTY = '—';

/**
 * A coluna da vaga viva na linha do serviço (spec 047, F3): o código da vacante, clicável.
 * Só existe para quem lê vagas — o chamador decide (`useContainerAccess('vacancy')`), e o back já redige
 * `liveVacancy` (`liveVacancyRedacted`) para quem não pode. Sem vaga: "—".
 *
 * O código vai sempre para `/admin/vacancies/:id`: a página do detalhe REDIRECIONA o rascunho (`is_draft`)
 * para `/borrador` (`VacancyDetailPage`), então o rascunho cai na tela certa sem a ficha saber que é rascunho.
 * Não há coluna de link do site (pedido do Gabriel, 08/10): o código basta.
 */
export function ServiceVacancyCells({ service }: { service: PatientContractedServiceDetail }) {
  const vaga = service.liveVacancy;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <TableCell unwrapped data-testid={`contracted-service-vacancy-code-${service.id}`}>
      {vaga ? (
        <a
          href={`/admin/vacancies/${vaga.id}`}
          onClick={stop}
          data-testid={`contracted-service-vacancy-link-${service.id}`}
          className="text-primary underline underline-offset-2 hover:text-primary/70 focus:outline-none focus:ring-2 focus:ring-primary rounded"
        >
          <Text as="span" size="sm" weight="medium" color="inherit">{formatVacancyCase(vaga.caseNumber, vaga.caseOrdinal)}</Text>
        </a>
      ) : (
        <Text as="span" size="sm">{EMPTY}</Text>
      )}
    </TableCell>
  );
}
