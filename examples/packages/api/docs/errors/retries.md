# Errors and Retries

API clients should retry transient failures and avoid retrying validation failures.

Retry these classes of errors:

- `429 Too Many Requests`
- `500 Internal Server Error`
- `502 Bad Gateway`
- `503 Service Unavailable`
- `504 Gateway Timeout`

Do not retry malformed requests, missing authentication, or invalid source names until the request is fixed.

## Backoff

Use exponential backoff with jitter. Start with a short delay such as 250 milliseconds, then increase the delay for each retry attempt.

## Idempotency

Read-only query requests can normally be retried. Index mutation requests should include an idempotency key when the API supports one.
