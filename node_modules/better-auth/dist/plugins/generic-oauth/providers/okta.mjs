//#region src/plugins/generic-oauth/providers/okta.ts
/**
* Okta OAuth provider helper
*
* @example
* ```ts
* import { genericOAuth, okta } from "better-auth/plugins/generic-oauth";
*
* export const auth = betterAuth({
*   plugins: [
*     genericOAuth({
*       config: [
*         okta({
*           clientId: process.env.OKTA_CLIENT_ID,
*           clientSecret: process.env.OKTA_CLIENT_SECRET,
*           issuer: process.env.OKTA_ISSUER,
*         }),
*       ],
*     }),
*   ],
* });
* ```
*/
function okta(options) {
	const defaultScopes = [
		"openid",
		"profile",
		"email"
	];
	const issuer = options.issuer.replace(/\/$/, "");
	return {
		providerId: "okta",
		accountIssuer: issuer,
		discoveryUrl: `${issuer}/.well-known/openid-configuration`,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		tokenEndpointAuth: options.tokenEndpointAuth,
		scopes: options.scopes ?? defaultScopes,
		redirectURI: options.redirectURI,
		endSessionEndpoint: options.endSessionEndpoint,
		postLogoutRedirectURI: options.postLogoutRedirectURI,
		disableProviderLogout: options.disableProviderLogout,
		pkce: options.pkce,
		disableImplicitSignUp: options.disableImplicitSignUp,
		disableSignUp: options.disableSignUp,
		overrideUserInfo: options.overrideUserInfo
	};
}
//#endregion
export { okta };
