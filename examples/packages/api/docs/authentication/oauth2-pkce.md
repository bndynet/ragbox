# OAuth 2.0 Authorization Code with PKCE

PKCE solves authorization code interception risk in public clients. It binds the authorization request to a one-time secret called the code verifier.

The client creates a high-entropy code verifier before redirecting the user to the authorization server. It sends a derived code challenge in the authorization request. Later, when exchanging the authorization code for tokens, the client sends the original code verifier.

The authorization server recomputes the challenge from the verifier. If the recomputed value does not match the challenge from the authorization request, the token request fails.

## Why This Helps

An attacker who steals only the authorization code cannot redeem it without the original verifier. This reduces the impact of redirects, browser history leakage, custom URI interception, and other authorization code exposure paths.

## Recommended Defaults

Use the `S256` challenge method. Generate a fresh verifier for each authorization attempt. Treat the verifier as short-lived secret material and never log it.

## Common Failure

If the token endpoint returns `invalid_grant`, confirm that the same verifier was used for the original authorization request and token exchange.
