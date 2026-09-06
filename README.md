# SparkChat API

API backend do SparkChat, desenvolvida com Node.js, TypeScript, Express e Socket.IO para uma aplicação de chat em tempo real.


## Funcionalidades

- Comunicação em tempo real com Socket.IO
- Registro de conexão e desconexão de clientes
- Configuração centralizada por variáveis de ambiente
- Tratamento de rotas não encontradas e erros da aplicação
- Tipagem dos eventos emitidos entre cliente e servidor
- Testes automatizados com Vitest
- Documentação interativa (Swagger UI) gerada a partir dos schemas Zod

## Tecnologias

- [Node.js](https://nodejs.org/) 20+
- [TypeScript](https://www.typescriptlang.org/)
- [Express](https://expressjs.com/)
- [Socket.IO](https://socket.io/)
- [Zod](https://zod.dev/) - validação de requisições e variáveis de ambiente
- [zod-to-openapi](https://github.com/asteasolutions/zod-to-openapi) + [Swagger UI](https://github.com/scottie1984/swagger-ui-express) - documentação da API
- [Pino](https://getpino.io/) - logging estruturado
- [Vitest](https://vitest.dev/) - testes automatizados
- ESLint - análise e padronização do código

## Como Executar

### Pré-requisitos

Antes de começar, tenha instalado:

- [Node.js](https://nodejs.org/)
- npm

### Instalação

Clone o repositório:

```bash
git clone https://github.com/Plovatto/API-SparkChat.git
```

Acesse a pasta do projeto:

```bash
cd API-SparkChat
```

Instale as dependências:

```bash
npm install
```

Crie o arquivo de variáveis de ambiente:

```bash
cp .env.example .env
```

Execute em modo de desenvolvimento:

```bash
npm run dev
```

A API estará disponível em:

```text
http://localhost:3001
```

## Variáveis de Ambiente

As variáveis são definidas no arquivo `.env`, que não deve ser versionado.

Utilize `.env.example` como referência:

```env
NODE_ENV=development
PORT=3001
FRONTEND_URL=http://localhost:5173
LOG_LEVEL=info
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
RECOVERY_FILE_SECRET=
GEMINI_API_KEY=
AI_ASSISTANT_PRIVATE_KEY=
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=
R2_PUBLIC_BASE_URL=
```

`R2_*` configura o armazenamento de arquivos enviados (imagem, áudio, arquivo) no Cloudflare R2, usado no lugar de disco local para funcionar em hospedagens sem disco persistente.

## Documentação da API

A documentação de rotas REST e de eventos Socket.IO é gerada a partir do código e servida na mesma página:

```text
http://localhost:3001/docs (Swagger UI + seção "Eventos Socket.IO")
```

## WebSocket

A API utiliza Socket.IO para comunicação em tempo real.

Configuração atual:

- Origem permitida definida por `FRONTEND_URL`
- Transportes habilitados: `websocket` e `polling`
- Credenciais habilitadas para CORS

## Testes

Os testes ficam em `test/`, usando **Vitest** + **Supertest** contra o app Express real (`src/app.ts`), sem subir servidor HTTP — cada teste usa um banco libSQL isolado em memória (`test/support/create-test-db.ts`), sem tocar no Turso real.


## Scripts

| Comando              | Descrição                                             |
| -------------------- | ----------------------------------------------------- |
| `npm run dev`        | Inicia o servidor em modo de desenvolvimento          |
| `npm run build`      | Compila o TypeScript para a pasta `dist`              |
| `npm start`          | Executa a versão compilada da API                     |
| `npm run typecheck`  | Executa a checagem de tipos sem gerar arquivos        |
| `npm run lint`       | Executa a análise do código com ESLint                |
| `npm run lint:fix`   | Corrige problemas de lint automaticamente             |
| `npm test`           | Executa a suíte de testes com Vitest                  |
| `npm run test:watch` | Executa os testes em modo de observação               |

## Estrutura do Projeto

```text
src/
├── app.ts             # Monta o Express app (usado em produção e nos testes)
├── config/            # Variáveis de ambiente, logger e caminhos de upload
├── database/          # Schema Drizzle, client Turso/libSQL e migrations
├── docs/              # Registro OpenAPI, registro de eventos Socket.IO e geração da página /docs
├── lib/               # Utilitários compartilhados entre módulos (ex.: contador de janela deslizante)
├── middleware/        # Autenticação, rate limit, wrapper async e tratamento de erros HTTP
├── modules/
│   ├── ai/            # Assistente SparkAI (identidade E2E, provider Gemini, limites e resposta)
│   ├── link-preview/  # Preview de links (fetch com proteção SSRF, cache e proxy de imagem)
│   ├── messages/      # Mensagens, uploads, presença, digitação e gravação
│   ├── rooms/         # Salas privadas e grupos, chaves E2E de sala
│   └── users/         # Contas, sessões, arquivo de recuperação e chaves E2E do usuário
├── routes/            # Monta as rotas de cada módulo sob /api
├── sockets/           # Contratos, helpers e registro de conexões do Socket.IO
└── server.ts          # Ponto de entrada: cria o app, o socket.io e sobe o servidor

test/
├── support/           # Helpers de teste (app e serviços com banco em memória isolado)
└── *.test.ts          # Testes unitários e de rota de cada módulo
```

