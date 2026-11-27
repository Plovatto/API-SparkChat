const INTENT_PATTERN =
  /\b(?:theme|visual|look|wallpaper|papel de parede|tema|anota\w*|nota|notes?|lembr\w*|remind\w*|status|agend\w*|schedule\w*|sugere\w*|sugira|suggest\w*|escolh\w*|aplica\w*|apply|cancela\w*|cancel|apaga\w*|delete)\b/i;

const CLAIM_PATTERN =
  /\b(?:anotad[oa]|apliquei|aplicad[oa]|agendad[oa]|lembrete (?:criado|agendado)|cart[aã]o|card|confirmar|confirma\?|noted|applied|scheduled|reminder (?:set|created)|saved|salvei)\b/i;

export function actionIntentReason(userText: string, replyText: string): 'intent' | 'claim' | null {
  if (CLAIM_PATTERN.test(replyText)) {
    return 'claim';
  }
  if (INTENT_PATTERN.test(userText)) {
    return 'intent';
  }
  return null;
}
