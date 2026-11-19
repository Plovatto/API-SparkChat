function formatCallDuration(totalSeconds: number): string {
  const seconds = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

export const SYSTEM_EVENT_CATALOG = {
  'group.created': ({ actor }: { actor: string | null }) => `${actor ?? 'Alguém'} criou o grupo`,
  'group.memberJoined': ({ actor }: { actor: string }) => `${actor} entrou no grupo`,
  'group.memberLeft': ({ actor }: { actor: string }) => `${actor} saiu do grupo`,
  'group.memberRemoved': ({ target, actor }: { target: string; actor: string }) => `${target} foi removido do grupo por ${actor}`,
  'group.adminPromoted': ({ target, actor }: { target: string; actor: string }) =>
    `${target} foi promovido a administrador por ${actor}`,
  'call.ended': ({ kind, durationSec }: { kind: string; durationSec: string; callerId: string; reason: string }) =>
    `Chamada de ${kind === 'video' ? 'vídeo' : 'voz'} encerrada (${formatCallDuration(Number(durationSec))})`,
  'call.missed': ({ kind }: { kind: string; callerId: string; reason: string }) =>
    `Chamada de ${kind === 'video' ? 'vídeo' : 'voz'} perdida`,
  'ai.dailyLimitReached': () => 'Você atingiu o limite diário de mensagens com a IA. Tente novamente amanhã.',
  'ai.encryptionUnavailable': () =>
    'Não foi possível preparar a conversa criptografada. Tente enviar a mensagem novamente em instantes.',
  'ai.replyFailed': () => 'Não consegui responder agora. Tente novamente em instantes.',
} satisfies Record<string, (params: never) => string>;

export type SystemEventType = keyof typeof SYSTEM_EVENT_CATALOG;

export type SystemEventArgs<T extends SystemEventType> = Parameters<(typeof SYSTEM_EVENT_CATALOG)[T]>;

export type SystemEventParams = Record<string, string | null>;

export interface SystemEvent {
  type: SystemEventType;
  params: SystemEventParams;
}

export const SYSTEM_EVENT_TYPES = Object.keys(SYSTEM_EVENT_CATALOG) as [SystemEventType, ...SystemEventType[]];

export function systemEvent<T extends SystemEventType>(type: T, ...args: SystemEventArgs<T>): SystemEvent {
  const [params] = args as [SystemEventParams?];
  return { type, params: params ?? {} };
}

export function renderSystemEvent(event: SystemEvent): string {
  const render = SYSTEM_EVENT_CATALOG[event.type] as (params: SystemEventParams) => string;
  return render(event.params);
}
