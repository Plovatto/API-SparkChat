import { Router } from 'express';
import { createMessageRouter } from '../modules/messages/index.js';
import { createUserRouter, type LoginRateLimiter, type UserService } from '../modules/users/index.js';

export interface ApiRouterDeps {
  userService: UserService;
  loginRateLimiter: LoginRateLimiter;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  router.use('/users', createUserRouter(deps.userService, deps.loginRateLimiter));
  router.use('/messages', createMessageRouter());

  return router;
}
