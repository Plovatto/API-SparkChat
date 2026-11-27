import { describe, expect, it } from 'vitest';
import { AI_WELCOME_MESSAGES } from '@/modules/ai/ai.model.js';
import { buildAssistantInstruction } from '@/modules/assistant/assistant.prompt.js';

const BASE = { nowLocal: '2026-11-27T09:00', weekday: 'sexta-feira', timeZone: 'America/Sao_Paulo', catalogSummary: '', toolNames: ['show_capabilities', 'app_help'] };

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
    for (const part of ['2026-11-27T09:00', 'sexta-feira', 'America/Sao_Paulo', 'show_capabilities', 'app_help', 'CATALOG']) {
      expect(instruction).toContain(part);
    }
  });

  it.each(['pt', 'en'] as const)('only mentions tools that are registered in %s', (locale) => {
    const phaseOne = buildAssistantInstruction({ ...BASE, locale });
    expect(phaseOne).not.toContain('suggest_look');
    expect(phaseOne).not.toContain('apply_look');
    const withLook = buildAssistantInstruction({ ...BASE, locale, toolNames: ['suggest_look', 'apply_look'] });
    expect(withLook).toContain('suggest_look');
    expect(withLook).toContain('apply_look');
    expect(withLook).not.toContain('show_capabilities');
  });

  it.each([
    ['pt', ['Se faltar o horário', 'Nunca invente ids', 'Nunca diga que fez algo sem ter usado a ferramenta']],
    ['en', ['If the time is missing', 'Never make up ids', 'Never say you did something without having used the matching tool']],
  ] as const)('keeps the behavioral rules in %s', (locale, parts) => {
    const instruction = buildAssistantInstruction({ ...BASE, locale, toolNames: [] });
    for (const part of parts) {
      expect(instruction).toContain(part);
    }
  });

  it('includes the local time, time zone, tool rules and catalog summary', () => {
    const instruction = buildAssistantInstruction({ ...BASE, locale: 'pt', catalogSummary: 'Catálogo: aurora, mar' });
    expect(instruction).toContain('2026-11-27T09:00');
    expect(instruction).toContain('sexta-feira');
    expect(instruction).toContain('America/Sao_Paulo');
    expect(instruction).toContain('show_capabilities');
    expect(instruction).toContain('Catálogo: aurora, mar');
  });
});

describe('AI_WELCOME_MESSAGES', () => {
  it('says the assistant chats and helps and points to the capabilities list', () => {
    expect(AI_WELCOME_MESSAGES.pt).toBe(
      'Oi! Eu sou o SparkAI 🤖✨ Bato papo e também te dou uma mão de verdade: troco seu tema, anoto, te lembro das coisas e muito mais. Dá uma olhada no que eu sei fazer 👇',
    );
    expect(AI_WELCOME_MESSAGES.en).toContain('👇');
  });
});
