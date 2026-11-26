import type { z } from 'zod';
import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import type { AppServer } from '../../sockets/events.js';
import type { AiToolDeclaration } from '../ai/ai.provider.js';
import type { AssistantCard } from './assistant.card.js';

export interface AssistantContext {
  io: AppServer;
  userId: string;
  roomId: string;
  locale: Locale;
  timeZone: string;
  now: number;
}

export interface ToolResult {
  response: Record<string, unknown>;
  card?: AssistantCard;
}

export interface AssistantTool<Args = unknown> {
  declaration: AiToolDeclaration;
  schema: z.ZodType<Args>;
  run(args: Args, ctx: AssistantContext): Promise<ToolResult>;
}

export function defineTool<Args>(tool: AssistantTool<Args>): AssistantTool {
  return tool;
}

export class AssistantToolbox {
  private readonly tools = new Map<string, AssistantTool>();

  register(tool: AssistantTool): this {
    this.tools.set(tool.declaration.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  declarations(): AiToolDeclaration[] {
    return [...this.tools.values()].map((tool) => tool.declaration);
  }

  async run(name: string, args: Record<string, unknown>, ctx: AssistantContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { response: { error: 'unknown_tool' } };
    }
    const parsed = tool.schema.safeParse(args);
    if (!parsed.success) {
      return { response: { error: 'invalid_args' } };
    }
    try {
      return await tool.run(parsed.data, ctx);
    } catch (error) {
      logger.error({ err: error, tool: name, roomId: ctx.roomId }, 'Falha ao executar ferramenta do SparkAI');
      return { response: { error: 'tool_failed' } };
    }
  }
}
