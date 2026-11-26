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
    expect(instruction).toContain('The language the person configured in SparkChat is English.');
    expect(instruction).toContain('Reply in English by default, but if the person writes in another language, reply in the language they wrote in.');
    expect(instruction).not.toContain('Responda');
  });

  it.each(['pt', 'en'] as const)('carries the key rules and context in %s', (locale) => {
    const instruction = buildAssistantInstruction({ ...BASE, locale, catalogSummary: 'CATALOG' });
    for (const part of ['2026-11-27T09:00', 'sexta-feira', 'America/Sao_Paulo', 'suggest_look', 'apply_look', 'CATALOG']) {
      expect(instruction).toContain(part);
    }
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
