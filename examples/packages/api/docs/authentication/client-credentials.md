# Client Credentials

The client credentials flow is for machine-to-machine access where no user is present.

Use this flow when a backend service calls the API on its own behalf. Do not use it for browser applications, mobile applications, or any client that cannot protect a secret.

## Token Scope

Grant the narrowest scope required by the service. For example, an index refresh worker may only need `indexes:write` and `query:read`.

## Rotation

Rotate client secrets on a schedule and immediately after suspected exposure. Keep old and new secrets active during a short migration window, then revoke the old secret.
