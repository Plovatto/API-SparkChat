import { Router } from 'express';
import { createUserRouter } from './user.routes.js';
import type { UserService } from '../services/user.service.js';

export interface ApiRouterDeps {
  userService: UserService;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  router.use('/users', createUserRouter(deps.userService));

  return router;
}
