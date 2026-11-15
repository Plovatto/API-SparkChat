import { describe, expect, it } from 'vitest';
import { AI_WELCOME_MESSAGES, buildSystemInstruction } from '@/modules/ai/ai.model.js';

describe('buildSystemInstruction', () => {
  it('keeps portuguese as the default reply language for pt', () => {
    expect(buildSystemInstruction('pt')).toBe(
      [
        'Você é o SparkAI, o assistente de IA integrado ao SparkChat.',
        'O idioma configurado pela pessoa no SparkChat é português do Brasil.',
        'Responda em português do Brasil por padrão, mas, se a pessoa escrever em outro idioma, responda no idioma em que ela escreveu.',
        'Seja direto, natural e simpático, como numa conversa de chat comum. Evite respostas muito longas.',
        'Você não tem acesso a outras conversas do usuário nem a informações fora desta conversa.',
      ].join(' '),
    );
  });

  it('sets english as the default reply language for en while following the language the person writes in', () => {
    const instruction = buildSystemInstruction('en');

    expect(instruction).toContain('O idioma configurado pela pessoa no SparkChat é inglês.');
    expect(instruction).toContain('Responda em inglês por padrão, mas, se a pessoa escrever em outro idioma, responda no idioma em que ela escreveu.');
  });
});

describe('AI_WELCOME_MESSAGES', () => {
  it('keeps the current portuguese welcome text', () => {
    expect(AI_WELCOME_MESSAGES.pt).toBe(
      'Oi! Eu sou o SparkAI 🤖 — apareci aqui só pra gente trocar ideia. Manda o que quiser, é só um papo!',
    );
  });
});
