const INTENT_PATTERN = new RegExp(
  [
    String.raw`\b(?:theme|wallpaper|papel de parede|tema|anota\w*|lembr\w*|remind\w*|agend\w*|schedule\w*|sugere\w*|sugira|suggest\w*|escolh\w*|aplica\w*|apply|pick)\b`,
    String.raw`\b(?:take a note|note (?:this|that|down)|salva\w* (?:uma )?nota)\b`,
    String.raw`\b(?:coloca\w*|p[oõ]e|muda\w*|troca\w*|set|change|cancela\w*|cancel|apaga\w*|delete)\b(?:\W+\w+){0,3}?\W+(?:status|look|visual|nota|notes?|lembrete\w*|reminders?)\b`,
  ].join('|'),
  'i',
);

const APPLY_PATTERN = /\b(?:escolh\w*|aplica\w*|coloca\w*|troca\w*|muda\w*|p[oõ]e|pick|apply|set|change)\b/i;

const CLAIM_PATTERN =
  /\b(?:anotad[oa]|apliquei|aplicad[oa]|agendad[oa]|lembrete (?:criado|agendado)|cart[aã]o|card|confirmar|confirma\?|noted|applied|scheduled|reminder (?:set|created)|saved|salvei)\b/i;

const IMMEDIATE_TOOLS = ['apply_look'];

export function actionIntentReason(userText: string, replyText: string): 'intent' | 'claim' | null {
  if (CLAIM_PATTERN.test(replyText)) {
    return 'claim';
  }
  if (INTENT_PATTERN.test(userText)) {
    return 'intent';
  }
  return null;
}

export function forcedToolNames(toolNames: readonly string[], userText: string): string[] {
  if (APPLY_PATTERN.test(userText)) {
    return [...toolNames];
  }
  return toolNames.filter((name) => !IMMEDIATE_TOOLS.includes(name));
}
