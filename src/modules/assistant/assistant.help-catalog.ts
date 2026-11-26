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
      pt: 'Abra as informações da conversa e toque em Aparência para trocar o tema. Dá para escolher a cor e o estilo do app. Se quiser, eu também sugiro um tema para você!',
      en: 'Open the conversation info panel and tap Appearance to change the theme. You can pick the color and style of the app. I can also suggest a theme for you!',
    },
  },
  wallpaper: {
    target: 'appearance',
    text: {
      pt: 'No painel de informações da conversa, em Aparência, você escolhe o papel de parede. Pode usar um dos prontos e ajustar o desfoque e a opacidade para o texto continuar fácil de ler.',
      en: 'In the conversation info panel, under Appearance, you choose the wallpaper. Pick a ready-made one and adjust the blur and opacity so the text stays easy to read.',
    },
  },
  bubbles: {
    target: 'appearance',
    text: {
      pt: 'As bolhas de mensagem ficam em Aparência, no painel de informações da conversa. Lá você muda a cor, a opacidade e o desfoque das suas bolhas e das bolhas de quem fala com você.',
      en: "Message bubbles live under Appearance in the conversation info panel. There you change the color, opacity and blur of your bubbles and of the other person's.",
    },
  },
  calls: {
    target: 'none',
    text: {
      pt: 'Para ligar, abra uma conversa e toque no ícone de chamada de voz ou de vídeo no topo. Dá para silenciar o microfone, ligar ou desligar a câmera, e a chamada continua mesmo se você minimizar o app.',
      en: 'To call, open a conversation and tap the voice or video call icon at the top. You can mute the microphone, turn the camera on or off, and the call keeps going even if you minimize the app.',
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
      pt: 'Pressione e segure uma mensagem para reagir com um emoji. No mesmo menu você também pode apagar a mensagem só para você.',
      en: 'Press and hold a message to react with an emoji. In the same menu you can also delete the message just for yourself.',
    },
  },
  'profile-photo': {
    target: 'profile',
    text: {
      pt: 'Abra o seu perfil e toque na foto para escolher uma imagem da galeria ou tirar uma na hora. Você pode ajustar o enquadramento antes de salvar.',
      en: 'Open your profile and tap the photo to pick an image from your gallery or take one on the spot. You can adjust the framing before saving.',
    },
  },
  groups: {
    target: 'new-group',
    text: {
      pt: 'Toque em novo grupo, escolha as pessoas, dê um nome e pronto. Depois você pode ajustar a foto e convidar mais gente quando quiser.',
      en: 'Tap new group, pick the people, give it a name and you are done. Later you can adjust the photo and invite more people whenever you like.',
    },
  },
  'invite-link': {
    target: 'new-group',
    text: {
      pt: 'Nas informações do grupo, quem administra pode gerar um link de convite. Compartilhe o link e quem abrir entra no grupo. Dá para desativar o link a qualquer momento.',
      en: 'In the group info, admins can generate an invite link. Share the link and anyone who opens it joins the group. You can turn the link off at any time.',
    },
  },
  translation: {
    target: 'none',
    text: {
      pt: 'Você pode traduzir mensagens direto pelo menu da mensagem. A tradução acontece no seu aparelho, então o texto não sai dele para ser traduzido.',
      en: 'You can translate messages right from the message menu. Translation happens on your device, so the text never leaves it to be translated.',
    },
  },
  notifications: {
    target: 'notifications-settings',
    text: {
      pt: 'Nas configurações de notificações você liga ou desliga os avisos de mensagens e chamadas. Se o navegador pedir permissão, é só aceitar para receber os avisos mesmo com o app fechado.',
      en: 'In the notification settings you turn message and call alerts on or off. If the browser asks for permission, just accept it to get alerts even when the app is closed.',
    },
  },
  'install-app': {
    target: 'install',
    text: {
      pt: 'Dá para instalar o SparkChat como app no celular ou no computador. Use a opção de instalar do navegador ou o botão de instalar do SparkChat, e ele abre direto da tela inicial.',
      en: "You can install SparkChat as an app on your phone or computer. Use your browser's install option or the SparkChat install button, and it opens straight from your home screen.",
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
