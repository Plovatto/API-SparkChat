import { randomUUID } from 'node:crypto';
import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import { logger } from '../../config/logger.js';
import type { Locale } from '../../lib/locale.js';
import { AI_FALLBACK_MODEL, AI_MAX_OUTPUT_TOKENS, AI_PRIMARY_MODEL } from './ai.model.js';

export interface AiInlineData {
  mimeType: string;
  data: string;
}

export interface AiToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface AiToolResponse {
  id: string;
  name: string;
  response: Record<string, unknown>;
}

export interface AiConversationMessage {
  role: 'user' | 'model';
  text?: string;
  inlineData?: AiInlineData[];
  functionCall?: AiToolCall[];
  functionResponse?: AiToolResponse[];
}

export interface AiToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface AiToolConfig {
  mode: 'AUTO' | 'ANY' | 'NONE';
  allowedFunctionNames?: string[];
}

export interface AiGenerateOptions {
  locale: Locale;
  systemInstruction: string;
  tools: AiToolDeclaration[];
  toolConfig?: AiToolConfig;
}

export interface AiTurn {
  text: string;
  calls: AiToolCall[];
}

export interface AiProvider {
  generate(messages: AiConversationMessage[], options: AiGenerateOptions): Promise<AiTurn>;
}

interface GeminiPart {
  text?: string;
  inlineData?: AiInlineData;
  functionCall?: { id: string; name: string; args: Record<string, unknown> };
  functionResponse?: { id: string; name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

function toGeminiParts(message: AiConversationMessage): GeminiPart[] {
  const parts: GeminiPart[] = [];
  for (const item of message.inlineData ?? []) {
    parts.push({ inlineData: item });
  }
  if (message.text) {
    parts.push({ text: message.text });
  }
  for (const call of message.functionCall ?? []) {
    parts.push({
      functionCall: { id: call.id, name: call.name, args: call.args },
      ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
    });
  }
  for (const item of message.functionResponse ?? []) {
    parts.push({ functionResponse: { id: item.id, name: item.name, response: item.response } });
  }
  return parts;
}

function extractCalls(response: GenerateContentResponse): AiToolCall[] {
  const signatures = new Map<string, string>();
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.functionCall?.name && part.thoughtSignature) {
      signatures.set(part.functionCall.id ?? part.functionCall.name, part.thoughtSignature);
    }
  }

  const calls: AiToolCall[] = [];
  for (const call of response.functionCalls ?? []) {
    if (!call.name) {
      continue;
    }
    const signature = signatures.get(call.id ?? call.name);
    calls.push({
      id: call.id ?? randomUUID(),
      name: call.name,
      args: call.args ?? {},
      ...(signature ? { thoughtSignature: signature } : {}),
    });
  }
  return calls;
}

export interface GeminiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
  };
}

class MalformedFunctionCallError extends Error {
  constructor() {
    super('MALFORMED_FUNCTION_CALL');
  }
}

function stripToolParts(messages: AiConversationMessage[]): AiConversationMessage[] {
  const stripped: AiConversationMessage[] = [];
  for (const message of messages) {
    const responses = (message.functionResponse ?? []).map((item) => `${item.name}: ${JSON.stringify(item.response)}`);
    const text = [message.text, ...responses].filter((value): value is string => Boolean(value)).join('\n');
    if (!text && !message.inlineData?.length) {
      continue;
    }
    stripped.push({
      role: message.role,
      ...(text ? { text } : {}),
      ...(message.inlineData ? { inlineData: message.inlineData } : {}),
    });
  }
  return stripped;
}

export class GeminiModelProvider implements AiProvider {
  constructor(
    private readonly client: GeminiClient,
    private readonly model: string,
  ) {}

  async generate(messages: AiConversationMessage[], options: AiGenerateOptions): Promise<AiTurn> {
    if (options.tools.length === 0) {
      return this.request(messages, options);
    }

    try {
      return await this.request(messages, options);
    } catch (error) {
      const malformed = error instanceof MalformedFunctionCallError;
      if (!malformed && !(error instanceof ApiError && error.status === 400)) {
        throw error;
      }
      logger.warn(
        { model: this.model, code: malformed ? 'MALFORMED_FUNCTION_CALL' : 400 },
        'Gemini rejeitou a requisição com ferramentas; repetindo sem ferramentas',
      );
    }

    const plain = await this.request(stripToolParts(messages), { locale: options.locale, systemInstruction: options.systemInstruction, tools: [] });
    return { text: plain.text, calls: [] };
  }

  private async request(messages: AiConversationMessage[], options: AiGenerateOptions): Promise<AiTurn> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: messages.map((message) => ({ role: message.role, parts: toGeminiParts(message) })),
      config: {
        systemInstruction: options.systemInstruction,
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        ...(options.tools.length > 0
          ? {
              tools: [
                {
                  functionDeclarations: options.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    ...(tool.parameters ? { parametersJsonSchema: tool.parameters } : {}),
                  })),
                },
              ],
              ...(options.toolConfig
                ? {
                    toolConfig: {
                      functionCallingConfig: {
                        mode: FunctionCallingConfigMode[options.toolConfig.mode],
                        ...(options.toolConfig.allowedFunctionNames ? { allowedFunctionNames: options.toolConfig.allowedFunctionNames } : {}),
                      },
                    },
                  }
                : {}),
            }
          : {}),
      },
    });

    const calls = extractCalls(response);
    const text = response.text?.trim() ?? '';
    if (!text && calls.length === 0) {
      if (response.candidates?.[0]?.finishReason === FinishReason.MALFORMED_FUNCTION_CALL) {
        throw new MalformedFunctionCallError();
      }
      throw new Error(`Resposta vazia do modelo ${this.model}.`);
    }

    return { text, calls };
  }
}

export class AiRouter implements AiProvider {
  constructor(private readonly providers: AiProvider[]) {}

  async generate(messages: AiConversationMessage[], options: AiGenerateOptions): Promise<AiTurn> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.generate(messages, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Falha ao gerar resposta da IA.');
  }
}

export function createGeminiRouter(apiKey: string): AiRouter {
  const client = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  return new AiRouter([new GeminiModelProvider(client, AI_PRIMARY_MODEL), new GeminiModelProvider(client, AI_FALLBACK_MODEL)]);
}
