import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { TableCell } from '@presentation/components/atoms/Table';
import { CopyToClipboardButton } from '@presentation/components/atoms/CopyToClipboardButton';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import type { PatientContractedServiceDetail } from '@domain/entities/PatientDetail';

const EMPTY = '—';

/**
 * As duas colunas da vaga viva na linha do serviço (spec 047, F3): "Código da vacante" e "Link do site".
 * Só existem para quem lê vagas — o chamador decide (`useContainerAccess('vacancy')`), e o back já redige
 * `liveVacancy` (`liveVacancyRedacted`) para quem não pode. Sem vaga: "—" nas duas.
 *
 * O código vai sempre para `/admin/vacancies/:id`: a página do detalhe REDIRECIONA o rascunho (`is_draft`)
 * para `/borrador` (`VacancyDetailPage`), então o rascunho cai na tela certa sem a ficha saber que é rascunho.
 * O link do site é o que o back JÁ gravou (`social_short_links.site`): nada é gerado aqui (Short.io é API externa).
 */
export function ServiceVacancyCells({ service }: { service: PatientContractedServiceDetail }) {
  const { t } = useTranslation();
  const tc = (k: string) => t(`admin.patients.detail.contractedServicesCard.${k}`);
  const vaga = service.liveVacancy;
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  return (
    <>
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
      <TableCell unwrapped data-testid={`contracted-service-site-link-${service.id}`}>
        {vaga?.siteUrl ? (
          <div className="flex items-center gap-1">
            <a
              href={vaga.siteUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={stop}
              data-testid={`contracted-service-site-url-${service.id}`}
              className="text-primary underline underline-offset-2 hover:text-primary/70 focus:outline-none focus:ring-2 focus:ring-primary rounded break-all"
            >
              <Text as="span" size="sm" color="inherit">{vaga.siteUrl}</Text>
            </a>
            <CopyToClipboardButton
              text={vaga.siteUrl}
              label={tc('copyLink')}
              copiedLabel={tc('linkCopied')}
              data-testid={`contracted-service-copy-link-${service.id}`}
            />
          </div>
        ) : (
          <Text as="span" size="sm">{EMPTY}</Text>
        )}
      </TableCell>
    </>
  );
}
