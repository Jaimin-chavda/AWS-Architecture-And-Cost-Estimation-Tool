//#region src/plugins/generic-oauth/providers/auth0.ts
/**
* Auth0 OAuth provider helper
*
* @example
* ```ts
* import { genericOAuth, auth0 } from "better-auth/plugins/generic-oauth";
*
* export const auth = betterAuth({
*   plugins: [
*     genericOAuth({
*       config: [
*         auth0({
*           clientId: process.env.AUTH0_CLIENT_ID,
*           clientSecret: process.env.AUTH0_CLIENT_SECRET,
*           domain: process.env.AUTH0_DOMAIN,
*         }),
*       ],
*     }),
*   ],
* });
* ```
*/
function auth0(options) {
	const defaultScopes = [
		"openid",
		"profile",
		"email"
	];
	const domain = options.domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	const discoveryUrl = `https://${domain}/.well-known/openid-configuration`;
	return {
		providerId: "auth0",
		accountIssuer: `https://${domain}/`,
		discoveryUrl,
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
export { auth0 };
