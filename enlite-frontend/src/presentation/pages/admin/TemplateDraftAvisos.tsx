import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { ProblemaDeRegra } from '@infrastructure/http/AdminTemplateDraftsApiService';
import { chaveDeProblema } from './templateDraftsView';

/**
 * O que o backend gravou APESAR de — AR-01 (cláusula de baja) e MKT-02.
 *
 * 🔒 ÂMBAR, NÃO VERMELHO, e a distinção não é estética. O vermelho desta tela
 * significa "não gravou": é a lista que volta num 422, com o rascunho perdido
 * até a pessoa consertar. Aviso é o oposto — gravou, e mesmo assim falta uma
 * coisa que a lei argentina pede. Pintar os dois da mesma cor ensinaria a
 * pessoa a ignorar o vermelho, que é o único que exige ação imediata.
 *
 * 🔒 Componente em arquivo próprio, e não um bloco dentro da página: a
 * `TemplateDraftsPage` já estava em 408 linhas, acima do teto de 400 do
 * monorepo, antes deste painel existir.
 */
export function TemplateDraftAvisos({ avisos }: { avisos: ProblemaDeRegra[] }): JSX.Element | null {
  const { t } = useTranslation();
  if (avisos.length === 0) return null;
  return (
    <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3" data-testid="td-avisos">
      <Text size="sm" color="inherit" className="text-amber-900">
        {t('admin.templateDrafts.avisos.titulo')}
      </Text>
      <ul className="mt-1 list-disc pl-5">
        {avisos.map((p) => (
          <li key={p.regra}>
            <Text size="xs" color="inherit" className="text-amber-900">
              {t(chaveDeProblema(p), t('admin.templateDrafts.regra.generica'))}
            </Text>
          </li>
        ))}
      </ul>
    </div>
  );
}
