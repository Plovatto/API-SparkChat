import { Router } from 'express';
import { createLinkPreviewRouter, type LinkPreviewService } from '../modules/link-preview/index.js';
import { createMessageRouter } from '../modules/messages/index.js';
import { createUserRouter, type LoginRateLimiter, type UserService } from '../modules/users/index.js';

export interface ApiRouterDeps {
  userService: UserService;
  loginRateLimiter: LoginRateLimiter;
  linkPreviewService: LinkPreviewService;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const router = Router();

  router.use('/users', createUserRouter(deps.userService, deps.loginRateLimiter));
  router.use('/messages', createMessageRouter(deps.userService));
  router.use('/link-preview', createLinkPreviewRouter(deps.userService, deps.linkPreviewService));

  return router;
}
