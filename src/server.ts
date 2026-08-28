import cors from 'cors';
import express from 'express';
import { createServer } from 'node:http';
import { pinoHttp } from 'pino-http';
import { Server } from 'socket.io';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { router } from './routes/index.js';
import { registerSocketHandlers } from './sockets/index.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './sockets/events.js';

const app = express();
const httpServer = createServer(app);

const io = new Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(httpServer, {
  cors: {
    origin: [env.FRONTEND_URL],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(pinoHttp({ logger }));

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.use('/api', router);

app.use(notFoundHandler);
app.use(errorHandler);

registerSocketHandlers(io);

httpServer.listen(env.PORT, () => {
  logger.info(`Server running on port ${env.PORT}`);
  logger.info(`Frontend URL: ${env.FRONTEND_URL}`);
  logger.info(`Environment: ${env.NODE_ENV}`);
});

httpServer.on('error', (err) => {
  logger.error({ err }, 'Server failed to start');
  process.exit(1);
});
