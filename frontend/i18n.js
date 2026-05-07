// ─────────────────────────────────────────────────────────────────────────────
// Lull Mail — minimal i18n.
//
// Decision rule:
//   • System language starts with "fr" → French.
//   • Anything else → English.
//
// Override (in order of priority):
//   1. ?lang=fr|en URL param
//   2. localStorage 'lullmail.lang'
//   3. navigator.language
//
// Coverage as of v0.3.0:
//   • Onboarding wizard           — full
//   • Settings page               — full
//   • App shell (rail, modals)    — full
//   • Mailbox / Cleanup / Dashboard — FR only (English copy is a v0.4 milestone)
//
// API:
//   t('key.path')                 — returns localized string (falls back to en, then key)
//   t('greet', { name: 'Lou' })   — interpolates {name}
//   applyI18n(root = document)    — applies data-i18n attrs in a DOM subtree
//
// HTML attributes the apply function supports:
//   data-i18n="key"               → element.textContent
//   data-i18n-html="key"          → element.innerHTML (use only for trusted strings)
//   data-i18n-placeholder="key"   → element.placeholder
//   data-i18n-aria-label="key"    → aria-label attribute
//   data-i18n-title="key"         → title attribute
//
// Strings are kept inline (not split per page) so the whole table is grep-able
// and a single round-trip serves them — at this size, splitting is overkill.
// ─────────────────────────────────────────────────────────────────────────────

