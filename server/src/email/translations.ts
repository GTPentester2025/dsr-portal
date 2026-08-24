import type { EmailTemplate } from './templates';

/**
 * System emails in the languages the portal's forms are offered in.
 *
 * A requester who filled in a Spanish form and then receives an English
 * verification link has been given a worse experience than if the form had been
 * English throughout — so the message follows the form, not the server.
 *
 * Only requester-facing messages are translated. Reminders and escalations go
 * to staff, who share a working language, and translating those would multiply
 * the maintenance for no reader.
 *
 * A missing language or key falls through to the English built-in, so a partial
 * translation never blocks a send.
 */
export const SUPPORTED_LANGUAGES = ['en', 'es', 'fr', 'de', 'nl', 'pt'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
  nl: 'Nederlands',
  pt: 'Português',
};

type Catalogue = Record<string, Record<string, EmailTemplate>>;

export const TRANSLATIONS: Catalogue = {
  es: {
    'verify-email': {
      subject: 'Confirme su dirección de correo electrónico',
      html: `<p>Para continuar con su solicitud de privacidad, confirme su dirección de correo electrónico mediante el siguiente enlace:</p>
<p><a href="{{verification_url}}">Confirmar mi dirección de correo electrónico</a></p>
<p>Este enlace caduca en {{ttl_minutes}} minutos y solo puede utilizarse una vez.</p>
<p>Si usted no ha iniciado una solicitud de privacidad, puede ignorar este mensaje.</p>`,
    },
    'submission-ack': {
      subject: 'Hemos recibido su solicitud de privacidad {{case_ref}}',
      html: `<p>Hemos recibido su solicitud de privacidad.</p>
<p>Su número de referencia es <strong>{{case_ref}}</strong>. Indíquelo en toda comunicación.</p>
<p>{{sla_statement}}</p>`,
    },
  },
  fr: {
    'verify-email': {
      subject: 'Confirmez votre adresse e-mail',
      html: `<p>Pour poursuivre votre demande relative à la protection des données, veuillez confirmer votre adresse e-mail à l'aide du lien ci-dessous :</p>
<p><a href="{{verification_url}}">Confirmer mon adresse e-mail</a></p>
<p>Ce lien expire dans {{ttl_minutes}} minutes et ne peut être utilisé qu'une seule fois.</p>
<p>Si vous n'êtes pas à l'origine de cette demande, vous pouvez ignorer ce message.</p>`,
    },
    'submission-ack': {
      subject: 'Votre demande {{case_ref}} a bien été reçue',
      html: `<p>Nous avons bien reçu votre demande relative à la protection des données.</p>
<p>Votre numéro de référence est <strong>{{case_ref}}</strong>. Merci de le rappeler dans toute correspondance.</p>
<p>{{sla_statement}}</p>`,
    },
  },
  de: {
    'verify-email': {
      subject: 'Bestätigen Sie Ihre E-Mail-Adresse',
      html: `<p>Um mit Ihrem Datenschutzantrag fortzufahren, bestätigen Sie bitte Ihre E-Mail-Adresse über den folgenden Link:</p>
<p><a href="{{verification_url}}">Meine E-Mail-Adresse bestätigen</a></p>
<p>Dieser Link läuft in {{ttl_minutes}} Minuten ab und kann nur einmal verwendet werden.</p>
<p>Falls Sie keinen Antrag gestellt haben, können Sie diese Nachricht ignorieren.</p>`,
    },
    'submission-ack': {
      subject: 'Ihr Datenschutzantrag {{case_ref}} ist eingegangen',
      html: `<p>Wir haben Ihren Datenschutzantrag erhalten.</p>
<p>Ihre Referenznummer lautet <strong>{{case_ref}}</strong>. Bitte geben Sie sie bei jedem Schriftwechsel an.</p>
<p>{{sla_statement}}</p>`,
    },
  },
  nl: {
    'verify-email': {
      subject: 'Bevestig uw e-mailadres',
      html: `<p>Om verder te gaan met uw privacyverzoek, bevestigt u uw e-mailadres via onderstaande link:</p>
<p><a href="{{verification_url}}">Mijn e-mailadres bevestigen</a></p>
<p>Deze link verloopt over {{ttl_minutes}} minuten en kan één keer worden gebruikt.</p>
<p>Hebt u zelf geen verzoek ingediend, dan kunt u dit bericht negeren.</p>`,
    },
    'submission-ack': {
      subject: 'Uw privacyverzoek {{case_ref}} is ontvangen',
      html: `<p>Wij hebben uw privacyverzoek ontvangen.</p>
<p>Uw referentienummer is <strong>{{case_ref}}</strong>. Vermeld dit bij alle correspondentie.</p>
<p>{{sla_statement}}</p>`,
    },
  },
  pt: {
    'verify-email': {
      subject: 'Confirme o seu endereço de e-mail',
      html: `<p>Para prosseguir com o seu pedido de privacidade, confirme o seu endereço de e-mail através da ligação abaixo:</p>
<p><a href="{{verification_url}}">Confirmar o meu endereço de e-mail</a></p>
<p>Esta ligação expira em {{ttl_minutes}} minutos e só pode ser utilizada uma vez.</p>
<p>Se não iniciou um pedido de privacidade, pode ignorar esta mensagem.</p>`,
    },
    'submission-ack': {
      subject: 'O seu pedido de privacidade {{case_ref}} foi recebido',
      html: `<p>Recebemos o seu pedido de privacidade.</p>
<p>O seu número de referência é <strong>{{case_ref}}</strong>. Indique-o em qualquer contacto.</p>
<p>{{sla_statement}}</p>`,
    },
  },
};

/** Requester-facing keys; everything else stays in the working language. */
export const TRANSLATABLE_KEYS = ['verify-email', 'submission-ack'];

export function translationFor(templateId: string, language: string): EmailTemplate | undefined {
  return TRANSLATIONS[language]?.[templateId];
}
