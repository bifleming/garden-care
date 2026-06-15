/* Garden Care PWA config.
   Paste the Google "Web application" OAuth Client ID here to enable phone
   reminders (Google Tasks sync). Until it's set, the Connect button explains
   that setup is needed. The client ID is NOT a secret — it's fine in a public
   repo (browser OAuth uses the page origin + user consent, no client secret). */
window.GC_CONFIG = {
  googleClientId: ""   // e.g. "1234567890-abc123.apps.googleusercontent.com"
};
