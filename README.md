# SparkChat API

API backend do SparkChat, desenvolvida com Node.js, TypeScript, Express e Socket.IO para uma aplicação de chat em tempo real.


## Funcionalidades

- Comunicação em tempo real com Socket.IO
- Registro de conexão e desconexão de clientes
- Configuração centralizada por variáveis de ambiente
- Tratamento de rotas não encontradas e erros da aplicação
- Tipagem dos eventos emitidos entre cliente e servidor
- Testes automatizados com Vitest

## Tecnologias

- [Node.js](https://nodejs.org/) 20+
- [TypeScript](https://www.typescriptlang.org/)
- [Express](https://expressjs.com/)
- [Socket.IO](https://socket.io/)
- [Zod](https://zod.dev/) - validação de variáveis de ambiente
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

## Endpoints

### Health Check

```http
GET /health
```

Resposta esperada:

```json
{
  "status": "ok",
  "uptime": 123.45
}
```

## WebSocket

A API utiliza Socket.IO para comunicação em tempo real.

Configuração atual:

- Origem permitida definida por `FRONTEND_URL`
- Transportes habilitados: `websocket` e `polling`
- Credenciais habilitadas para CORS
- Eventos tipados em `src/sockets/events.ts`

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
├── config/        # Variáveis de ambiente e logger
├── controllers/   # Orquestração entre entrada, regras de negócio e resposta
├── database/      # Base para camada de persistência
├── middleware/    # Tratamento de erros e middlewares HTTP
├── models/        # Base para entidades e acesso a dados
├── routes/        # Registro das rotas REST
├── services/      # Base para regras de negócio
├── sockets/       # Configuração e contratos do Socket.IO
├── utils/         # Funções auxiliares
└── server.ts      # Ponto de entrada da aplicação

test/
└── health.test.ts # Teste inicial da suíte
```

