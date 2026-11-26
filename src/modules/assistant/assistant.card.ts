import { z } from 'zod';

export const QUICK_REPLY_CHOICES = ['yes', 'no', 'another', 'undo', 'done', 'snooze10', 'snooze60', 'send-now', 'keep'] as const;

export type QuickReplyChoice = (typeof QUICK_REPLY_CHOICES)[number];

export const quickReplyChoiceSchema = z.enum(QUICK_REPLY_CHOICES);

export const quickReplySchema = z.object({
  cardId: z.string().uuid(),
  choice: quickReplyChoiceSchema,
});

export type QuickReply = z.infer<typeof quickReplySchema>;

export interface AssistantLook {
  baseTheme?: string;
  colorTheme?: string;
  wallpaper?: string;
  appearance?: Partial<{
    overlayOpacity: number;
    overlayBlur: number;
    ownBubbleColor: string | null;
    ownBubbleOpacity: number;
    ownTextIntensity: number | null;
    otherBubbleColor: string | null;
    otherBubbleOpacity: number;
    otherTextIntensity: number | null;
    bubbleBlur: number;
  }>;
}

export const HELP_TOPICS = [
  'themes',
  'wallpaper',
  'bubbles',
  'calls',
  'screen-share',
  'gifs',
  'reactions',
  'profile-photo',
  'groups',
  'invite-link',
  'translation',
  'notifications',
  'install-app',
  'reminders',
  'scheduled-messages',
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

export type HelpTarget = 'appearance' | 'profile' | 'new-group' | 'notifications-settings' | 'install' | 'none';

export interface AssistantButton {
  choice: QuickReplyChoice;
  label: string;
}

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly';
  weekdays?: number[];
  interval?: number;
}

export type ConfirmAction =
  | { type: 'reminder'; text: string; fireAtLocal: string; timeZone: string; recurrence: Recurrence | null }
  | { type: 'status'; text: string; untilLocal: string; timeZone: string }
  | { type: 'scheduled-message'; roomId: string; recipient: string; text: string; sendAtLocal: string; timeZone: string }
  | { type: 'delete-note'; noteId: string; preview: string }
  | { type: 'cancel-reminder'; reminderId: string; preview: string };

export type AssistantCard =
  | { v: 1; kind: 'look-suggestion'; look: AssistantLook; buttons: AssistantButton[] }
  | { v: 1; kind: 'look-applied'; look: AssistantLook; previous: AssistantLook; buttons: AssistantButton[] }
  | { v: 1; kind: 'confirm'; action: ConfirmAction; buttons: AssistantButton[] }
  | { v: 1; kind: 'reminder-fired'; reminderId: string; text: string; buttons: AssistantButton[] }
  | { v: 1; kind: 'scheduled-failed'; roomId: string; text: string; buttons: AssistantButton[] }
  | { v: 1; kind: 'list'; title: string; items: { id: string; text: string; detail?: string }[] }
  | { v: 1; kind: 'help'; topic: HelpTopic; target: HelpTarget }
  | { v: 1; kind: 'capabilities' }
  | { v: 1; kind: 'choices'; buttons: AssistantButton[] };
