// Replaced by scripts/build-binary.ts through Bun's `define`; never declared when
// running from a checkout, where `typeof` answers 'undefined' rather than throwing.
declare const PROMPTD_BUILD_VERSION: string | undefined;
declare const PROMPTD_BUILD_REPO: string | undefined;

/** The commit this binary was built from, which is also its release, or null when running from a checkout. */
export const BINARY_VERSION: string | null = typeof PROMPTD_BUILD_VERSION === 'string' ? PROMPTD_BUILD_VERSION : null;

/** The GitHub repository whose releases this binary updates from, such as promptilicious/promptd. */
export const BINARY_REPO: string | null = typeof PROMPTD_BUILD_REPO === 'string' ? PROMPTD_BUILD_REPO : null;
