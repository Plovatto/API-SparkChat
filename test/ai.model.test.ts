import { describe, expect, it } from 'vitest';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { buildAssistantInstruction } from '@/modules/assistant/assistant.prompt.js';

const BASE = { nowLocal: '2026-11-27T09:00', weekday: 'sexta-feira', timeZone: 'America/Sao_Paulo', catalogSummary: '' };

describe('buildAssistantInstruction', () => {
  it('keeps portuguese as the default reply language for pt', () => {
    const instruction = buildAssistantInstruction({ ...BASE, locale: 'pt' });
    expect(instruction).toContain('Você é o SparkAI, o assistente de IA integrado ao SparkChat.');
    expect(instruction).toContain('Responda em português do Brasil por padrão, mas, se a pessoa escrever em outro idioma, responda no idioma em que ela escreveu.');
  });

  it('sets english as the default reply language for en while following the language the person writes in', () => {
    const instruction = buildAssistantInstruction({ ...BASE, locale: 'en' });
    expect(instruction).toContain('O idioma configurado pela pessoa no SparkChat é inglês.');
    expect(instruction).toContain('Responda em inglês por padrão, mas, se a pessoa escrever em outro idioma, responda no idioma em que ela escreveu.');
  });

  it('includes the local time, time zone, tool rules and catalog summary', () => {
    const instruction = buildAssistantInstruction({ ...BASE, locale: 'pt', catalogSummary: 'Catálogo: aurora, mar' });
    expect(instruction).toContain('2026-11-27T09:00');
    expect(instruction).toContain('sexta-feira');
    expect(instruction).toContain('America/Sao_Paulo');
    expect(instruction).toContain('suggest_look');
    expect(instruction).toContain('apply_look');
    expect(instruction).toContain('Catálogo: aurora, mar');
  });
});

describe('AI_WELCOME_MESSAGES', () => {
  it('keeps the current portuguese welcome text', () => {
    expect(AI_WELCOME_MESSAGES.pt).toBe(
      'Oi! Eu sou o SparkAI 🤖 — apareci aqui só pra gente trocar ideia. Manda o que quiser, é só um papo!',
    );
  });
});
