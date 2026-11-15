import { renderErrorMessage, type ErrorArgs, type ErrorCode, type ErrorParams } from './error-catalog.js';

export interface ErrorPayload {
  message: string;
  code: ErrorCode;
  params?: ErrorParams;
}

export function errorPayload<C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): ErrorPayload {
  const message = renderErrorMessage(code, ...args);
  const [params] = args as [ErrorParams?];
  return params ? { message, code, params } : { message, code };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams | undefined;

  private constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = 'AppError';
    this.code = payload.code;
    this.params = payload.params;
  }

  static of<C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): AppError {
    return new AppError(errorPayload(code, ...args));
  }

  toPayload(): ErrorPayload {
    return this.params ? { message: this.message, code: this.code, params: this.params } : { message: this.message, code: this.code };
  }
}
