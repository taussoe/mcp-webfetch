# MCP WebFetch Server

Web search and content extraction via [SearXNG](https://docs.searxng.org/) + [Playwright](https://playwright.dev/). Exposes both a REST API and MCP protocol (SSE + Streamable HTTP) for integration with AI tools.

## Features

- **Web Search** — SearXNG meta-search across DuckDuckGo, Bing, Brave, Wikipedia and more
- **Page Reading** — Playwright-based extraction with SPA/JS rendering support
- **Cookie Consent Dismiss** — Automatically clicks through GDPR/cookie dialogs
- **Link Extraction** — Returns up to 20 relevant links per page (heading links prioritized)
- **Concurrent Reading** — Batch-read multiple pages in parallel with configurable concurrency
- **Search Cache** — In-memory LRU cache (200 entries, 5 min TTL)

## Quick Start (Docker)

```bash
docker compose up -d
curl http://localhost:3099/health
```

The `docker-compose.yml` starts both SearXNG and mcp-webfetch.

## REST API

### `GET /health`

```json
{ "status": "ok", "service": "mcp-webfetch", "version": "2.1.0" }
```

### `POST /search`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | *required* | Search query |
| `limit` | number | `5` | Max results (1-20) |
| `categories` | string | `"general"` | SearXNG categories: `general`, `news`, `images`, `science`, `it` |

```bash
curl -X POST http://localhost:3099/search \
  -H "Content-Type: application/json" \
  -d '{"query": "playwright automation", "limit": 3}'
```

### `POST /read`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | *required* | URL to read |
| `maxContentLength` | number | `5000` | Max content length in characters |

```bash
curl -X POST http://localhost:3099/read \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com", "maxContentLength": 3000}'
```

Returns: `title`, `headings`, `paragraphs`, `links`, `fullContent`, `wordCount`, `url`.

### `POST /read-multiple`

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `urls` | string[] | *required* | Array of URLs to read |
| `maxContentLength` | number | `5000` | Max content length per page |

## MCP Tools

Three tools are registered on both transports:

### `search_web`

Search the web using multiple search engines via SearXNG.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | string | *required* | The search query |
| `limit` | number | `5` | Max results (1-20) |
| `categories` | string | `"general"` | Search categories: `general`, `news`, `images`, `science`, `it` |

### `read_page`

Read and extract content from a webpage. Handles SPAs, dismisses cookie consent, extracts links.

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | *required* | URL of the webpage |
| `maxContentLength` | number | `5000` | Max content length in characters |

### `read_pages_concurrently`

Read multiple webpages in parallel (batched by `MAX_CONCURRENT_PAGES`).

| Input | Type | Default | Description |
|-------|------|---------|-------------|
| `urls` | string[] | *required* | Array of URLs to read |
| `maxContentLength` | number | `5000` | Max content length per page |

## MCP Transports

| Endpoint | Protocol | Use case |
|----------|----------|----------|
| `/mcp` | Streamable HTTP (2025-03-26) | Claude Code, Claude Desktop, modern clients |
| `/sse` + `/messages` | SSE (2024-11-05) | Cline, LM Studio, older clients |

## Configuration

### Claude Code

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "mcp-webfetch": {
      "url": "http://localhost:3099/mcp"
    }
  }
}
```

### Cline (VS Code Extension)

Add via Cline UI (MCP Servers → Configure), or edit the file directly at `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`:

```json
{
  "mcpServers": {
    "mcp-webfetch": {
      "url": "http://localhost:3099/sse"
    }
  }
}
```

### Cline CLI

Edit `~/.cline/data/settings/cline_mcp_settings.json` (create the file if it doesn't exist):

```json
{
  "mcpServers": {
    "mcp-webfetch": {
      "url": "http://localhost:3099/sse"
    }
  }
}
```

> **Note:** Cline CLI and the VS Code extension use separate config files — configuring one does not affect the other.

### LM Studio

Add to LM Studio's MCP settings:

```json
{
  "mcpServers": {
    "mcp-webfetch": {
      "url": "http://localhost:3099/sse"
    }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3099` | Server port |
| `SEARXNG_URL` | `http://localhost:8080` | SearXNG instance URL |
| `PAGE_TIMEOUT` | `30000` | Playwright page load timeout (ms) |
| `MAX_CONCURRENT_PAGES` | `3` | Max pages read in parallel per batch |

## License

MIT
