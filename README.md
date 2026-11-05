# CasaHub

App para organizar o dia a dia da família. Módulos: **lista de compras compartilhada** e **passeios**.

- Cada pessoa entra com e-mail e senha (Neon Auth). Quem não tem senha ou esqueceu recebe um código de 6 dígitos no e-mail e define a senha (`email-otp/reset-password`).
- Uma família é criada por alguém, que compartilha um **código de convite** com os outros.
- Lista única aberta por família, atualizada em tempo real em todos os celulares.
- Cerca de 100 itens comuns por seção do mercado; itens novos entram no catálogo da família.
- Ao finalizar, a lista vai para o histórico; os itens não comprados podem passar para a próxima lista.
- Histórico guardado por 5 semanas (limpeza diária automática no banco).
- Instalável no Android e no iPhone pela opção "Adicionar à tela de início" (PWA).

## Passeios

- Cada pessoa registra, no próprio celular, a chegada em um lugar (ex.: "Pé na Areia") e depois a volta para casa.
- A data e a hora **não são digitadas**: vêm do relógio do servidor no momento do toque. Mudar o relógio do celular não altera o registro.
- Os registros não podem ser incluídos, editados ou apagados pelo app; só pelas funções `passeio_chegar` e `passeio_voltar`.
- Um passeio pode ter várias paradas ("Mudou de lugar?"). Toque repetido no mesmo lugar em menos de 2 minutos não duplica.
- A aba mostra quem está fora de casa agora e os passeios dos últimos 30 dias.
- Tabelas: `passeios`, `passeio_paradas` (`db/0002_passeios.sql`).

## Sessão

- O login passa por `/api/auth` (função da Vercel que repassa ao Neon). O cookie de sessão é regravado como `SameSite=Lax`, sem `Partitioned`, para o iPhone e o Android manterem o login entre aberturas do app.
- A sessão do Neon vale 7 dias e é renovada a cada uso.

## Estrutura

| Pasta/arquivo | Conteúdo |
|---|---|
| `index.html`, `src/` | App web (HTML, CSS, JS), empacotado com Vite |
| `src/catalogo.js` | Seções e itens comuns |
| `public/` | Ícones, manifesto do app instalável e service worker |
| `db/0001_casahub.sql` | Tabelas, regras de acesso (RLS) e funções do banco |

## Banco (Neon)

- **Neon Auth** (login com e-mail e senha; código por e-mail só para criar ou trocar a senha) e **Data API** (acesso do navegador ao banco).
- Tabelas: `familias`, `membros`, `listas`, `itens`, `catalogo`, todas com RLS: só membros da família leem e alteram os dados dela. O usuário é identificado por `auth.user_id()`.
- Funções chamadas pelo app: `criar_familia`, `entrar_familia`, `lista_aberta`, `finalizar_lista`, `versao_familia`, `quem_sou`.
- O banco desliga após 5 min sem uso. Logo após acordar, a primeira requisição pode chegar sem a identificação do usuário; por isso o app chama `quem_sou` (com novas tentativas) antes de ler ou gravar.
- Histórico de 5 semanas: listas finalizadas há mais de 35 dias são apagadas sempre que a família abre ou finaliza uma lista.
- Atualização entre celulares: com o app aberto, ele consulta `versao_familia` a cada 4 segundos e recarrega só quando algo mudou.

## Projeto no Neon

- Projeto `CasaHub` (`royal-cell-09902152`), região São Paulo (aws-sa-east-1), branch `main`, banco `neondb`.

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
