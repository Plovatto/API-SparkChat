export const ASSISTANT_NICKNAME = 'SparkAI';
export const ASSISTANT_NICKNAME_NORMALIZED = 'sparkai';
export const ASSISTANT_AVATAR = 1;
export const ASSISTANT_STATUS_TEXT = '100% pilha, 0% sono 🔋';

export const AI_WELCOME_MESSAGE =
  'Oi! Eu sou o SparkAI 🤖 — apareci aqui só pra gente trocar ideia. Manda o que quiser, é só um papo!';

export const AI_DAILY_MESSAGE_LIMIT = 50;
export const AI_CONTEXT_MESSAGE_LIMIT = 20;
export const AI_MAX_OUTPUT_TOKENS = 1024;

export const AI_MAX_TEXT_CHARS = 2000;
export const AI_MAX_TEXT_FILE_CHARS = 4000;

export const AI_MAX_IMAGE_DIMENSION = 768;
export const AI_IMAGE_JPEG_QUALITY = 70;

export const AI_MAX_AUDIO_SECONDS = 60;
export const AI_MAX_PDF_BYTES = 4 * 1024 * 1024;

export const AI_BATCH_DEBOUNCE_MS = 2500;

export const AI_PRIMARY_MODEL = 'gemini-3.5-flash-lite';
export const AI_FALLBACK_MODEL = 'gemini-3.1-flash-lite';

export const AI_SYSTEM_INSTRUCTION = [
  'Você é o SparkAI, o assistente de IA integrado ao SparkChat.',
  'Responda sempre em português do Brasil, a menos que a pessoa escreva em outro idioma.',
  'Seja direto, natural e simpático, como numa conversa de chat comum. Evite respostas muito longas.',
  'Você não tem acesso a outras conversas do usuário nem a informações fora desta conversa.',
].join(' ');
