/**
 * Login page translations for all supported locales.
 * Plain object lookup — no i18next library needed for the auth service.
 */

type LoginTranslations = Readonly<{
  title: string;
  email: string;
  sendCode: string;
  sending: string;
  otp: string;
  verify: string;
  verifying: string;
  checkEmail: string;
}>;

const translations: Readonly<Record<string, LoginTranslations>> = {
  en: {
    title: "Sign in",
    email: "Email",
    sendCode: "Send code",
    sending: "Sending\u2026",
    otp: "Verification code",
    verify: "Verify",
    verifying: "Verifying\u2026",
    checkEmail: "Check your email for an 8-digit code",
  },
  es: {
    title: "Iniciar sesi\u00f3n",
    email: "Correo electr\u00f3nico",
    sendCode: "Enviar c\u00f3digo",
    sending: "Enviando\u2026",
    otp: "C\u00f3digo de verificaci\u00f3n",
    verify: "Verificar",
    verifying: "Verificando\u2026",
    checkEmail: "Revisa tu correo para un c\u00f3digo de 8 d\u00edgitos",
  },
  zh: {
    title: "\u767b\u5f55",
    email: "\u90ae\u7bb1",
    sendCode: "\u53d1\u9001\u9a8c\u8bc1\u7801",
    sending: "\u53d1\u9001\u4e2d\u2026",
    otp: "\u9a8c\u8bc1\u7801",
    verify: "\u9a8c\u8bc1",
    verifying: "\u9a8c\u8bc1\u4e2d\u2026",
    checkEmail: "\u8bf7\u68c0\u67e5\u90ae\u7bb1\u4e2d\u7684 8 \u4f4d\u9a8c\u8bc1\u7801",
  },
  ru: {
    title: "\u0412\u0445\u043e\u0434",
    email: "Email",
    sendCode: "\u041e\u0442\u043f\u0440\u0430\u0432\u0438\u0442\u044c \u043a\u043e\u0434",
    sending: "\u041e\u0442\u043f\u0440\u0430\u0432\u043a\u0430\u2026",
    otp: "\u041a\u043e\u0434 \u043f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u0438\u044f",
    verify: "\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044c",
    verifying: "\u041f\u0440\u043e\u0432\u0435\u0440\u043a\u0430\u2026",
    checkEmail: "\u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043f\u043e\u0447\u0442\u0443 \u2014 \u043c\u044b \u043e\u0442\u043f\u0440\u0430\u0432\u0438\u043b\u0438 8-\u0437\u043d\u0430\u0447\u043d\u044b\u0439 \u043a\u043e\u0434",
  },
  uk: {
    title: "\u0412\u0445\u0456\u0434",
    email: "Email",
    sendCode: "\u041d\u0430\u0434\u0456\u0441\u043b\u0430\u0442\u0438 \u043a\u043e\u0434",
    sending: "\u041d\u0430\u0434\u0441\u0438\u043b\u0430\u043d\u043d\u044f\u2026",
    otp: "\u041a\u043e\u0434 \u043f\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0436\u0435\u043d\u043d\u044f",
    verify: "\u041f\u0456\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0438",
    verifying: "\u041f\u0435\u0440\u0435\u0432\u0456\u0440\u043a\u0430\u2026",
    checkEmail: "\u041f\u0435\u0440\u0435\u0432\u0456\u0440\u0442\u0435 \u043f\u043e\u0448\u0442\u0443 \u2014 \u043c\u0438 \u043d\u0430\u0434\u0456\u0441\u043b\u0430\u043b\u0438 8-\u0437\u043d\u0430\u0447\u043d\u0438\u0439 \u043a\u043e\u0434",
  },
  fa: {
    title: "\u0648\u0631\u0648\u062f",
    email: "\u0627\u06cc\u0645\u06cc\u0644",
    sendCode: "\u0627\u0631\u0633\u0627\u0644 \u06a9\u062f",
    sending: "\u062f\u0631 \u062d\u0627\u0644 \u0627\u0631\u0633\u0627\u0644\u2026",
    otp: "\u06a9\u062f \u062a\u0623\u06cc\u06cc\u062f",
    verify: "\u062a\u0623\u06cc\u06cc\u062f",
    verifying: "\u062f\u0631 \u062d\u0627\u0644 \u062a\u0623\u06cc\u06cc\u062f\u2026",
    checkEmail: "\u0627\u06cc\u0645\u06cc\u0644 \u062e\u0648\u062f \u0631\u0627 \u0628\u0631\u0627\u06cc \u06a9\u062f \u06f8 \u0631\u0642\u0645\u06cc \u0628\u0631\u0631\u0633\u06cc \u06a9\u0646\u06cc\u062f",
  },
  ar: {
    title: "\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644",
    email: "\u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a",
    sendCode: "\u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u0631\u0645\u0632",
    sending: "\u062c\u0627\u0631\u064d \u0627\u0644\u0625\u0631\u0633\u0627\u0644\u2026",
    otp: "\u0631\u0645\u0632 \u0627\u0644\u062a\u062d\u0642\u0642",
    verify: "\u062a\u062d\u0642\u0642",
    verifying: "\u062c\u0627\u0631\u064d \u0627\u0644\u062a\u062d\u0642\u0642\u2026",
    checkEmail: "\u062a\u062d\u0642\u0642 \u0645\u0646 \u0628\u0631\u064a\u062f\u0643 \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0644\u0644\u062d\u0635\u0648\u0644 \u0639\u0644\u0649 \u0631\u0645\u0632 \u0645\u0643\u0648\u0646 \u0645\u0646 8 \u0623\u0631\u0642\u0627\u0645",
  },
  he: {
    title: "\u05d4\u05ea\u05d7\u05d1\u05e8\u05d5\u05ea",
    email: "\u05d0\u05d9\u05de\u05d9\u05d9\u05dc",
    sendCode: "\u05e9\u05dc\u05d7 \u05e7\u05d5\u05d3",
    sending: "\u05e9\u05d5\u05dc\u05d7\u2026",
    otp: "\u05e7\u05d5\u05d3 \u05d0\u05d9\u05de\u05d5\u05ea",
    verify: "\u05d0\u05de\u05ea",
    verifying: "\u05de\u05d0\u05de\u05ea\u2026",
    checkEmail: "\u05d1\u05d3\u05d5\u05e7 \u05d0\u05ea \u05d4\u05d0\u05d9\u05de\u05d9\u05d9\u05dc \u05e9\u05dc\u05da \u05dc\u05e7\u05d5\u05d3 \u05d1\u05df 8 \u05e1\u05e4\u05e8\u05d5\u05ea",
  },
};

export const t = (locale: string, key: keyof LoginTranslations): string => {
  const strings = translations[locale] ?? translations.en;
  return strings[key];
};

export type { LoginTranslations };
