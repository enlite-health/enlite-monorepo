# Worker Registration UX — Verificação contra o vídeo (2026-06-28)

Re-análise do vídeo `docs/adr/Registro de prestador UX.webm` (725s, 726 frames) via skill `/analyze-video`
(ffmpeg + whisper.cpp + 10 subagentes de frames + síntese) **cruzada com o código efetivamente alterado e
provada com E2E real-stack** (frontend + backend + Postgres reais, snapshots Playwright).

> Os frames são da versão **PROD antiga** (anterior à branch) — confirmam que as reclamações existiam, não o fix.
> A prova do fix é o código (arquivo:linha) + os testes E2E que rodam contra o app atual.

## Veredito por reclamação falada (narração = fonte da verdade)

| # | Reclamação (transcript:linha) | Veredito | Evidência |
|---|---|---|---|
| 1 | `13-15` Profesión pré-selecionada por defecto | ✅ RESOLVIDO | `GeneralInfoFormFields.tsx` select com `value={field.value ?? ''}` + placeholder; default `undefined`. E2E `worker-profile-ux-fixes` `toHaveValue('')` + screenshot `sex-field-with-hint` |
| 2 | `16` Nivel de estudios pré-selecionado | ✅ RESOLVIDO | idem; + msg de erro corrigida "nivel de conocimiento"→"nivel de estudios" (`es.json`) |
| 3 | `21-28,57-59` **(CENTRAL)** Guardar não avança / sem botão Siguiente-Atrás | ✅ RESOLVIDO | novo `ProfileWizardFooter` (Atrás/Siguiente/Finalizar) + wiring em `WorkerProfilePage`. E2E `worker-profile-wizard` + screenshot `wizard-footer-first-tab` |
| 4 | `25,34,58` ao guardar "no llega hasta arriba" | ✅ RESOLVIDO | `window.scrollTo({top:0})` na navegação (`WorkerProfilePage` goToPrev/Next/handleGoToTab) |
| 5 | `30-33` horários de 5min → 30min | ✅ RESOLVIDO | `DayScheduleEditor` `step={30}`. E2E `worker-profile-ux-fixes` + screenshot `time-picker-30min` (07:30/08:00/08:30/09:00/09:30) |
| 6 | `37-40,48-49` docs obrigatórios sem legenda "(obligatorio)" | ✅ RESOLVIDO | badge "Obligatorio" (`DocumentUploadCard`) + aviso de pendentes (`DocumentsGrid`); só Seguro opcional. E2E `at-documents-clarity` |
| 7 | `42-43` layout quebra ao adicionar "otra documentación" (+) | ✅ RESOLVIDO | `AdditionalDocumentsSection` flex-wrap/shrink-0/stack. E2E `worker-profile-ux-fixes` mobile 360px + screenshot `additional-docs-mobile` |
| 8 | `50-56` falta tela de finalização com docs faltantes | ✅ RESOLVIDO | novo `ProfileCompletionSummary` (Finalizar → resumo c/ pendentes + CTA). E2E `worker-profile-wizard` + screenshot `wizard-summary-pending` |

## Extras revelados pelos frames (não falados) — também resolvidos

`html lang=en→es` (`index.html`) · "Usuário"→`userFallback` ES (`WorkerHome`) · Sexo/Género com hint diferenciador
(`GeneralInfoFormFields` + `FormField`) · "¿Con que… gustaria"→"¿Con qué… gustaría" (`es.json`) · mapa esconde
POIs/transit + geocode por endereço (`ServiceAreaMap`) · validação on-keystroke→`onTouched` (3 tabs) · banner
antecipado do gate (`JobsEmbeddedSection`) · contagem "Documentos obligatorios" (label).

## Lacunas / risco residual (honesto)

- **scroll-to-top**: comportamento runtime atrelado à navegação do footer (provado), sem screenshot do scroll em si.
- **contagem de documentos**: só o *label* foi clarificado ("Documentos obligatorios"); a divergência numérica de
  fundo (perfil mostra ~9 cards vs Home conta 4 obrigatórios) não foi reconciliada — decisão de produto.
- **feedback por aba após "Guardar"**: o banner verde `saveSuccess` + botão `disabled` enquanto salva já existem
  na branch; o fechamento do ciclo agora vem do resumo de Finalizar.

## Quality gate

type-check ✅ · lint ✅ · validate:lines/architecture ✅ · build ✅ · 3698 testes unitários ✅ ·
5 testes E2E integration (real-stack) ✅ com 5 snapshots gerados.
