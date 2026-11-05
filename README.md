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
| `index.html`, `src/` | App web (HTML, CSS, JS), empacotado com Vite |
| `src/catalogo.js` | Seções e itens comuns |
| `public/` | Ícones, manifesto do app instalável e service worker |
| `db/0001_casahub.sql` | Tabelas, regras de acesso (RLS) e funções do banco |

## Banco (Neon)

- **Neon Auth** (login por código enviado ao e-mail) e **Data API** (acesso do navegador ao banco).
- Tabelas: `familias`, `membros`, `listas`, `itens`, `catalogo`, todas com RLS: só membros da família leem e alteram os dados dela. O usuário é identificado por `auth.user_id()`.
- Funções chamadas pelo app: `criar_familia`, `entrar_familia`, `lista_aberta`, `finalizar_lista`, `versao_familia`.
- Histórico de 5 semanas: listas finalizadas há mais de 35 dias são apagadas sempre que a família abre ou finaliza uma lista.
- Atualização entre celulares: com o app aberto, ele consulta `versao_familia` a cada 4 segundos e recarrega só quando algo mudou.

## Configuração

Variável de ambiente (Vercel e `.env` local):

```
VITE_NEON_URL=https://ep-xxxx.c-2.sa-east-1.aws.neon.tech/neondb
```

É o endereço do Data API sem `.apirest` no host e sem `/rest/v1` no fim.

## Rodar localmente

```
npm install
npm run dev
```
