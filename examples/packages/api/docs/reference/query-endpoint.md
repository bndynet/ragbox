# Query Endpoint

The query endpoint answers a question from a prepared ragbox index.

```http
POST /query
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{
  "question": "How do I configure authentication?",
  "source": "api"
}
```

## Response Fields

- `answer`: the model answer grounded in selected context.
- `sources`: file and node references used as context.
- `warnings`: non-fatal issues such as unavailable documents or missing node text.
- `timingsMs`: elapsed time for resolution, selection, and answer generation.

## Source Selection

If `source` is omitted in a multi-source setup, the service may search every configured source. Use an explicit source name for narrow, predictable latency.
