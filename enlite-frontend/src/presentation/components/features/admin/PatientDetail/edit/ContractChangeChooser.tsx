import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';

const CARD = 'admin.patients.detail.contractedServicesCard';

export type ChangeAnswer = 'switch' | 'correct' | 'end' | 'newService';

const TESTID: Record<ChangeAnswer, string> = {
  switch: 'svc-contract-switch-open',
  correct: 'svc-contract-correct-open',
  end: 'svc-contract-end-open',
  newService: 'svc-contract-new-service',
};

interface Props {
  /** Só as respostas PERMITIDAS entram (quem decide é o painel, pelas mesmas condições de sempre). */
  answers: ChangeAnswer[];
  /** A resposta já escolhida (as 3 que abrem formulário). `null` = nenhuma ainda. */
  selected: ChangeAnswer | null;
  /** Nome da obra social do vínculo — entra no título "Cambió el contrato, sigue {provider}". */
  providerName: string;
  onChoose: (answer: ChangeAnswer) => void;
  disabled?: boolean;
}

/**
 * "¿Qué pasó con la cobertura?" — o operador escolhe pelo que ACONTECEU, não pelo nome técnico da ação (spec 058, opção A).
 * Cada resposta é um cartão inteiro clicável (`role="radio"`, botão nativo: Enter/Espaço funcionam e a ordem de Tab é a da tela).
 * "Ahora lo cubre otra obra social" não abre formulário: leva ao serviço novo (outra obra social é outra admissão).
 */
export function ContractChangeChooser({ answers, selected, providerName, onChoose, disabled = false }: Props): JSX.Element {
  const { t } = useTranslation();
  const title = (a: ChangeAnswer): string => t(`${CARD}.chooser.${a}Title`, { provider: providerName });
  return (
    <div className="flex flex-col gap-2" data-testid="svc-contract-chooser">
      <Text size="sm" weight="semibold" color="primary" id="svc-contract-chooser-title">{t(`${CARD}.chooser.title`)}</Text>
      <div role="radiogroup" aria-labelledby="svc-contract-chooser-title" className="flex flex-col gap-2">
        {answers.map((a) => {
          const on = selected === a;
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => onChoose(a)}
              data-testid={TESTID[a]}
              className={`flex w-full items-start gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition-colors disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${on ? 'border-primary bg-[#faf9fe]' : 'border-[#D9D9D9] bg-white hover:border-primary'}`}
            >
              <span aria-hidden="true" className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border-[1.5px] border-primary">
                {on && <span className="h-2 w-2 rounded-full bg-primary" />}
              </span>
              <span className="flex min-w-0 flex-col">
                <span className="font-lexend text-[13.5px] font-semibold leading-snug text-primary">{title(a)}</span>
                <span className="font-lexend text-[12.5px] leading-snug text-[#374151]">{t(`${CARD}.chooser.${a}Hint`)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
