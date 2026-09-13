// Version of the consent texts published on the site: the date of the text kept
// in clients/sf-sofa/legal/. Sent with every lead (form.js, quiz.js) and stored
// with the cookie choice (consent.js). No side effects, so this module is safe
// to bundle into any script.
//
// When a consent text changes: add the new date to
// lead-service/src/consent-versions.mjs and deploy the service first, then
// change it here and deploy the site.
export const CONSENT_VERSION = '2026-09-13';
