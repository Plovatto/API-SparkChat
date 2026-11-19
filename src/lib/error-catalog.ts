export type UploadKind = 'image' | 'audio' | 'file';

const UPLOAD_KIND_LABELS: Record<UploadKind, string> = {
  image: 'imagem',
  audio: 'áudio',
  file: 'arquivo',
};

const UPLOAD_MISSING_FILE_MESSAGES: Record<UploadKind, string> = {
  image: 'Nenhuma imagem enviada.',
  audio: 'Nenhum áudio enviado.',
  file: 'Nenhum arquivo enviado.',
};

const UPLOAD_ACCEPTED_TYPES: Record<UploadKind, string> = {
  image: 'JPEG, PNG, GIF ou WEBP',
  audio: 'WEBM, OGG, MP4, AAC, MPEG ou WAV',
  file: 'PDF, vídeo (MP4, WEBM, MOV, AVI), documento do Office, ZIP, TXT ou CSV',
};

export const ERROR_CATALOG = {
  'auth.required': () => 'Autenticação necessária.',
  'auth.sessionInvalid': () => 'Sessão inválida ou expirada.',
  'auth.sessionExpired': () => 'Sessão inválida ou expirada. Faça login novamente.',
  'auth.unauthenticated': () => 'Usuário não autenticado.',
  'auth.missingCredentials': () => 'Nickname e senha são obrigatórios!',
  'auth.invalidCredentials': () => 'Nickname ou senha inválidos.',
  'auth.loginFailed': () => 'Erro ao entrar. Tente novamente!',
  'auth.keyfileRequired': () => 'Arquivo de recuperação é obrigatório!',
  'auth.keyfileInvalid': () => 'Arquivo de recuperação inválido.',
  'user.notFound': () => 'Usuário não encontrado.',
  'user.nicknameRequired': () => 'Nickname é obrigatório!',
  'user.nicknameCheckFailed': () => 'Erro ao verificar nickname. Tente novamente!',
  'user.nicknameInvalid': ({ minLength, maxLength, minLetters }: { minLength: number; maxLength: number; minLetters: number }) =>
    `Nickname deve ter entre ${minLength} e ${maxLength} caracteres, usando apenas letras e números, com pelo menos ${minLetters} letras.`,
  'user.nicknameTaken': () => 'Esse nickname já está em uso.',
  'user.passwordTooShort': ({ minLength }: { minLength: number }) => `A senha deve ter pelo menos ${minLength} caracteres.`,
  'user.passwordTooLong': ({ maxLength }: { maxLength: number }) => `A senha deve ter no máximo ${maxLength} caracteres.`,
  'user.currentPasswordIncorrect': () => 'Senha atual incorreta.',
  'user.currentPasswordRequired': () =>
    'Informe a senha atual. A troca sem a senha atual só é permitida uma vez, nos 10 minutos seguintes à entrada com o arquivo de recuperação.',
  'user.credentialsInvalid': () => 'Credenciais em formato inválido.',
  'user.credentialsIncomplete': () => 'Dados de credenciais incompletos. Atualize o aplicativo e tente novamente.',
  'user.credentialsAlreadyUpgraded': () => 'Esta conta já usa o formato de credenciais atual.',
  'room.notFound': () => 'Sala não encontrada.',
  'room.invalidCode': () => 'Formato de código inválido.',
  'room.selfConversation': () => 'Você não pode iniciar uma conversa consigo mesmo.',
  'room.promoteRequiresAdmin': () => 'Apenas administradores podem promover outros membros.',
  'room.removeRequiresAdmin': () => 'Apenas administradores podem remover membros.',
  'room.cannotRemoveSelf': () => 'Use a opção de sair do grupo para se remover.',
  'room.notMember': () => 'Usuário não faz parte do grupo.',
  'message.notFound': () => 'Mensagem não encontrada.',
  'message.deleteForbidden': () => 'Você não tem permissão para deletar esta mensagem.',
  'message.invalidMedia': () => 'Conteúdo de mídia inválido.',
  'message.blocked': () => 'Você não pode enviar mensagens nesta conversa devido a bloqueios.',
  'e2e.lookupTooLarge': ({ maxItems }: { maxItems: number }) => `Consulta de chaves com itens demais. Envie no máximo ${maxItems} por vez.`,
  'e2e.keysLocked': () => 'As chaves de criptografia desta conta já estão configuradas e não podem ser substituídas.',
  'upload.missingFile': ({ kind }: { kind: UploadKind }) => UPLOAD_MISSING_FILE_MESSAGES[kind],
  'upload.tooLarge': ({ kind, maxSize }: { kind: UploadKind; maxSize: string }) =>
    `O ${UPLOAD_KIND_LABELS[kind]} excede o tamanho máximo permitido de ${maxSize}.`,
  'upload.invalidType': ({ kind }: { kind: UploadKind }) =>
    `Tipo de arquivo inválido. Envie ${UPLOAD_KIND_LABELS[kind]} ${UPLOAD_ACCEPTED_TYPES[kind]}.`,
  'upload.contentMismatch': () => 'O conteúdo do arquivo não corresponde ao tipo declarado.',
  'upload.quotaExceeded': () => 'Limite de armazenamento do servidor atingido. Tente novamente mais tarde.',
  'upload.userQuotaExceeded': () => 'Você atingiu o seu limite de armazenamento. Apague arquivos antigos para enviar novos.',
  'linkPreview.invalidUrl': () => 'URL inválida.',
  'linkPreview.unavailable': () => 'Não foi possível gerar um preview para essa URL.',
  'linkPreview.imageUnavailable': () => 'Não foi possível carregar essa imagem.',
  'rateLimit.api': () => 'Muitas requisições em pouco tempo. Aguarde e tente novamente.',
  'rateLimit.linkPreview': () => 'Muitas requisições de preview. Aguarde um momento e tente novamente.',
  'rateLimit.upload': () => 'Muitos envios de arquivo. Aguarde um momento e tente novamente.',
  'rateLimit.loginAttempts': () => 'Muitas tentativas de login. Tente novamente mais tarde.',
  'rateLimit.passwordAttempts': () => 'Muitas tentativas de senha. Tente novamente mais tarde.',
  'rateLimit.resumeAttempts': () => 'Muitas tentativas de reconexão. Aguarde um instante.',
  'rateLimit.registrations': () => 'Muitas contas criadas a partir deste endereço. Tente novamente mais tarde.',
  'rateLimit.messages': () => 'Você está enviando mensagens muito rápido. Aguarde um instante.',
  'rateLimit.roomJoin': () => 'Muitas tentativas de entrar com código. Tente novamente mais tarde.',
  'rateLimit.roomCreate': () => 'Muitos grupos criados em pouco tempo. Tente novamente mais tarde.',
  'rateLimit.socket': () => 'Muitas ações em pouco tempo. Aguarde um instante.',
  'validation.invalidPayload': () => 'Dados inválidos.',
  'internal.unexpected': () => 'Erro inesperado.',
  'internal.routeNotFound': ({ method, path }: { method: string; path: string }) => `Route not found: ${method} ${path}`,
} satisfies Record<string, (params: never) => string>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export type ErrorArgs<C extends ErrorCode> = Parameters<(typeof ERROR_CATALOG)[C]>;

export type ErrorParams = Record<string, string | number>;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as [ErrorCode, ...ErrorCode[]];

export function renderErrorMessage<C extends ErrorCode>(code: C, ...args: ErrorArgs<C>): string {
  const render = ERROR_CATALOG[code] as (...renderArgs: ErrorArgs<C>) => string;
  return render(...args);
}
