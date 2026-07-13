# Rediseño de la ficha de vacante (página pública de vagas)

> Proposta de nova visualização do **bloco de detalhe da vaga** em `jobs.enlite.health`
> (o que abre ao clicar num card de vaga). Feito pra ser avaliado pelo **marketing**
> (responsável por essa página) e implementado depois pela engenharia.

**Data:** 2026-07-13 · **Status:** proposta (mockup validado), aguardando decisão de implementação.

---

## 1. Arquivo modelo

[`vacante-modelo.html`](./vacante-modelo.html) — **abra no navegador**. É autossuficiente (fontes reais do site embutidas, sem dependência externa), então pode ser encaminhado por e-mail/anexo e abre idêntico em qualquer máquina.

Mostra 4 cenários com **dados reais** de vagas:
1. Caso simples (801-2307 · Lun–Vie 14–18h)
2. Horários diferentes por dia (797-2208)
3. Cobertura 24h / 3 turnos (707-2187)
4. Vista **mobile** (390px)

---

## 2. O problema que resolve

O painel de detalhe hoje é uma lista corrida de `Rótulo: valor`, e os **días y horarios** aparecem como uma string longa e ilegível:

```
Días y Horarios: Lunes 14:00-18:00, Martes 14:00-18:00, Miércoles 14:00-18:00, Jueves 14:00-18:00, Viernes 14:00-18:00
```

Difícil de escanear, pouco convidativo. A proposta transforma isso numa **tabela semanal** e organiza os demais campos.

---

## 3. Sistema visual (fiel ao site real)

Capturado do site ao vivo (via Playwright), **não** inventado:

| Item | Valor real | Origem |
|---|---|---|
| Fonte do tema/corpo | **Poppins** | Elementor (embutida no modelo) |
| Fonte do header do acordeón | **Lexend Deca**, uppercase, `letter-spacing:1px` | plugin (embutida) |
| Roxo (texto/estrutura) | `#170149` | marca |
| Rosa ("Me Interesa") | `#F83667`, radius `25px` | marca |
| Laranja (acento) | `#F77748` | marca |
| "Ver Detalles" | `#170149`, radius `25px`, capitalize | marca |

---

## 4. Decisões (log)

Cada linha nasceu de uma iteração real com feedback:

1. **Horários viram tabela semanal** (não string) — é a mudança central. Tira semanal de 7 dias: dias com atividade preenchidos em índigo com o horário, folga apagados.
2. **Fiel ao estilo do site**, não um design novo — a 1ª versão "de estúdio" foi descartada por destoar. Capturamos fontes/cores/botões reais e replicamos.
3. **Sufixo `h` nos horários** (`14–18h`) — sem ele, "14–18" parecia dia do mês.
4. **Todo parâmetro com título** (`GÉNERO / Indistinto`, `CÓDIGO / …`) — valor solto como "Indistinto" é vago; sempre mostrar de que parâmetro é.
5. **Campos em blocos** (rótulo pequeno em cima, valor embaixo) — elimina o vão enorme entre label e valor e deixa o texto respirar.
6. **Turno noite sem emoji** — o 🌙 era ambíguo e destoava; o rango `20–08h` (começa à noite, termina de manhã) já indica que é noturno.
7. **UM único padrão de visualização** — a tira semanal vale pra **todos** os casos e **todos** os dispositivos. Regra dura: **não** trocar de formato em casos especiais (nem colapsar o 24h num resumo, nem virar lista no mobile). Trocar o padrão confunde o usuário.
8. **Mobile = a MESMA tira, com scroll horizontal** — em vez de comprimir 7 colunas (fica apertado) ou virar lista (muda o padrão), a tira desliza na horizontal com as células no tamanho confortável. A célula cortada na borda direita sinaliza que há mais.

---

## 5. Regras de negócio em aberto (confirmar com a operação)

Não bloqueiam avaliar o visual, mas precisam de decisão antes de implementar:

- **24h = cobertura do PACIENTE, não jornada de uma pessoa.** No dado, ~4% das vagas são "24h / cobertura", geralmente **3 turnos** (08–14 / 14–20 / 20–08) preenchidos por **vários** ATs. O total **"168 h/semana"** que aparece no card é a cobertura do caso, não as horas de quem se candidata — pode assustar/confundir. **Definir** como representar (ex.: rotular "cobertura" e não somar 168h, ou deixar claro que o candidato pega um turno).
- **"Indistinto" vs "Ambos":** o backend distingue `Indistinto` (não especificado) de `Ambos` (aceita os dois); pro candidato, ambos = "cualquier género". Decidir se unifica o texto.

---

## 6. Nota de implementação (pra engenharia)

- O painel é renderizado pelo **plugin WordPress `filtro-avancado-vacantes`** (shortcode `[filtro_vacantes_argentina]`), que consome o feed `GET /api/public/v1/jobs` (worker-functions). O HTML do painel vive em `includes/shortcode-handler.php`, editável via **SFTP + purge do Breeze** (ver runbook de deploy WP).
- **Pré-requisito da tabela:** hoje `schedule_days_hours` vem como **texto livre** (uns parseáveis tipo `"Lunes 09:00-12:00, …"`, outros totalmente livres tipo `"168 horas"` ou lista com nomes). Pra renderizar a tabela de verdade, o feed precisa entregar os dias **estruturados** (dia → turnos) — trilha **B3** do feed. No modelo, as tabelas foram montadas à mão a partir de dados reais.
- Os **rótulos em espanhol** (Masculino, Acompañante Terapéutico…) e o **fix do filtro Sexo** (que retornava mulheres ao filtrar "Masculino") **já estão em produção** no plugin — este rediseño é a camada visual seguinte.

---

## 7. Como o modelo foi construído (reprodutibilidade)

- Estilo real capturado com Playwright contra `jobs.enlite.health/es/` (fontes, cores, estilos computados do card).
- Fontes reais (`Poppins` 400/500/600/700 + `Lexend Deca`) baixadas do site e embutidas como `data:` URI → arquivo 100% autossuficiente.
- Responsivo por **container queries** (a tira reflowa pelo tamanho do container, por isso funciona até dentro do "celular" na página).
