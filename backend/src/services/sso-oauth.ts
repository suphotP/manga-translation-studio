import { randomBytes } from "crypto";
import { CodeChallengeMethod, Google, Line, OAuth2Client, OAuth2RequestError, OAuth2Tokens, decodeIdToken, generateCodeVerifier } from "arctic";
import { serverConfig } from "../config.js";
import type { AuthIdentityProvider } from "../types/auth.js";

export type SsoProvider = "google" | "github" | "line";

export interface NormalizedExternalIdentity {
	provider: SsoProvider;
	providerUserId: string;
	email: string;
	emailVerified: boolean;
	name: string;
	picture?: string;
}

export interface SsoOAuthClient {
	createAuthorizationURL(provider: SsoProvider, state: string, codeVerifier: string): URL;
	validateAuthorizationCode(provider: SsoProvider, code: string, codeVerifier: string): Promise<OAuth2Tokens>;
	fetchUserInfo(provider: SsoProvider, tokens: OAuth2Tokens): Promise<NormalizedExternalIdentity>;
}

const GITHUB_AUTHORIZATION_ENDPOINT = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";

export const SSO_PROVIDERS = ["google", "github", "line"] as const;

export function isSsoProvider(value: string): value is SsoProvider {
	return (SSO_PROVIDERS as readonly string[]).includes(value);
}

export function createOAuthState(): string {
	return randomBytes(16).toString("hex");
}

export function createOAuthCodeVerifier(): string {
	return generateCodeVerifier();
}

export function oauthCookieName(kind: "state" | "pkce", provider: SsoProvider): string {
	return kind === "state" ? `oauth_state_${provider}` : `oauth_pkce_${provider}`;
}

export function redirectUriForProvider(provider: SsoProvider): string {
	return `${serverConfig.oauthRedirectBase.replace(/\/$/, "")}/${provider}/callback`;
}

export function providerToAuthIdentity(provider: SsoProvider): Exclude<AuthIdentityProvider, "local"> {
	return provider;
}

export class ArcticSsoOAuthClient implements SsoOAuthClient {
	createAuthorizationURL(provider: SsoProvider, state: string, codeVerifier: string): URL {
		if (provider === "google") {
			return new Google(
				serverConfig.googleOAuthClientId,
				serverConfig.googleOAuthClientSecret,
				redirectUriForProvider(provider),
			).createAuthorizationURL(state, codeVerifier, ["openid", "email", "profile"]);
		}
		if (provider === "github") {
			return new OAuth2Client(
				serverConfig.githubOAuthClientId,
				serverConfig.githubOAuthClientSecret,
				redirectUriForProvider(provider),
			).createAuthorizationURLWithPKCE(
				GITHUB_AUTHORIZATION_ENDPOINT,
				state,
				CodeChallengeMethod.S256,
				codeVerifier,
				["read:user", "user:email"],
			);
		}
		return new Line(
			serverConfig.lineLoginChannelId,
			serverConfig.lineLoginChannelSecret,
			redirectUriForProvider(provider),
		).createAuthorizationURL(state, codeVerifier, ["profile", "openid", "email"]);
	}

	async validateAuthorizationCode(provider: SsoProvider, code: string, codeVerifier: string): Promise<OAuth2Tokens> {
		if (provider === "google") {
			return new Google(
				serverConfig.googleOAuthClientId,
				serverConfig.googleOAuthClientSecret,
				redirectUriForProvider(provider),
			).validateAuthorizationCode(code, codeVerifier);
		}
		if (provider === "github") {
			return validateGitHubAuthorizationCode(code, codeVerifier);
		}
		return new Line(
			serverConfig.lineLoginChannelId,
			serverConfig.lineLoginChannelSecret,
			redirectUriForProvider(provider),
		).validateAuthorizationCode(code, codeVerifier);
	}

	async fetchUserInfo(provider: SsoProvider, tokens: OAuth2Tokens): Promise<NormalizedExternalIdentity> {
		if (provider === "google") return fetchGoogleUserInfo(tokens);
		if (provider === "github") return fetchGitHubUserInfo(tokens);
		return fetchLineUserInfo(tokens);
	}
}

/**
 * Exchange a GitHub authorization code for tokens.
 *
 * GitHub's OAuth web flow documents `client_id` and `client_secret` as required
 * token endpoint *body* parameters (https://docs.github.com/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#2-users-are-redirected-back-to-your-site-by-github).
 * Arctic's generic `OAuth2Client` instead sends credentials via HTTP Basic auth
 * when a client secret is present, which can make real GitHub token exchanges
 * fail. We post the credentials in the body here (and forward the PKCE
 * `code_verifier`, which GitHub accepts for the web flow) to match GitHub's docs.
 */
