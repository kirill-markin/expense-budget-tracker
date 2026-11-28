import type { getLoginFeedback } from "../browserErrors.js";
import type { getConsentTranslations } from "../consent.js";
import type { t } from "../translations.js";

export const login = {
  language: "言語",
  languageSearch: "言語を検索",
  noLanguageMatches: "該当する言語がありません",
  title: "ログイン",
  email: "メールアドレス",
  sendCode: "確認コードを送信",
  sending: "送信中…",
  otp: "確認コード",
  verify: "確認",
  verifying: "確認中…",
  checkEmail: "メールで届いた8桁の確認コードを入力してください。メールが見つからない場合は、迷惑メールフォルダも確認してください。",
} satisfies Record<Parameters<typeof t>[1], string>;

export const feedback = {
  internal_server_error: "サーバー内部でエラーが発生しました",
  invalid_request_body: "リクエストの内容が無効です",
  invalid_email: "メールアドレスの形式を確認してください",
  demo_sign_in_failed: "デモにログインできませんでした",
  send_code_failed: "確認コードを送信できませんでした。もう一度お試しください。",
  send_rate_limited: "リクエストが多すぎます。しばらく待ってから、もう一度お試しください。",
  otp_session_expired: "ログイン手続きの有効期限が切れました。ページを再読み込みし、確認コードの送信からやり直してください。",
  invalid_otp_code: "8桁の確認コードを入力してください",
  verify_code_failed: "コードを確認できませんでした。もう一度お試しください。",
  httpError: "エラー（{status}）",
} satisfies ReturnType<typeof getLoginFeedback>;

export const consent = {
  title: "アプリの接続 | Expense Budget Tracker",
  heading: "「{clientName}」を Expense Budget Tracker に接続しますか？",
  warningLabel: "続行する前にご確認ください。",
  warning: "表示名「{clientName}」はアプリ自身が指定したものです。Expense Budget Tracker はこのアプリの運営者を確認していません。ご自身でこの接続を開始し、下の戻り先に心当たりがある場合のみ続行してください。",
  callbackHeading: "許可後の戻り先",
  destinationNote: "戻り先は、意図した接続かどうかを判断する目安です。アプリの運営者を確認するものではありません。",
  permissionsHeading: "Expense Budget Tracker へのアクセス権限",
  permissionsIntro: "このアプリは次のアクセス権限を求めています。",
  readLabel: "読み取り権限：",
  readDetails: "あなたがアクセスできるワークスペースの財務データをすべて閲覧できます。",
  writeLabel: "書き込み権限：",
  writeDetails: "財務データの作成、変更、削除ができます。",
  technicalDetails: "技術情報",
  clientId: "クライアント ID",
  redirectUri: "リダイレクト URI（全文）",
  resource: "要求されたリソース",
  allow: "許可する",
  deny: "拒否する",
} satisfies ReturnType<typeof getConsentTranslations>["copy"];