const STRINGS = {
  fr: {
    // ── App shell ─────────────────────────────────────────────────────────
    'app.title': 'Lull Mail',
    'rail.inbox': 'Boîte de réception',
    'rail.dashboard': 'Tableau de bord',
    'rail.cleanup': 'Nettoyage',
    'rail.cleanup.title': 'Nettoyage de la boîte',
    'rail.settings': 'Paramètres',
    'rail.theme': 'Basculer thème',
    'rail.theme.title': 'Basculer clair / sombre',
    'rail.account': 'Compte actif',
    'shortcuts.title': 'Raccourcis clavier',
    'shortcuts.close': 'Fermer',
    'shortcuts.next_prev': 'Mail suivant / précédent',
    'shortcuts.open': 'Ouvrir le mail sélectionné',
    'shortcuts.mark_read': 'Marquer comme lu',
    'shortcuts.go_inbox': 'Boîte de réception',
    'shortcuts.go_dashboard': 'Tableau de bord',
    'shortcuts.go_cleanup': 'Nettoyage',
    'shortcuts.compose': 'Composer',
    'shortcuts.search': 'Rechercher',
    'shortcuts.help': 'Afficher cette aide',
    'unsub.cancel': 'Annuler',
    'unsub.confirm': 'Se désabonner',

    // ── Onboarding ────────────────────────────────────────────────────────
    'ob.title': 'Configuration — Lull Mail',
    'ob.subtitle': 'Configurons votre boîte intelligente — quelques minutes suffisent.',

    'ob.step1.title': 'Bienvenue',
    'ob.step1.desc': 'Lull Mail trie, résume et priorise vos emails grâce à OpenAI. Saisissez votre clé API pour activer l\'IA, ou continuez sans IA pour un tri basique.',
    'ob.step1.key_label': 'Clé API OpenAI',
    'ob.step1.no_key_prefix': 'Pas encore de clé ?',
    'ob.step1.no_key_link': 'Créez-en une ici',
    'ob.step1.model_label': 'Modèle (optionnel)',
    'ob.step1.model_mini': 'gpt-4o-mini — recommandé (rapide & abordable)',
    'ob.step1.model_mini_short': 'recommandé',
    'ob.step1.model_4o': 'gpt-4o — plus précis, plus cher',
    'ob.step1.model_4o_short': 'plus précis, plus cher',
    'ob.step1.cta': 'Continuer',
    'ob.step1.skip_cta': 'Utiliser sans IA',
    'ob.step1.skip_hint': 'Pas de clé ? Vous pouvez utiliser Lull Mail sans IA — le tri restera basique mais fonctionnel. Vous pourrez activer l\'IA plus tard depuis les Réglages.',

    'ob.step2.title': 'Vos comptes email',
    'ob.step2.desc': "Ajoutez au moins un compte. Vous pouvez en ajouter d'autres plus tard depuis les réglages.",
    'ob.step2.choose_provider': 'Choisir un fournisseur',
    'ob.step2.name_label': 'Nom du compte',
    'ob.step2.name_ph': 'Boulot, Perso…',
    'ob.step2.email_label': 'Adresse email',
    'ob.step2.email_ph': 'vous@exemple.com',
    'ob.step2.password_label': "Mot de passe IMAP / Mot de passe d'application",
    'ob.step2.password_ph': 'Votre mot de passe',
    'ob.step2.app_pwd_link': "Créer un mot de passe d'application",
    'ob.step2.advanced': 'Réglages avancés (serveur IMAP, port, SSL)',
    'ob.step2.host_label': 'Serveur IMAP',
    'ob.step2.host_ph': 'imap.exemple.com',
    'ob.step2.port_label': 'Port',
    'ob.step2.ssl': 'SSL/TLS',
    'ob.step2.starttls': 'STARTTLS',
    'ob.step2.verify': 'Vérifier le certificat',
    'ob.step2.test': 'Tester la connexion',
    'ob.step2.add': 'Ajouter ce compte',
    'ob.step2.added_label': 'Comptes ajoutés',
    'ob.step2.no_accounts': 'Aucun compte pour le moment.',
    'ob.step2.remove': 'Retirer',
    'ob.step2.back': 'Retour',
    'ob.step2.cta': 'Continuer',

    'ob.step3.title': 'Notifications mobiles (optionnel)',
    'ob.step3.desc_html': 'Recevez une notification push quand un email vraiment important arrive. Utilise <a href="https://ntfy.sh" target="_blank" style="color: var(--accent);" class="underline">ntfy.sh</a> — gratuit, pas de compte requis.',
    'ob.step3.toggle_title': 'Activer les notifications push',
    'ob.step3.toggle_sub': 'Une alerte sur votre téléphone quand un email vraiment urgent arrive.',
    'ob.step3.topic_label': 'Topic ntfy (choisissez un nom unique difficile à deviner)',
    'ob.step3.topic_ph': 'lullmail-vous-x7k2p',
    'ob.step3.random': 'Aléatoire',
    'ob.step3.topic_hint_html': "Installez l'app ntfy (<a href=\"https://ntfy.sh/app\" target=\"_blank\" style=\"color: var(--accent);\" class=\"underline\">App Store / Play Store</a>) puis abonnez-vous à ce topic.",
    'ob.step3.min_label': "Score d'importance minimum (1-10)",
    'ob.step3.scale_low': '1 (tout)',
    'ob.step3.scale_mid': 'et plus',
    'ob.step3.scale_high': '10 (urgent)',
    'ob.step3.back': 'Retour',
    'ob.step3.skip': 'Passer',
    'ob.step3.finish': 'Terminer',

    'ob.step4.title': 'Tout est prêt',
    'ob.step4.desc': 'Lull Mail va commencer à analyser vos emails. La première synchronisation peut prendre quelques minutes selon la taille de vos boîtes.',
    'ob.step4.starting': 'Démarrage des services…',
    'ob.step4.ok': '✓ Services email actifs.',
    'ob.step4.fail_hint': 'Vous pouvez quand même ouvrir le dashboard, ou retourner aux étapes précédentes pour corriger.',
    'ob.step4.open_dashboard': 'Ouvrir le dashboard',

    'ob.toast.openai_required': 'Veuillez entrer votre clé API OpenAI.',
    'ob.toast.providers_failed': 'Échec du chargement des fournisseurs : {error}',
    'ob.toast.added': 'Compte {email} ajouté.',
    'ob.toast.error': 'Erreur : {error}',
    'ob.toast.invalid_email': 'Adresse email invalide.',
    'ob.toast.host_required': 'Serveur IMAP requis.',
    'ob.toast.password_required': 'Mot de passe requis.',
    'ob.toast.topic_required': 'Choisissez un topic ntfy ou passez cette étape.',
    'ob.confirm.remove': 'Retirer {email} ?',

    'ob.busy.testing': 'Test en cours…',
    'ob.busy.adding': 'Ajout…',
    'ob.busy.working': 'Travail…',

    'ob.test.ok': '✓ Connexion OK',
    'ob.test.ok_count': '✓ Connexion OK — {count} dossiers détectés.',
    'ob.test.err_prefix': '✗',

    'ob.help.aide_officielle': 'Aide officielle ↗',

    // Provider help (overrides backend help text so it can be localized)
    'provider.gmail.help': "Activez la 2FA puis créez un \"Mot de passe d'application\" (Compte Google → Sécurité). Collez les 16 caractères ci-dessous.",
    'provider.outlook.help': "Si vous avez la 2FA, créez un mot de passe d'application via account.microsoft.com → Sécurité → Options de sécurité avancées.",
    'provider.proton.help': "Installez et lancez Proton Mail Bridge. Pour chaque adresse, ouvrez \"Configure email client\" et copiez le mot de passe affiché.",
    'provider.yahoo.help': "Yahoo exige un \"Mot de passe d'application\" : Compte → Sécurité du compte → Générer un mot de passe d'application.",
    'provider.icloud.help': "Créez un mot de passe pour app sur appleid.apple.com → Connexion et sécurité → Mots de passe pour application.",
    'provider.orange.help': "Utilisez votre mot de passe Orange habituel. Si vous avez la double-validation, générez un mot de passe d'application.",
    'provider.ovh.help': "Mot de passe défini lors de la création de la boîte (espace client OVH → Webmail / Mail Plan).",
    'provider.free.help': 'Mot de passe de votre compte Free.',
    'provider.imap.help': "Renseignez manuellement le serveur IMAP fourni par votre hébergeur mail.",

    // Provider hints (placeholders shown in the form when provider is selected)
    // Provider names — only the ones that need localising. Brand names
    // (Gmail, Outlook, Yahoo…) come straight from the backend and don't
    // belong here. Missing keys cause a fall-back to the backend name.
    'provider.custom.name': 'Autre serveur IMAP',
    'provider.ovh.name':    'OVH (mail pro)',

    'provider.gmail.email_ph':   'vous@gmail.com',
    'provider.outlook.email_ph': 'vous@outlook.com',
    'provider.yahoo.email_ph':   'vous@yahoo.com',
    'provider.proton.email_ph':  'vous@pm.me',
    'provider.orange.email_ph':  'vous@orange.fr',
    'provider.ovh.email_ph':     'vous@votre-domaine.fr',
    'provider.icloud.email_ph':  'vous@icloud.com',
    'provider.free.email_ph':    'vous@free.fr',
    'provider.imap.email_ph':    'vous@exemple.com',
    'provider.gmail.password_ph':   "xxxx xxxx xxxx xxxx (mot de passe d'application)",
    'provider.outlook.password_ph': "Mot de passe Microsoft ou mot de passe d'application",
    'provider.yahoo.password_ph':   "Mot de passe d'application Yahoo (16 caractères)",
    'provider.proton.password_ph':  'Mot de passe affiché par Proton Bridge',
    'provider.orange.password_ph':  'Votre mot de passe Orange',
    'provider.ovh.password_ph':     'Mot de passe de votre boîte OVH',
    'provider.icloud.password_ph':  'Mot de passe pour app Apple',
    'provider.free.password_ph':    'Votre mot de passe Free',
    'provider.imap.password_ph':    'Votre mot de passe IMAP',
  },

  en: {
    // ── App shell ─────────────────────────────────────────────────────────
    'app.title': 'Lull Mail',
    'rail.inbox': 'Inbox',
    'rail.dashboard': 'Dashboard',
    'rail.cleanup': 'Cleanup',
    'rail.cleanup.title': 'Mailbox cleanup',
    'rail.settings': 'Settings',
    'rail.theme': 'Toggle theme',
    'rail.theme.title': 'Toggle light / dark',
    'rail.account': 'Active account',
    'shortcuts.title': 'Keyboard shortcuts',
    'shortcuts.close': 'Close',
    'shortcuts.next_prev': 'Next / previous email',
    'shortcuts.open': 'Open the selected email',
    'shortcuts.mark_read': 'Mark as read',
    'shortcuts.go_inbox': 'Inbox',
    'shortcuts.go_dashboard': 'Dashboard',
    'shortcuts.go_cleanup': 'Cleanup',
    'shortcuts.compose': 'Compose',
    'shortcuts.search': 'Search',
    'shortcuts.help': 'Show this help',
    'unsub.cancel': 'Cancel',
    'unsub.confirm': 'Unsubscribe',

    // ── Onboarding ────────────────────────────────────────────────────────
    'ob.title': 'Setup — Lull Mail',
    'ob.subtitle': "Let's set up your inbox — a few minutes is enough.",

    'ob.step1.title': 'Welcome',
    'ob.step1.desc': 'Lull Mail sorts, summarises and prioritises your emails using OpenAI. Enter your API key to enable AI, or continue without AI for basic sorting.',
    'ob.step1.key_label': 'OpenAI API key',
    'ob.step1.no_key_prefix': "Don't have a key yet?",
    'ob.step1.no_key_link': 'Create one here',
    'ob.step1.model_label': 'Model (optional)',
    'ob.step1.model_mini': 'gpt-4o-mini — recommended (fast & affordable)',
    'ob.step1.model_mini_short': 'recommended',
    'ob.step1.model_4o': 'gpt-4o — more accurate, more expensive',
    'ob.step1.model_4o_short': 'more accurate, more expensive',
    'ob.step1.cta': 'Continue',
    'ob.step1.skip_cta': 'Use without AI',
    'ob.step1.skip_hint': 'No key? You can use Lull Mail without AI — sorting will be basic but functional. You can enable AI later from Settings.',

    'ob.step2.title': 'Your email accounts',
    'ob.step2.desc': 'Add at least one account. You can add more later from settings.',
    'ob.step2.choose_provider': 'Choose a provider',
    'ob.step2.name_label': 'Account name',
    'ob.step2.name_ph': 'Work, Personal…',
    'ob.step2.email_label': 'Email address',
    'ob.step2.email_ph': 'you@example.com',
    'ob.step2.password_label': 'IMAP password / App password',
    'ob.step2.password_ph': 'Your password',
    'ob.step2.app_pwd_link': 'Create an app password',
    'ob.step2.advanced': 'Advanced settings (IMAP host, port, SSL)',
    'ob.step2.host_label': 'IMAP host',
    'ob.step2.host_ph': 'imap.example.com',
    'ob.step2.port_label': 'Port',
    'ob.step2.ssl': 'SSL/TLS',
    'ob.step2.starttls': 'STARTTLS',
    'ob.step2.verify': 'Verify certificate',
    'ob.step2.test': 'Test connection',
    'ob.step2.add': 'Add this account',
    'ob.step2.added_label': 'Added accounts',
    'ob.step2.no_accounts': 'No account yet.',
    'ob.step2.remove': 'Remove',
    'ob.step2.back': 'Back',
    'ob.step2.cta': 'Continue',

    'ob.step3.title': 'Mobile notifications (optional)',
    'ob.step3.desc_html': 'Get a push notification when a really important email arrives. Uses <a href="https://ntfy.sh" target="_blank" style="color: var(--accent);" class="underline">ntfy.sh</a> — free, no account required.',
    'ob.step3.toggle_title': 'Enable push notifications',
    'ob.step3.toggle_sub': 'An alert on your phone when a really urgent email lands.',
    'ob.step3.topic_label': 'ntfy topic (pick a unique, hard-to-guess name)',
    'ob.step3.topic_ph': 'lullmail-you-x7k2p',
    'ob.step3.random': 'Random',
    'ob.step3.topic_hint_html': 'Install the ntfy app (<a href="https://ntfy.sh/app" target="_blank" style="color: var(--accent);" class="underline">App Store / Play Store</a>) then subscribe to this topic.',
    'ob.step3.min_label': 'Minimum importance score (1-10)',
    'ob.step3.scale_low': '1 (everything)',
    'ob.step3.scale_mid': 'and above',
    'ob.step3.scale_high': '10 (urgent)',
    'ob.step3.back': 'Back',
    'ob.step3.skip': 'Skip',
    'ob.step3.finish': 'Finish',

    'ob.step4.title': "You're all set",
    'ob.step4.desc': 'Lull Mail will start analysing your emails. The first sync may take a few minutes depending on the size of your mailboxes.',
    'ob.step4.starting': 'Starting services…',
    'ob.step4.ok': '✓ Email services running.',
    'ob.step4.fail_hint': 'You can still open the dashboard, or go back to fix earlier steps.',
    'ob.step4.open_dashboard': 'Open the dashboard',

    'ob.toast.openai_required': 'Please enter your OpenAI API key.',
    'ob.toast.providers_failed': 'Failed to load providers: {error}',
    'ob.toast.added': '{email} added.',
    'ob.toast.error': 'Error: {error}',
    'ob.toast.invalid_email': 'Invalid email address.',
    'ob.toast.host_required': 'IMAP host required.',
    'ob.toast.password_required': 'Password required.',
    'ob.toast.topic_required': 'Pick an ntfy topic or skip this step.',
    'ob.confirm.remove': 'Remove {email}?',

    'ob.busy.testing': 'Testing…',
    'ob.busy.adding': 'Adding…',
    'ob.busy.working': 'Working…',

    'ob.test.ok': '✓ Connection OK',
    'ob.test.ok_count': '✓ Connection OK — {count} folders detected.',
    'ob.test.err_prefix': '✗',

    'ob.help.aide_officielle': 'Official help ↗',

    // Provider help
    'provider.gmail.help': 'Enable 2FA, then create an "App password" (Google account → Security). Paste the 16 characters below.',
    'provider.outlook.help': 'If you have 2FA enabled, create an app password from account.microsoft.com → Security → Advanced security options.',
    'provider.proton.help': 'Install and run Proton Mail Bridge. For each address, open "Configure email client" and copy the displayed password.',
    'provider.yahoo.help': 'Yahoo requires an "App password": Account → Account security → Generate app password.',
    'provider.icloud.help': 'Create an app-specific password at appleid.apple.com → Sign-in and security → App-specific passwords.',
    'provider.orange.help': 'Use your normal Orange password. If you have two-step verification, generate an app password.',
    'provider.ovh.help': 'The password set when the mailbox was created (OVH customer area → Webmail / Mail Plan).',
    'provider.free.help': 'Your Free account password.',
    'provider.imap.help': 'Manually enter the IMAP server provided by your mail host.',

    'provider.custom.name': 'Other IMAP server',
    'provider.ovh.name':    'OVH (business mail)',

    'provider.gmail.email_ph':   'you@gmail.com',
    'provider.outlook.email_ph': 'you@outlook.com',
    'provider.yahoo.email_ph':   'you@yahoo.com',
    'provider.proton.email_ph':  'you@pm.me',
    'provider.orange.email_ph':  'you@orange.fr',
    'provider.ovh.email_ph':     'you@yourdomain.com',
    'provider.icloud.email_ph':  'you@icloud.com',
    'provider.free.email_ph':    'you@free.fr',
    'provider.imap.email_ph':    'you@example.com',
    'provider.gmail.password_ph':   'xxxx xxxx xxxx xxxx (app password)',
    'provider.outlook.password_ph': 'Microsoft password or app password',
    'provider.yahoo.password_ph':   'Yahoo app password (16 characters)',
    'provider.proton.password_ph':  'Password shown by Proton Bridge',
    'provider.orange.password_ph':  'Your Orange password',
    'provider.ovh.password_ph':     'Your OVH mailbox password',
    'provider.icloud.password_ph':  'Apple app-specific password',
    'provider.free.password_ph':    'Your Free password',
    'provider.imap.password_ph':    'Your IMAP password',
  },
};

function detectLocale() {
  try {
    const url = new URL(window.location.href);
    const q = url.searchParams.get('lang');
    if (q === 'en' || q === 'fr') return q;
    const stored = localStorage.getItem('lullmail.lang');
    if (stored === 'en' || stored === 'fr') return stored;
  } catch (_) { /* ignore (file://, sandbox, …) */ }
  const nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  return nav.startsWith('fr') ? 'fr' : 'en';
}

const LOCALE = detectLocale();

function t(key, vars) {
  let s = (STRINGS[LOCALE] && STRINGS[LOCALE][key]) || STRINGS.en[key] || key;
  if (vars) {
    for (const k of Object.keys(vars)) {
      s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]);
    }
  }
  return s;
}

function applyI18n(root) {
  const r = root || document;
  r.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  r.querySelectorAll('[data-i18n-html]').forEach(el => {
    el.innerHTML = t(el.dataset.i18nHtml);
  });
  r.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  r.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
  r.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.setAttribute('title', t(el.dataset.i18nTitle));
  });
}

window.t = t;
window.applyI18n = applyI18n;
window.LULLMAIL_LOCALE = LOCALE;

document.documentElement.lang = LOCALE;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => applyI18n());
} else {
  applyI18n();
}
