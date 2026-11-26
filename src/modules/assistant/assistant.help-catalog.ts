import type { Locale } from '../../lib/locale.js';
import type { HelpTarget, HelpTopic } from './assistant.card.js';

export const HELP_SHORTCUTS: ReadonlySet<string> = new Set(['/ajuda', '/help']);

export const HELP_SHORTCUT_REPLY: Record<Locale, string> = {
  pt: 'Claro! Olha o que eu sei fazer por aqui 👇',
  en: "Sure! Here's what I can do around here 👇",
};

export interface HelpEntry {
  target: HelpTarget;
  text: Record<Locale, string>;
}

export const HELP_CATALOG: Record<HelpTopic, HelpEntry> = {
  themes: {
    target: 'appearance',
    text: {
      pt: 'Abra o menu de temas do app para escolher o Modo Base e o Tema de Cores. Se quiser, eu também sugiro um tema para você!',
      en: "Open the app's theme menu to choose the Base Mode and the Color Theme. I can also suggest a theme for you!",
    },
  },
  wallpaper: {
    target: 'appearance',
    text: {
      pt: 'Abra as informações da conversa e toque em Papel de parede e bolhas para escolher o papel de parede. Dá para ajustar o desfoque e a opacidade para o texto continuar fácil de ler.',
      en: 'Open the conversation info and tap Wallpaper and bubbles to choose the wallpaper. You can adjust the blur and opacity so the text stays easy to read.',
    },
  },
  bubbles: {
    target: 'appearance',
    text: {
      pt: 'As bolhas ficam em Papel de parede e bolhas, nas informações da conversa. Lá você muda a cor, a opacidade e o desfoque das suas bolhas e das bolhas de quem fala com você.',
      en: "Bubbles live under Wallpaper and bubbles in the conversation info. There you change the color, opacity and blur of your bubbles and of the other person's.",
    },
  },
  calls: {
    target: 'none',
    text: {
      pt: 'Para ligar, abra uma conversa e toque em Ligar para chamada de voz ou em Vídeo para chamada de vídeo. A chamada continua mesmo se você minimizar o app.',
      en: 'To call, open a conversation and tap Call for a voice call or Video for a video call. The call keeps going even if you minimize the app.',
    },
  },
  'screen-share': {
    target: 'none',
    text: {
      pt: 'Durante uma chamada, toque no botão de compartilhar tela para mostrar o que está na sua tela para a outra pessoa. Toque de novo para parar de compartilhar quando quiser.',
      en: 'During a call, tap the share screen button to show what is on your screen to the other person. Tap it again to stop sharing whenever you like.',
    },
  },
  gifs: {
    target: 'none',
    text: {
      pt: 'Na caixa de mensagem, toque no botão de GIF para abrir a galeria. Você pode buscar pelo que quiser e tocar num GIF para enviar na hora.',
      en: 'In the message box, tap the GIF button to open the gallery. Search for anything and tap a GIF to send it right away.',
    },
  },
  reactions: {
    target: 'none',
    text: {
      pt: 'Pressione e segure uma mensagem (no computador, clique com o botão direito) e toque em Reagir para escolher um emoji. No mesmo menu você também pode apagar a mensagem.',
      en: 'Press and hold a message (on desktop, right-click) and tap React to pick an emoji. In the same menu you can also delete the message.',
    },
  },
  'profile-photo': {
    target: 'profile',
    text: {
      pt: 'Toque no seu perfil para abrir Editar perfil e use Trocar foto para escolher uma imagem. Você também pode remover a foto quando quiser.',
      en: 'Tap your profile to open Edit profile and use Change photo to pick an image. You can also remove the photo whenever you like.',
    },
  },
  groups: {
    target: 'new-group',
    text: {
      pt: 'Abra uma nova conversa e crie um grupo dando um nome a ele. Depois, quem entra pelo link de convite aparece no grupo. Também dá para trocar a foto do grupo.',
      en: 'Open a new conversation and create a group by giving it a name. After that, people who join through the invite link show up in the group. You can also change the group photo.',
    },
  },
  'invite-link': {
    target: 'none',
    text: {
      pt: 'Nas informações do grupo, em Link de convite, você copia o link para compartilhar. Qualquer pessoa com o link pode entrar, então compartilhe só com quem confia. Se precisar, redefina o link e o antigo deixa de funcionar.',
      en: 'In the group info, under Invite link, you copy the link to share. Anyone with the link can join, so share it only with people you trust. If needed, reset it and the old link stops working.',
    },
  },
  translation: {
    target: 'none',
    text: {
      pt: 'Toque em Traduzir no menu da mensagem para traduzir só ela. Nas informações da conversa também dá para ligar a tradução automática. A tradução acontece no seu aparelho.',
      en: 'Tap Translate in the message menu to translate just that message. In the conversation info you can also turn on automatic translation. Translation happens on your device.',
    },
  },
  notifications: {
    target: 'notifications-settings',
    text: {
      pt: 'Toque no sino no topo da lista de conversas para ativar ou desativar as notificações. Se o navegador pedir permissão, aceite para receber avisos de mensagens e chamadas com o app fechado.',
      en: 'Tap the bell at the top of the conversation list to turn notifications on or off. If the browser asks for permission, accept it to get message and call alerts while the app is closed.',
    },
  },
  'install-app': {
    target: 'install',
    text: {
      pt: 'Dá para instalar o SparkChat como app. Use o botão Instalar app do SparkChat ou a opção de instalar do menu do navegador, e ele abre direto da tela inicial.',
      en: 'You can install SparkChat as an app. Use the SparkChat Install app button or the install option in your browser menu, and it opens straight from your home screen.',
    },
  },
  reminders: {
    target: 'none',
    text: {
      pt: 'Peça aqui para mim, por exemplo: "me lembra de beber água às 15h". Eu aviso com uma notificação e posso repetir todo dia, toda semana ou todo mês.',
      en: 'Just ask me here, for example: "remind me to drink water at 3pm". I send you a notification and can repeat it every day, week or month.',
    },
  },
  'scheduled-messages': {
    target: 'none',
    text: {
      pt: 'Peça aqui para mim, por exemplo: "agenda uma mensagem para a Ana amanhã às 9h". Eu confirmo com você antes e a mensagem sai sozinha na hora marcada, em conversas privadas.',
      en: 'Just ask me here, for example: "schedule a message to Ana tomorrow at 9am". I confirm with you first and the message goes out on its own at the set time, in private chats.',
    },
  },
};
