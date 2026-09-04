import { GoogleGenAI } from '@google/genai';
import { AI_FALLBACK_MODEL, AI_MAX_OUTPUT_TOKENS, AI_PRIMARY_MODEL, AI_SYSTEM_INSTRUCTION } from './ai.model.js';

export interface AiInlineData {
  mimeType: string;
  data: string;
}

export interface AiConversationMessage {
  role: 'user' | 'model';
  text?: string;
  inlineData?: AiInlineData[];
}

export interface AiProvider {
  generateReply(messages: AiConversationMessage[]): Promise<string>;
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

  async generateReply(messages: AiConversationMessage[]): Promise<string> {
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: messages.map((message) => ({ role: message.role, parts: toGeminiParts(message) })),
      config: {
        systemInstruction: AI_SYSTEM_INSTRUCTION,
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

  async generateReply(messages: AiConversationMessage[]): Promise<string> {
    let lastError: unknown;

    for (const provider of this.providers) {
      try {
        return await provider.generateReply(messages);
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
