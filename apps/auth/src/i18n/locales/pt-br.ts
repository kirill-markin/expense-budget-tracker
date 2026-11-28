import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "Idioma",
  languageSearch: "Buscar idiomas",
  noLanguageMatches: "Nenhum idioma encontrado",
  title: "Entrar",
  email: "E-mail",
  sendCode: "Enviar código",
  sending: "Enviando…",
  otp: "Código de verificação",
  verify: "Verificar",
  verifying: "Verificando…",
  checkEmail: "Seu código de verificação tem 8 dígitos. Confira a caixa de entrada e, se necessário, a pasta de spam.",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "Erro interno do servidor",
  invalid_request_body: "Formato inválido da solicitação",
  invalid_email: "E-mail inválido",
  demo_sign_in_failed: "Não foi possível entrar no modo de demonstração",
  send_code_failed: "Não foi possível enviar o código. Tente novamente.",
  send_rate_limited: "Muitas solicitações. Aguarde antes de tentar novamente.",
  otp_session_expired: "Sua sessão expirou. Solicite um novo código.",
  invalid_otp_code: "Digite um código de 8 dígitos",
  verify_code_failed: "Não foi possível verificar o código. Tente novamente.",
  httpError: "Erro: {status}",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "Conectar um app | Expense Budget Tracker",
  heading: "Conectar {clientName} ao Expense Budget Tracker?",
  warningLabel: "Antes de continuar:",
  warning: "O próprio app informou o nome {clientName}. O Expense Budget Tracker não verificou quem opera esse app. Continue apenas se você iniciou a conexão e reconhece o destino abaixo.",
  callbackHeading: "Após autorizar, você voltará para",
  destinationNote: "O endereço ajuda você a reconhecer a conexão. Ele não confirma quem opera o app.",
  permissionsHeading: "Acesso ao Expense Budget Tracker",
  permissionsIntro: "Este app solicita estas permissões:",
  readLabel: "Permissão de leitura:",
  readDetails: "Ver todos os dados financeiros dos espaços de trabalho que você pode acessar.",
  writeLabel: "Permissão de escrita:",
  writeDetails: "Criar, alterar e excluir dados financeiros.",
  technicalDetails: "Detalhes técnicos",
  clientId: "ID do cliente",
  redirectUri: "URI de redirecionamento (valor exato)",
  resource: "Recurso solicitado",
  allow: "Permitir",
  deny: "Negar",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
