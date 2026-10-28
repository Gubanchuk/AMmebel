// Published versions of the consent texts, oldest first. A lead is stored only
// when its consent.version is listed here, so every consent_version in the
// database leads back to an exact text kept in clients/sf-sofa/legal/ or in git
// history (legal/07-teksty-dlya-sajta.md, section 5).
//
// New consent text: add its date here and deploy the service, then change
// CONSENT_VERSION in frontend/src/scripts/consent-version.js and deploy the
// site. Remove a date once its text must no longer be accepted.
export const CONSENT_VERSIONS = Object.freeze(['2026-09-13', '2026-10-03', '2026-10-04', '2026-10-08', '2026-10-28']);
