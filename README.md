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
```

## Documentação da API

A documentação de rotas HTTP é gerada a partir do código e servida pela própria API:

```text
http://localhost:3001/docs (Swagger UI)
```

## WebSocket

A API utiliza Socket.IO para comunicação em tempo real.

Configuração atual:

- Origem permitida definida por `FRONTEND_URL`
- Transportes habilitados: `websocket` e `polling`
- Credenciais habilitadas para CORS
- Eventos tipados e documentados em `src/sockets/events.ts`

## Testes

Os testes ficam em `test/`, usando **Vitest** + **Supertest** contra o app Express real (`src/app.ts`), sem subir servidor HTTP nem depender da pasta `data/` — cada teste usa um arquivo JSON temporário isolado (`test/support/build-test-app.ts`).


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
├── config/            # Variáveis de ambiente, logger e caminhos de dados
├── database/          # Storage genérico em JSON + repositório base
├── docs/              # Registro OpenAPI e geração do documento servido em /docs
├── middleware/        # Tratamento de erros e middlewares HTTP
├── modules/
│   └── users/         # Model, types, repository, service, controller, routes e socket da entidade User
├── routes/            # Monta as rotas de cada módulo sob /api
├── sockets/           # Contratos e registro de conexões do Socket.IO
└── server.ts          # Ponto de entrada: cria o app, o socket.io e sobe o servidor

test/
├── support/                 # Helpers de teste (ex.: app com storage isolado)
├── health.test.ts           # Teste do health check
└── users.routes.test.ts     # Testes da rota /api/users
```

