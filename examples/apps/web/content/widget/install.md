# Docs Widget Installation

The docs widget embeds ragbox-backed answers into a website or documentation portal.

Add the widget script to the page and configure the query endpoint:

```html
<script src="/ragbox-widget.js" data-query-url="/query"></script>
```

## Required Settings

- `data-query-url`: HTTP endpoint that accepts query requests.
- `data-source`: optional source name such as `docs`, `api`, or `web`.
- `data-theme`: optional visual theme.

## Deployment

Deploy the widget after the index service is healthy. A widget can render a disabled state when `/health` reports that no index is loaded.
