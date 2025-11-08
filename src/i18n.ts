import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import HttpApi from 'i18next-http-backend';

i18n
  .use(HttpApi) // loads translations from your server
  .use(LanguageDetector) // detect user language
  .use(initReactI18next) // pass the i18n instance to react-i18next.
  .init({
    supportedLngs: ['en', 'ja'],
    fallbackLng: 'en',
    debug: true, // Set to false in production
    detection: {
      order: ['navigator'],
      caches: [],
    },
    backend: {
      loadPath: `${import.meta.env.BASE_URL}locales/{{lng}}/{{ns}}.json`,
    },
    react: {
      useSuspense: true, // this is important for non-web-vitals-focused apps
    },
  });

// Dynamically update the HTML lang attribute when the language changes
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng;
});

export default i18n;
