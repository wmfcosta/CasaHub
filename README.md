# CasaHub

App para organizar o dia a dia da família. Primeiro módulo: **lista de compras compartilhada**.

- Cada pessoa entra com o próprio e-mail (código de 6 dígitos, sem senha).
- Uma família é criada por alguém, que compartilha um **código de convite** com os outros.
- Lista única aberta por família, atualizada em tempo real em todos os celulares.
- Cerca de 100 itens comuns por seção do mercado; itens novos entram no catálogo da família.
- Ao finalizar, a lista vai para o histórico; os itens não comprados podem passar para a próxima lista.
- Histórico guardado por 5 semanas (limpeza diária automática no banco).
- Instalável no Android e no iPhone pela opção "Adicionar à tela de início" (PWA).

## Estrutura

| Pasta/arquivo | Conteúdo |
|---|---|
| `public/` | App web estático (HTML, CSS, JS) publicado pela Vercel |
| `public/config.js` | Endereço e chave pública do Supabase |
| `public/catalogo.js` | Seções e itens comuns |
| `supabase/migrations/` | Tabelas, regras de acesso (RLS), funções e rotina de limpeza |

## Banco (Supabase)

Tabelas: `familias`, `membros`, `listas`, `itens`, `catalogo`. Todas com RLS: só membros da família leem e alteram os dados dela.

Funções chamadas pelo app: `criar_familia`, `entrar_familia`, `lista_aberta`, `finalizar_lista`.
A rotina `casahub-limpar-historico` (pg_cron, diária) apaga listas finalizadas há mais de 35 dias.

### Configuração de login no painel do Supabase

1. **Authentication → URL Configuration**: em *Site URL* coloque o endereço da Vercel; adicione o mesmo em *Redirect URLs*.
2. **Authentication → Email Templates → Magic Link**: inclua `{{ .Token }}` no corpo do e-mail para o código de 6 dígitos aparecer (o app usa o código, que funciona também no app instalado no iPhone).

## Rodar localmente

```
npx serve public
```
