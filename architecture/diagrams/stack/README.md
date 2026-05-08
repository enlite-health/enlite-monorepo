# EnLite — Diagramas de Stack (draw.io)

Diagramas técnicos do stack da plataforma, seguindo **progressive disclosure** (macro → zoom).
Cada diagrama tem ≤7 blocos principais + caixa amarela de "HISTÓRIA" no topo em linguagem simples.

## Como abrir

1. Acesse https://app.diagrams.net (ou a app desktop do draw.io).
2. `File → Open From → Device` e selecione o arquivo `.drawio`.
3. Para exportar: `File → Export As → PNG/PDF/SVG`.

Alternativa: abra direto no VS Code com a extensão **Draw.io Integration** (hediet.vscode-drawio).

## Ordem de leitura

| Arquivo | O que mostra | Quando usar |
|---|---|---|
| `7A_macro.drawio` | 4 blocos macro (Frontend, Backend, Banco, Cloud) | Primeiro contato / 1º slide para gestor |
| `7B_frontend.drawio` | Zoom no frontend (React, React Native, Firebase Hosting, CDN, Armor) | Quando perguntarem "qual framework de tela?" |
| `7C_backend.drawio` | Zoom no backend (NestJS, 9 microsserviços, Cloud Run, GKE) | Quando perguntarem "qual framework do servidor?" |
| `7D_database.drawio` | Zoom nos bancos (Postgres, Healthcare API, Storage, Redis, BigQuery) | Quando perguntarem "onde ficam os dados?" |
| `7E_security_ops.drawio` | Zoom em segurança + observabilidade + DevOps | Quando perguntarem "como é seguro?" ou "como publica?" |
| `8_clickup_patient_webhook.drawio` | **3 páginas** — fluxo macro do webhook ClickUp → patients (8A), 5 camadas de filtragem com tratamento de erro (8B), suite de validação 3-níveis + observabilidade pós-deploy (8C) | Quando perguntarem "como funciona o sync de pacientes em tempo real?" ou "como sabemos que o webhook está OK?" |

## Princípios seguidos

- **C4 Model — Nível 2 (Container)**: audiência técnica ou negócio fluente.
- **Magical Number Seven** (Miller): cada diagrama tem ≤7 blocos principais.
- **Progressive disclosure**: macro primeiro, zoom depois — nunca tudo junto.
- **Storytelling**: caixa amarela no topo conta a "cena" em 3-4 linhas.
- **Cores com significado**: azul = nosso código, laranja = serviço GCP, vermelho = dado sensível/PHI, verde = observabilidade, roxo = DevOps/auditoria.

## Convenção de cores

| Cor | Significado |
|---|---|
| 🟦 Azul | Frontend / nosso código |
| 🟪 Rosa/Vermelho escuro | Backend NestJS |
| 🟧 Laranja | Serviço Google Cloud |
| 🟥 Vermelho claro | Dado sensível / PHI / Segurança |
| 🟩 Verde | Observabilidade / Auditoria |
| 🟣 Roxo | DevOps / CI/CD |
| 🟡 Amarelo | Legenda / Storytelling |

## Diagramas complementares (FigJam, storytelling macro)

Para apresentações executivas, veja as **Cenas 1–6** no FigJam — linguagem 100% sem jargão, com analogias (prédio, hospital, caixa eletrônico, cofre).
