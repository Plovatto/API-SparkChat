import { GoogleGenAI } from '@google/genai';
import type { Locale } from '../../sockets/socket-locale.js';
import { AI_FALLBACK_MODEL, AI_MAX_OUTPUT_TOKENS, AI_PRIMARY_MODEL, buildSystemInstruction } from './ai.model.js';

export interface AiInlineData {
  mimeType: string;
  data: string;
}

export interface AiConversationMessage {
  role: 'user' | 'model';
  text?: string;
  inlineData?: AiInlineData[];
}

export interface AiReplyOptions {
  locale: Locale;
}

export interface AiProvider {
  generateReply(messages: AiConversationMessage[], options: AiReplyOptions): Promise<string>;
}

function toGeminiParts(message: AiConversationMessage) {
  const parts: ({ text: string } | { inlineData: AiInlineData })[] = [];
  for (const item of message.inlineData ?? []) {
    parts.push({ inlineData: item });
  }
  if (message.text) {
    parts.push({ text: message.text });
  }
  return parts;
}

class GeminiModelProvider implements AiProvider {
  constructor(
    private readonly client: GoogleGenAI,
    private readonly model: string,
  ) {}

  async generateReply(messages: AiConversationMessage[], options: AiReplyOptions): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: messages.map((message) => ({ role: message.role, parts: toGeminiParts(message) })),
      config: {
        systemInstruction: buildSystemInstruction(options.locale),
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
      },
    });

    const text = response.text?.trim();
    if (!text) {
      throw new Error(`Resposta vazia do modelo ${this.model}.`);
    }

    return text;
  }
}

export class AiRouter implements AiProvider {
  constructor(private readonly providers: AiProvider[]) {}

  async generateReply(messages: AiConversationMessage[], options: AiReplyOptions): Promise<string> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.generateReply(messages, options);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Falha ao gerar resposta da IA.');
  }
}

export function createGeminiRouter(apiKey: string): AiRouter {
  const client = new GoogleGenAI({ apiKey });
  return new AiRouter([new GeminiModelProvider(client, AI_PRIMARY_MODEL), new GeminiModelProvider(client, AI_FALLBACK_MODEL)]);
}
