// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			/** Anonymous per-visitor id from the klym_sid cookie; scopes all storage. */
			owner: string;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/** Build stamp injected by vite `define` (see vite.config.ts). */
	const __APP_COMMIT__: string;
	const __APP_UPDATED__: string;
}

export {};
