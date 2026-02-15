// MCP WebFetch Server v2.1
// Uses SearXNG for search, Playwright for page reading, MCP SDK for transport

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import axios from 'axios';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';

// ====================
// Config
// ====================

const PORT = parseInt(process.env.PORT) || 3099;
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8080';
const PAGE_TIMEOUT = parseInt(process.env.PAGE_TIMEOUT) || 30000;
const MAX_CONCURRENT_PAGES = parseInt(process.env.MAX_CONCURRENT_PAGES) || 3;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ====================
// Search Cache
// ====================

const searchCache = new Map();

function getCached(key) {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  // Evict oldest if at capacity
  if (searchCache.size >= CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(key, { data, time: Date.now() });
}

// ====================
// SearXNG Search Client
// ====================

async function searchViaSearXNG(query, { limit = 5, categories = 'general' } = {}) {
  const cacheKey = `search:${query}:${limit}:${categories}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const response = await axios.get(`${SEARXNG_URL}/search`, {
    params: {
      q: query,
      format: 'json',
      categories,
      pageno: 1,
    },
    timeout: 10000,
  });

  const results = (response.data.results || []).slice(0, limit).map(r => ({
    title: r.title || '',
    url: r.url || '',
    text: r.content || '',
    engine: (r.engines || []).join(', '),
  }));

  const result = { success: true, query, results, resultCount: results.length };
  setCache(cacheKey, result);
  return result;
}

// ====================
// Browser Management (Playwright - for page reading only)
// ====================

let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    });
  }
  return browser;
}

// ====================
// Content Extraction
// ====================

const NOISE_SELECTORS = [
  'script', 'style', 'nav', 'footer', 'header', 'iframe', 'noscript',
  'svg', 'canvas', 'figure', '.sidebar', '.ads', '.ad', '.advertisement',
  '.cookie-banner', '.cookie-consent', '[role="navigation"]', '[role="banner"]',
  '[role="complementary"]', '.social-share', '.comments', '#comments',
].join(', ');

const MAIN_CONTENT_SELECTORS = ['article', '[role="main"]', 'main', '.content', '#content', '.post', '.entry'];

async function extractContent(page) {
  return page.evaluate(({ noiseSelectors, mainSelectors }) => {
    // Remove noise elements
    document.querySelectorAll(noiseSelectors).forEach(el => el.remove());

    const title = document.title || document.querySelector('h1')?.textContent?.trim() || '';

    // Extract headings - also capture links from/around headings
    const seenUrls = new Set();
    const headingLinks = [];
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(h => {
      const level = parseInt(h.tagName.charAt(1));
      const text = h.textContent.trim();
      // Check if heading contains a link, or is wrapped in a link
      const a = h.querySelector('a[href]') || h.closest('a[href]');
      if (a) {
        let href = a.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          if (href.startsWith('/')) href = window.location.origin + href;
          if (href.startsWith('http') && text.length >= 5 && !seenUrls.has(href)) {
            seenUrls.add(href);
            headingLinks.push({ text, url: href });
          }
        }
      }
      return { level, text };
    });

    // Find main content container (fall back to body if match is too small)
    let mainEl = null;
    for (const sel of mainSelectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim().length > 200) {
        mainEl = el;
        break;
      }
    }
    if (!mainEl) mainEl = document.body;

    const paragraphs = Array.from(mainEl.querySelectorAll('p'))
      .map(p => p.textContent.trim())
      .filter(t => t.length >= 20);

    // Extract links: heading links first (most important), then content links
    const contentLinks = Array.from(mainEl.querySelectorAll('a[href]'))
      .map(a => {
        const text = a.textContent.trim();
        let href = a.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return null;
        if (href.startsWith('/')) href = window.location.origin + href;
        if (!href.startsWith('http')) return null;
        if (text.length < 5) return null;
        if (seenUrls.has(href)) return null;
        seenUrls.add(href);
        return { text, url: href };
      })
      .filter(Boolean);
    const links = [...headingLinks, ...contentLinks].slice(0, 20);

    const fullContent = mainEl.textContent.trim();

    return {
      title,
      headings,
      paragraphs: paragraphs.slice(0, 15),
      links,
      fullContent,
      wordCount: fullContent.split(/\s+/).length,
      url: window.location.href,
    };
  }, { noiseSelectors: NOISE_SELECTORS, mainSelectors: MAIN_CONTENT_SELECTORS });
}

// ====================
// Page Reading
// ====================

async function readPage(url, { maxContentLength = 5000 } = {}) {
  const b = await getBrowser();
  const context = await b.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1920, height: 1080 },
  });

  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    // Wait for JS/async content to load before trying consent dismiss
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 });
    } catch {}

    // Try to dismiss cookie consent dialogs (GDPR)
    try {
      const consentSelectors = [
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        'button:has-text("Tillad alle")', 'button:has-text("Accepter")',
        'button:has-text("Acceptér")', 'button:has-text("Accept all")',
        'button:has-text("Accept")', 'button:has-text("Agree")',
        'button:has-text("Allow all")', 'button:has-text("Godkend")',
        '[id*="accept" i][id*="cookie" i]', '[id*="accept" i][id*="consent" i]',
        '.cmp-accept', '.cookie-accept', '[data-action="accept"]',
      ];
      const selectorStr = consentSelectors.join(', ');
      let clicked = false;

      // Try main frame first
      try {
        const btn = page.locator(selectorStr);
        await btn.first().click({ timeout: 2000 });
        clicked = true;
      } catch {}

      // Then try iframes (some CMPs render in iframes)
      if (!clicked) {
        for (const frame of page.frames()) {
          try {
            const btn = frame.locator(selectorStr);
            await btn.first().click({ timeout: 1000 });
            clicked = true;
            break;
          } catch {}
        }
      }

      if (clicked) await page.waitForTimeout(1000);
    } catch {}

    // Wait until page has meaningful content (paragraphs or article text)
    try {
      await page.waitForFunction(() => {
        const ps = document.querySelectorAll('p');
        const hasContent = Array.from(ps).some(p => p.textContent.trim().length > 40);
        const hasArticle = document.querySelector('article, [role="main"], main, .article');
        return hasContent || hasArticle;
      }, { timeout: 5000 });
    } catch {}

    const extracted = await extractContent(page);
    if (maxContentLength && extracted.fullContent) {
      extracted.fullContent = extracted.fullContent.substring(0, maxContentLength);
    }
    return { success: true, ...extracted };
  } catch (error) {
    return { success: false, url, error: error.message };
  } finally {
    await context.close();
  }
}

async function readPagesConcurrently(urls, { maxContentLength = 5000 } = {}) {
  const results = [];
  for (let i = 0; i < urls.length; i += MAX_CONCURRENT_PAGES) {
    const batch = urls.slice(i, i + MAX_CONCURRENT_PAGES);
    const batchResults = await Promise.all(
      batch.map(url => readPage(url, { maxContentLength }))
    );
    results.push(...batchResults);
  }
  return results;
}

// ====================
// MCP Server Factory
// ====================

function createServer() {
  const server = new McpServer(
    { name: 'mcp-webfetch', version: '2.1.0' },
    {
      capabilities: { logging: {} },
      instructions: `You have access to web search and page reading tools. Use them proactively:
- When the user asks a question that requires up-to-date information, current events, or facts you're not confident about — use search_web
- When the user shares a URL or asks about a specific webpage — use read_page
- When the user needs to compare or gather info from multiple URLs — use read_pages_concurrently
Do not wait for the user to explicitly ask you to search or read. If answering would benefit from web information, use these tools automatically.`
    }
  );

  server.registerTool('search_web', {
    description: 'Search the internet for current information. Use this when you need up-to-date facts, news, documentation, or answers to questions where your training data may be outdated or insufficient. Returns titles, URLs, and snippets from multiple search engines.',
    inputSchema: {
      query: z.string().describe('The search query'),
      limit: z.number().optional().default(5).describe('Max results (1-20)'),
      categories: z.string().optional().default('general').describe('Search categories: general, news, images, science, it'),
    },
  }, async ({ query, limit, categories }) => {
    const result = await searchViaSearXNG(query, { limit, categories });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('read_page', {
    description: 'Read and extract the full content of a webpage. Use this when you have a URL and need to understand its content — for summarizing articles, extracting data, answering questions about a specific page, or following up on search results. Returns title, headings, paragraphs, links, and full text.',
    inputSchema: {
      url: z.string().describe('URL of the webpage to read'),
      maxContentLength: z.number().optional().default(5000).describe('Max content length in characters'),
    },
  }, async ({ url, maxContentLength }) => {
    const result = await readPage(url, { maxContentLength });
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool('read_pages_concurrently', {
    description: 'Read multiple webpages in parallel. Use this when you need to compare information across several pages or gather content from multiple URLs at once. More efficient than reading pages one by one.',
    inputSchema: {
      urls: z.array(z.string()).describe('Array of URLs to read'),
      maxContentLength: z.number().optional().default(5000).describe('Max content length per page in characters'),
    },
  }, async ({ urls, maxContentLength }) => {
    const results = await readPagesConcurrently(urls, { maxContentLength });
    return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
  });

  return server;
}

// ====================
// Express + Transport Wiring
// ====================

const app = express();
app.use(express.json());

// Store active transports by session ID
const transports = {};

// --- Health endpoint ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mcp-webfetch', version: '2.1.0' });
});

// --- REST API endpoints (for direct HTTP usage) ---
app.post('/search', async (req, res) => {
  try {
    const { query, limit = 5, categories = 'general' } = req.body;
    if (!query) return res.status(400).json({ error: 'Missing query parameter' });
    const result = await searchViaSearXNG(query, { limit, categories });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/read', async (req, res) => {
  try {
    const { url, maxContentLength = 5000 } = req.body;
    if (!url) return res.status(400).json({ error: 'Missing url parameter' });
    const result = await readPage(url, { maxContentLength });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/read-multiple', async (req, res) => {
  try {
    const { urls, maxContentLength = 5000 } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'Missing urls parameter (array)' });
    const results = await readPagesConcurrently(urls, { maxContentLength });
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- Streamable HTTP Transport (protocol 2025-11-25) ---
app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];
    let transport;

    if (sessionId && transports[sessionId]) {
      const existing = transports[sessionId];
      if (existing instanceof StreamableHTTPServerTransport) {
        transport = existing;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Session uses a different transport protocol' },
          id: null,
        });
        return;
      }
    } else if (!sessionId && req.method === 'POST' && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sid => {
          transports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete transports[sid];
      };
      const server = createServer();
      await server.connect(transport);
    } else {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('Error handling /mcp request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// --- SSE Transport (protocol 2024-11-05, for Cline + LM Studio compatibility) ---
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  transports[transport.sessionId] = transport;

  res.on('close', () => {
    delete transports[transport.sessionId];
  });

  const server = createServer();
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;
  const existing = transports[sessionId];

  if (existing instanceof SSEServerTransport) {
    await existing.handlePostMessage(req, res, req.body);
  } else {
    res.status(400).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'No valid SSE session found' },
      id: null,
    });
  }
});

// ====================
// Start Server
// ====================

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP WebFetch Server v2.1 running on http://0.0.0.0:${PORT}`);
  console.log(`SearXNG backend: ${SEARXNG_URL}`);
  console.log(`Transports: SSE (/sse + /messages), Streamable HTTP (/mcp)`);
  console.log(`REST API: /health, /search, /read, /read-multiple`);
});

// ====================
// Graceful Shutdown
// ====================

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);

  // Close all MCP transports
  for (const sessionId of Object.keys(transports)) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch (err) {
      console.error(`Error closing transport ${sessionId}:`, err.message);
    }
  }

  // Close browser
  if (browser) {
    try {
      await browser.close();
    } catch (err) {
      console.error('Error closing browser:', err.message);
    }
  }

  // Close HTTP server
  httpServer.close(() => {
    console.log('Server shutdown complete');
    process.exit(0);
  });

  // Force exit after 5s
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
