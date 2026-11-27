const WITHIN = String.raw`(?:\W+\w+){0,3}?\W+`;

const LOOK_OBJECTS = String.raw`(?:tema|visual|papel de parede|fundo|bal[oõ]es|theme|look|wallpaper|background|bubbles)`;
const APPLY_VERBS = String.raw`(?:aplica\w*|escolh\w*|coloca\w*|troca\w*|muda\w*|apply|pick|set|change)`;

const APPLY_PATTERN = new RegExp(String.raw`\b${APPLY_VERBS}\b${WITHIN}${LOOK_OBJECTS}\b`, 'i');

const NOTE_PATTERN = /\b(?:anota\w*|anote|toma nota|(?:salva|guarda)\w* (?:uma )?nota|note this|take a note|write (?:it |this )?down)\b/i;

const INTENT_PATTERN = new RegExp(
  [
    String.raw`\b(?:me lembra|lembre-me|lembre me|me avisa|me avise|remind me|set a reminder|cria\w* (?:um )?lembrete)\b`,
    String.raw`\b(?:sugere\w*|sugira|suggest\w*)\b${WITHIN}${LOOK_OBJECTS}\b`,
    String.raw`\b(?:agenda\w*|schedule\w*)\b${WITHIN}(?:mensagem|message)\b`,
    String.raw`\b(?:coloca\w*|p[oõ]e|muda\w*|troca\w*|set|change)\b${WITHIN}status\b`,
  ].join('|'),
  'i',
);

const CLAIM_PATTERN =
  /\b(?:anotei|anotad[oa]|apliquei|agendei|agendad[oa]|criei o lembrete|lembrete (?:criado|agendado)|i noted|noted!|i applied|i scheduled|i set (?:a|the) reminder|d[aá] uma olhada no (?:card|cart[aã]o)|olh[ae] o (?:card|cart[aã]o)|check the card)\b/i;

const NOTE_TOOLS = ['save_note'];
const APPLY_TOOLS = ['apply_look'];

export function actionIntentReason(userText: string, replyText: string): 'intent' | 'claim' | null {
  if (CLAIM_PATTERN.test(replyText)) {
    return 'claim';
  }
  if (NOTE_PATTERN.test(userText) || APPLY_PATTERN.test(userText) || INTENT_PATTERN.test(userText)) {
    return 'intent';
  }
  return null;
}

export function forcedToolNames(toolNames: readonly string[], userText: string): string[] {
  const noteAllowed = NOTE_PATTERN.test(userText);
  const applyAllowed = APPLY_PATTERN.test(userText);
  return toolNames.filter((name) => (NOTE_TOOLS.includes(name) ? noteAllowed : APPLY_TOOLS.includes(name) ? applyAllowed : true));
}