async function validateGitHubAuthorizationCode(code: string, codeVerifier: string): Promise<OAuth2Tokens> {
	const body = new URLSearchParams();
	body.set("grant_type", "authorization_code");
	body.set("code", code);
	body.set("redirect_uri", redirectUriForProvider("github"));
	body.set("client_id", serverConfig.githubOAuthClientId);
	body.set("client_secret", serverConfig.githubOAuthClientSecret);
	if (codeVerifier) body.set("code_verifier", codeVerifier);

	const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "manga-editor-web",
		},
		body: body.toString(),
	});

	let data: unknown;
	try {
		data = await response.json();
	} catch {
		throw new Error(`GitHub token exchange failed with status ${response.status}`);
	}
	if (!data || typeof data !== "object") {
		throw new Error(`GitHub token exchange returned an unexpected response (status ${response.status})`);
	}
	const payload = data as Record<string, unknown>;
	if (typeof payload.error === "string") {
		throw new OAuth2RequestError(
			payload.error,
			typeof payload.error_description === "string" ? payload.error_description : null,
			typeof payload.error_uri === "string" ? payload.error_uri : null,
			null,
		);
	}
	if (!response.ok || typeof payload.access_token !== "string") {
		throw new Error(`GitHub token exchange failed with status ${response.status}`);
	}
	return new OAuth2Tokens(payload);
}

export let ssoOAuthClient: SsoOAuthClient = new ArcticSsoOAuthClient();

export function setSsoOAuthClientForTests(client: SsoOAuthClient): () => void {
	const previous = ssoOAuthClient;
	ssoOAuthClient = client;
	return () => {
		ssoOAuthClient = previous;
	};
}

async function fetchGoogleUserInfo(tokens: OAuth2Tokens): Promise<NormalizedExternalIdentity> {
	const idTokenClaims = safeDecodeIdToken(tokens);
	const profile = await fetchJson<Record<string, unknown>>("https://openidconnect.googleapis.com/v1/userinfo", tokens.accessToken());
	const email = stringValue(profile.email) ?? stringValue(idTokenClaims.email);
	const subject = stringValue(profile.sub) ?? stringValue(idTokenClaims.sub);
	if (!email || !subject) throw new Error("Google profile did not include a usable verified email");
	return {
		provider: "google",
		providerUserId: subject,
		email,
		// Treat an omitted claim as unverified: the callback rejects unverified
		// emails before any account matching/creation, so we must not assume trust.
		emailVerified: booleanValue(profile.email_verified) ?? booleanValue(idTokenClaims.email_verified) ?? false,
		name: stringValue(profile.name) ?? stringValue(idTokenClaims.name) ?? email,
		picture: stringValue(profile.picture) ?? stringValue(idTokenClaims.picture),
	};
}

async function fetchGitHubUserInfo(tokens: OAuth2Tokens): Promise<NormalizedExternalIdentity> {
	const profile = await fetchJson<Record<string, unknown>>("https://api.github.com/user", tokens.accessToken());
	const emails = await fetchJson<Array<Record<string, unknown>>>("https://api.github.com/user/emails", tokens.accessToken());
	const verifiedEmail = emails.find((item) => item.primary === true && item.verified === true)
		?? emails.find((item) => item.verified === true);
	const email = stringValue(verifiedEmail?.email);
	const subject = numberOrStringValue(profile.id);
	if (!email || !subject) throw new Error("GitHub profile did not include a usable verified email");
	return {
		provider: "github",
		providerUserId: subject,
		email,
		emailVerified: true,
		name: stringValue(profile.name) ?? stringValue(profile.login) ?? email,
		picture: stringValue(profile.avatar_url),
	};
}

async function fetchLineUserInfo(tokens: OAuth2Tokens): Promise<NormalizedExternalIdentity> {
	const idTokenClaims = safeDecodeIdToken(tokens);
	const profile = await fetchJson<Record<string, unknown>>("https://api.line.me/v2/profile", tokens.accessToken());
	const email = stringValue(idTokenClaims.email);
	const subject = stringValue(profile.userId) ?? stringValue(idTokenClaims.sub);
	if (!email || !subject) throw new Error("LINE profile did not include the email permission claim");
	return {
		provider: "line",
		providerUserId: subject,
		email,
		// LINE's verified ID token carries an `email` claim only when the channel
		// has the Email permission and the user consented; LINE does not emit an
		// `email_verified` claim (https://developers.line.biz/en/docs/line-login/verify-id-token/).
		// The presence of the email in a signature-verified ID token is LINE's
		// trust signal, so honour an explicit `email_verified` if present but treat
		// the claim's omission as verified rather than rejecting every LINE login.
		emailVerified: booleanValue(idTokenClaims.email_verified) ?? true,
		name: stringValue(profile.displayName) ?? stringValue(idTokenClaims.name) ?? email,
		picture: stringValue(profile.pictureUrl) ?? stringValue(idTokenClaims.picture),
	};
}

async function fetchJson<T>(url: string, accessToken: string): Promise<T> {
	const response = await fetch(url, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "manga-editor-web",
		},
	});
	if (!response.ok) {
		throw new Error(`OAuth profile request failed with ${response.status}`);
	}
	return await response.json() as T;
}

function safeDecodeIdToken(tokens: OAuth2Tokens): Record<string, unknown> {
	try {
		return decodeIdToken(tokens.idToken()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberOrStringValue(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return stringValue(value);
}

function booleanValue(value: unknown): boolean | undefined {
	if (value === true) return true;
	if (value === false) return false;
	return undefined;
}
