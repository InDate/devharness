/**
 * Content Extraction Tools
 */

import { z } from 'zod';
import { executeWithPauseDetection, actionFailureResponse } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { createErrorResponse } from '../messages.js';
import { promises as fs } from 'fs';
import path from 'path';
import type { ClickableCache, ClickableElement } from '../clickable-cache.js';
import { getOutputPath } from '../helpers/paths.js';
import { listParsers, loadParser } from '../helpers/parser-plugins.js';
import { collectInteractiveElements } from '../element-collector.js';
import { UIVerifier, type UICheckType, type UIIssue } from '../ui-verifier.js';
import { isAbortError, raceAbort, throwIfAborted } from '../utils/abort.js';

// All element types for findInteractive
const elementTypes = ['link', 'button', 'text', 'email', 'password', 'number', 'tel', 'url', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', 'date', 'other'] as const;

// UI verification check types
const verifyCheckTypes = ['handlers', 'viewport', 'touch', 'overflow', 'clickability', 'links', 'scroll'] as const;

const contentSchema = z.object({
  action: z.enum(['extractText', 'findInteractive', 'verify', 'parse']),
  connection: z.string().describe('The connection, by the name connection launch or attach gave it'),

  // extractText parameters
  mode: z.enum(['outline', 'full', 'section']).optional().describe('extractText: outline (headings and metadata), full (entire page), section (one section by heading)'),
  section: z.string().optional().describe('extractText section: the heading'),
  save: z.boolean().optional().describe('extractText: save to .devharness/extracts/'),

  // findInteractive parameters
  types: z.array(z.enum(elementTypes)).optional().describe('findInteractive: element types'),
  showHidden: z.boolean().optional().describe('findInteractive: include hidden elements (default false)'),

  // Shared parameters
  search: z.string().optional().describe('extractText/findInteractive: search term filter'),
  limit: z.number().optional().describe('findInteractive: max results (default 50)'),

  // verify parameters
  checks: z.array(z.enum(verifyCheckTypes)).optional().describe('verify: handlers (dead buttons), viewport (position), touch (target size), overflow (clipping), clickability (z-index blocking, slow), links (dead hrefs), scroll (horizontal). Default: all but clickability'),

  // parse parameters
  name: z.string().optional().describe('parse: plugin name; omitted, lists the plugins'),
  waitMs: z.number().optional().describe("parse: max ms to wait for the plugin's waitFor predicate (default 8000; 0 skips)"),
}).strict();

export function createContentTools(resolveConnectionByName: (connection: string) => Promise<any>, clickableCache: ClickableCache) {
  /**
   * Save extracted content to disk
   */
  const saveExtractedContent = async (content: string, url: string): Promise<string> => {
    const timestamp = Date.now();
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const extractDir = getOutputPath('extracts', date);

    // Ensure directory exists
    await fs.mkdir(extractDir, { recursive: true });

    // Create filename from URL (sanitize)
    const urlPart = url.replace(/[^a-z0-9]/gi, '-').substring(0, 50);
    const filename = `extract-${urlPart}-${timestamp}.md`;
    const filepath = path.join(extractDir, filename);

    await fs.writeFile(filepath, content);
    return filepath;
  };

  return {
    content: createTool(
      'Primary tool for page content; prefer over screenshots. Actions: extractText (page text as outline, full or one section), findInteractive (links, buttons, inputs), verify (UI checks: dead buttons, viewport, touch targets, clipping), parse (a page-parser plugin from .devharness/parsers/)',
      contentSchema,
      // abortSignal (#110): INTERRUPTIBLE AT A CHECKPOINT. The only real wait
      // here is `parse`'s plugin `waitFor` predicate (up to waitMs, default
      // 8s) - a cancel stops waiting for it. Extraction itself is a single
      // page.evaluate with nothing to cancel, so the other actions only get
      // the entry checkpoint.
      async (args, abortSignal?: AbortSignal) => {
        const { action } = args;

        throwIfAborted(abortSignal);

        // Resolve connection from reason
        const resolved = await resolveConnectionByName(args.connection);
        if (!resolved) {
          return createErrorResponse('CONNECTION_NOT_FOUND', {
            message: 'No Chrome browser available. Start one with `connection` action `launch`.'
          });
        }

        const targetPuppeteerManager = resolved.puppeteerManager;
        const targetCdpManager = resolved.cdpManager;

        const error = checkBrowserAutomation(targetCdpManager, targetPuppeteerManager, action, resolved.connection.port, true);
        if (error) {
          return error;
        }

        const page = targetPuppeteerManager.getPage();
        const on = `connection: '${args.connection}'`;

        // findInteractive and verify read the page title first, and a paused
        // page answers no page JS until it resumes.
        if ((action === 'findInteractive' || action === 'verify') && targetCdpManager.isPaused()) {
          return createErrorResponse('ACTION_FAILED', {
            action, selector: 'page', error: 'execution is paused at a breakpoint',
          });
        }

        switch (action) {
          case 'extractText': {
            const mode = args.mode || 'outline';

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                // Extract content structure and metadata
                const data = await page.evaluate(() => {
                  // @ts-ignore - This code runs in browser context

                  // Find main content area
                  const mainSelectors = ['main', 'article', '[role="main"]', '#main', '#content', '.main-content', '.article-content', '.post-content'];
                  // @ts-ignore
                  let mainElement: any = null;
                  for (const selector of mainSelectors) {
                    // @ts-ignore
                    mainElement = document.querySelector(selector);
                    if (mainElement) break;
                  }
                  if (!mainElement) {
                    // @ts-ignore
                    mainElement = document.body;
                  }

                  // Extract all headings with their text content for outline
                  const headings: { level: number; text: string; }[] = [];
                  // @ts-ignore
                  const headingElements = mainElement.querySelectorAll('h1, h2, h3, h4, h5, h6');
                  headingElements.forEach((h: any) => {
                    const level = parseInt(h.tagName[1]);
                    const text = h.textContent?.trim() || '';
                    if (text) {
                      headings.push({ level, text });
                    }
                  });

                  // Helper to convert HTML to markdown
                  const htmlToMarkdown = (element: any): string => {
                    const tag = element.tagName.toLowerCase();
                    const text = element.textContent?.trim() || '';

                    // Skip script, style, and hidden elements
                    if (tag === 'script' || tag === 'style' || tag === 'noscript') return '';
                    // @ts-ignore
                    const style = window.getComputedStyle(element);
                    if (style.display === 'none' || style.visibility === 'hidden') return '';

                    // Convert based on tag
                    switch (tag) {
                      case 'h1': return text ? `# ${text}\n\n` : '';
                      case 'h2': return text ? `## ${text}\n\n` : '';
                      case 'h3': return text ? `### ${text}\n\n` : '';
                      case 'h4': return text ? `#### ${text}\n\n` : '';
                      case 'h5': return text ? `##### ${text}\n\n` : '';
                      case 'h6': return text ? `###### ${text}\n\n` : '';
                      case 'p': return text ? `${text}\n\n` : '';
                      case 'a':
                        const href = element.getAttribute('href');
                        return href && text ? `[${text}](${href})` : text;
                      case 'strong':
                      case 'b': return text ? `**${text}**` : '';
                      case 'em':
                      case 'i': return text ? `*${text}*` : '';
                      case 'code': return text ? `\`${text}\`` : '';
                      case 'pre': return text ? `\`\`\`\n${text}\n\`\`\`\n\n` : '';
                      case 'blockquote': return text ? text.split('\n').map((l: string) => `> ${l}`).join('\n') + '\n\n' : '';
                      case 'li': return text ? `- ${text}\n` : '';
                      case 'ul':
                      case 'ol':
                        let listContent = '';
                        for (const child of Array.from(element.children)) {
                          listContent += htmlToMarkdown(child);
                        }
                        return listContent ? listContent + '\n' : '';
                      case 'br': return '\n';
                      case 'hr': return '---\n\n';
                      default:
                        if (element.children.length > 0) {
                          let childContent = '';
                          for (const child of Array.from(element.children)) {
                            childContent += htmlToMarkdown(child);
                          }
                          return childContent;
                        }
                        return text ? text + ' ' : '';
                    }
                  };

                  // Extract full markdown content
                  const markdown = htmlToMarkdown(mainElement).replace(/\n{3,}/g, '\n\n').replace(/ {2,}/g, ' ').trim();

                  return {
                    headings,
                    markdown,
                  };
                });

                const url = page.url();
                const title = await page.title();
                const wordCount = data.markdown.split(/\s+/).length;

                return {
                  url,
                  title,
                  headings: data.headings,
                  markdown: data.markdown,
                  wordCount,
                };
              },
              'extractText'
            );

            {
              const failed = actionFailureResponse(result, 'extractText', 'page');
              if (failed) return failed;
            }

            const { url, title, headings, markdown, wordCount } = result.result!;

            // Mode: outline (default) - return metadata and structure
            if (mode === 'outline') {
              // Apply search filter if provided
              let filteredHeadings = headings;
              if (args.search) {
                const searchLower = args.search.toLowerCase();
                filteredHeadings = headings.filter((h: any) => h.text.toLowerCase().includes(searchLower));
              }

              const outlineText = filteredHeadings.map((h: any) => '  '.repeat(h.level - 1) + `${h.level}. ${h.text}`).join('\n');

              // Estimate tokens (rough: ~4 chars per token)
              const estimatedTokens = Math.ceil(markdown.length / 4);

              let response = `Content Outline: ${title}\n`;
              response += `URL: ${url}, Sections: ${headings.length}, Words: ${wordCount}, Tokens: ~${estimatedTokens.toLocaleString()}\n\n`;

              if (args.search) {
                response += `Filtered by: "${args.search}" (${filteredHeadings.length} matches)\n\n`;
              }

              // Add table of contents
              response += `Table of Contents:\n`;
              filteredHeadings.forEach((h: any, i: number) => {
                const indent = '  '.repeat(h.level - 1);
                response += `${indent}${i + 1}. [${h.text}](#)\n`;
              });
              response += `\n`;

              response += `\nStructure:\n${outlineText}\n\n`;
              response += `---\n\n`;
              response += `Next Steps:\n`;
              response += `- Extract full: content({ action: 'extractText', ${on}, mode: 'full' })\n`;
              response += `- Extract section: content({ action: 'extractText', ${on}, mode: 'section', section: 'Name' })\n`;
              response += `- Search: content({ action: 'extractText', ${on}, search: 'keyword' })`;

              return {
                content: [{ type: 'text', text: response }],
              };
            }

            // Mode: section - extract specific section
            if (mode === 'section') {
              if (!args.section) {
                return createErrorResponse('INVALID_PARAMS', { message: 'Section parameter required for mode=section' });
              }

              // Find the section in markdown
              const sectionRegex = new RegExp(`^#+ ${args.section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'mi');
              const match = markdown.match(sectionRegex);

              if (!match) {
                return createErrorResponse('SECTION_NOT_FOUND', { section: args.section });
              }

              // Extract content from this section until next heading of same or higher level
              const sectionStart = match.index!;
              const sectionLevel = match[0].match(/^#+/)?.[0].length || 1;
              const nextHeadingRegex = new RegExp(`\n#{1,${sectionLevel}} `, 'g');
              nextHeadingRegex.lastIndex = sectionStart + match[0].length;
              const nextMatch = nextHeadingRegex.exec(markdown);

              const sectionContent = markdown.substring(sectionStart, nextMatch ? nextMatch.index : undefined);
              const sectionWordCount = sectionContent.split(/\s+/).length;

              let response = `${title} - Section: ${args.section}\n`;
              response += `URL: ${url}, Words: ${sectionWordCount}\n\n`;
              response += sectionContent;

              if (args.save) {
                const filepath = await saveExtractedContent(response, url);
                response += `\n\n---\n\n**Saved to:** ${filepath}`;
              }

              return {
                content: [{ type: 'text', text: response }],
              };
            }

            // Mode: full - return entire page content
            let response = `${title}\n`;
            response += `URL: ${url}, Words: ${wordCount}\n\n`;
            response += markdown;

            if (args.save) {
              const filepath = await saveExtractedContent(response, url);
              response += `\n\n---\n\n**Saved to:** ${filepath}`;
            }

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          case 'parse': {
            const url = page.url();

            // List mode: no name -> enumerate available plugins.
            if (!args.name) {
              const parsers = await listParsers(url);
              if (parsers.length === 0) {
                return {
                  content: [{
                    type: 'text',
                    text: 'No parser plugins found.\n\n' +
                      'Add one at .devharness/parsers/<name>.mjs that default-exports ' +
                      '{ name, description, match?, waitFor?, extract }.\n' +
                      "extract() runs in the page and returns JSON.",
                  }],
                };
              }
              let out = `Available parser plugins (${parsers.length}):\n\n`;
              for (const p of parsers) {
                const flag = p.matches === true ? '  ✓ matches current URL' : '';
                out += `- ${p.name}: ${p.description ?? '(no description)'}${flag}\n`;
              }
              out += `\nRun: content({ action: 'parse', ${on}, name: '<name>' })`;
              return { content: [{ type: 'text', text: out }] };
            }

            // Run mode: load and execute the named plugin in the page.
            let plugin;
            try {
              plugin = await loadParser(args.name);
            } catch (e: any) {
              return createErrorResponse('INVALID_PARAMS', { message: e?.message || String(e) });
            }

            const run = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const waitMs = args.waitMs ?? 8000;
                if (plugin.waitFor && waitMs > 0) {
                  try {
                    // raceAbort: a cancel stops waiting for the predicate. The
                    // in-page polling Puppeteer installed keeps running until
                    // its own timeout - we just stop caring.
                    await raceAbort(
                      page.waitForFunction(plugin.waitFor as any, { timeout: waitMs }),
                      abortSignal
                    );
                  } catch (err) {
                    // The universal trap: this catch exists to proceed when the
                    // predicate never became true, but it must not swallow a
                    // cancel and then go on to extract anyway.
                    if (isAbortError(err)) throw err;
                    // Proceed even if the predicate never became true (extract may
                    // still return a useful "not found" result).
                  }
                }
                // plugin.extract runs in the page; Puppeteer serializes it.
                throwIfAborted(abortSignal);
                return await page.evaluate(plugin.extract as any);
              },
              'parse'
            );

            // An extract may return null for "nothing found"; a pause or a throw is not that.
            if (!run.success || run.pausedAtBreakpoint) {
              return createErrorResponse('ACTION_FAILED', {
                action: 'parse', selector: args.name,
                error: run.error ?? 'execution is paused at a breakpoint',
              });
            }
            const payload = JSON.stringify(run.result ?? null, null, 2);
            let response = `Parser: ${args.name}\nURL: ${url}\n\n${payload}`;

            if (args.save) {
              const filepath = await saveExtractedContent(response, url);
              response += `\n\n---\n\n**Saved to:** ${filepath}`;
            }

            return { content: [{ type: 'text', text: response }] };
          }

          case 'findInteractive': {
            const limit = args.limit || 50;
            const url = page.url();
            const title = await page.title();

            // Try to get cached elements first
            const cached = clickableCache.get(url);
            let elements: ClickableElement[];
            let wasFromCache = false;

            if (cached) {
              elements = cached.elements;
              wasFromCache = true;
            } else {
              // Fall back to live extraction if not cached
              const result = await executeWithPauseDetection(
                targetCdpManager,
                async () => collectInteractiveElements(page),
                'findInteractive'
              );

              if (!result.result) {
                return createErrorResponse('EXTRACTION_FAILED');
              }

              elements = result.result.elements as ClickableElement[];
            }

            // Count and filter hidden elements (width/height <= 0 or visible === false)
            const showHidden = args.showHidden || false;
            const hiddenCount = elements.filter((el) => (el.width ?? 0) <= 0 || (el.height ?? 0) <= 0 || el.visible === false).length;
            if (!showHidden) {
              elements = elements.filter((el) => (el.width ?? 0) > 0 && (el.height ?? 0) > 0 && el.visible !== false);
            }

            const totalCount = elements.length;
            const hasSearch = !!args.search;
            const hasTypes = args.types && args.types.length > 0;

            // Summary mode: no search or types filter
            if (!hasSearch && !hasTypes) {
              // Group elements by semantic context, then by type
              const contextOrder = ['header', 'nav', 'main', 'form', 'aside', 'footer'];
              const elementsByContext: Record<string, typeof elements> = {};
              elements.forEach((el) => {
                const ctx = el.context || 'main';
                if (!elementsByContext[ctx]) {
                  elementsByContext[ctx] = [];
                }
                elementsByContext[ctx].push(el);
              });

              let response = `Interactive Elements: ${title}\n`;
              response += `URL: ${url}, Total: ${totalCount} elements`;
              if (hiddenCount > 0 && !showHidden) {
                response += ` (${hiddenCount} hidden)`;
              }
              if (wasFromCache) {
                response += ` (cached)`;
              }
              response += `\n`;

              // Sort contexts by predefined order
              const sortedContexts = Object.keys(elementsByContext).sort((a, b) => {
                const aIdx = contextOrder.indexOf(a);
                const bIdx = contextOrder.indexOf(b);
                return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
              });

              for (const context of sortedContexts) {
                const contextElements = elementsByContext[context];
                response += `\n[${context}] (${contextElements.length})\n`;

                // Group by type within context
                const byType: Record<string, typeof elements> = {};
                contextElements.forEach((el) => {
                  if (!byType[el.type]) byType[el.type] = [];
                  byType[el.type].push(el);
                });

                for (const [type, typeElements] of Object.entries(byType)) {
                  // Helper to check if element is hidden
                  const isHidden = (el: ClickableElement) =>
                    (el.width ?? 0) <= 0 || (el.height ?? 0) <= 0 || el.visible === false;

                  if (typeElements.length > 1) {
                    response += `${type} (${typeElements.length}): `;
                    response += typeElements.map((el) => {
                      const hidden = isHidden(el) ? ' [hidden]' : '';
                      return `${el.text || '(no text)'}${hidden}`;
                    }).join(', ');
                    response += `\n`;
                  } else {
                    const el = typeElements[0];
                    const hidden = isHidden(el) ? ' (hidden)' : '';
                    response += `${el.text || '(no text)'} [${el.selector}]${hidden}\n`;
                  }
                }
              }

              // Find a good example - prefer element with text for :has-text() example
              const exampleElement = elements.find((el) => el.text && el.text.length > 0 && el.text.length <= 20);
              const exampleText = exampleElement?.text || 'Button';
              const exampleTag = exampleElement?.type === 'link' ? 'a' : 'button';
              response += `\n:has-text() matches text content, aria-label, and title.`;
              response += `\nExample: \`input({ action: 'click', ${on}, selector: '${exampleTag}:has-text("${exampleText}")' })\``;

              return {
                content: [{ type: 'text', text: response }],
                _meta: {
                  tool: 'content',
                  action,
                  timestamp: Date.now(),
                  content: { totalCount, ...(hiddenCount > 0 && { hiddenCount }) },
                },
              };
            }

            // Filtered mode: apply search and/or types filter
            let filteredElements = elements;

            // Apply type filter
            if (hasTypes) {
              filteredElements = filteredElements.filter((el) => args.types!.includes(el.type as any));
            }

            // Apply search filter
            if (hasSearch) {
              const searchLower = args.search!.toLowerCase();
              filteredElements = filteredElements.filter((el) =>
                el.text.toLowerCase().includes(searchLower) ||
                el.href.toLowerCase().includes(searchLower) ||
                (el.label && el.label.toLowerCase().includes(searchLower))
              );
            }

            // Apply limit
            const hasMore = filteredElements.length > limit;
            const displayElements = filteredElements.slice(0, limit);

            // Determine if we're showing input types (need extra columns)
            const inputTypes = ['text', 'email', 'password', 'number', 'tel', 'url', 'search', 'textarea', 'select', 'checkbox', 'radio', 'file', 'date', 'other'];
            const showingInputs = displayElements.some((el) => inputTypes.includes(el.type));

            // Build response header
            let response = '';
            if (hasSearch && hasTypes) {
              response = `Search "${args.search}" in ${args.types!.join(', ')}\n`;
            } else if (hasSearch) {
              response = `Search Results: "${args.search}"\n`;
            } else {
              response = `${args.types!.map(t => t.charAt(0).toUpperCase() + t.slice(1) + 's').join(', ')}\n`;
            }

            response += `Found ${filteredElements.length} matches\n\n`;

            // Helper to check if element is hidden
            const isHidden = (el: ClickableElement) =>
              (el.width ?? 0) <= 0 || (el.height ?? 0) <= 0 || el.visible === false;

            // Compact pipe-delimited format
            if (showingInputs) {
              response += `type|text|selector|required\n`;
              displayElements.forEach((el) => {
                const required = el.required ? 'yes' : '';
                const hidden = showHidden && isHidden(el) ? ' (hidden)' : '';
                response += `${el.type}|${el.text || '(no text)'}${hidden}|${el.selector}|${required}\n`;
              });
            } else {
              response += `type|text|selector\n`;
              displayElements.forEach((el) => {
                const href = el.href ? ` → ${el.href.substring(0, 40)}${el.href.length > 40 ? '...' : ''}` : '';
                const hidden = showHidden && isHidden(el) ? ' (hidden)' : '';
                response += `${el.type}|${el.text || '(no text)'}${hidden}${href}|${el.selector}\n`;
              });
            }

            if (hasMore) {
              response += `\n---\n${filteredElements.length - limit} more elements not shown. Use \`limit: ${limit * 2}\` to see more.\n`;
            }

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          case 'verify': {
            const title = await page.title();

            // Parse checks parameter
            const checks = args.checks as UICheckType[] | undefined;

            // Run UI verification
            const verifier = new UIVerifier(page);
            const result = await verifier.verify({ checks });

            // Build response in TOON format - grouped by issue type to reduce duplication
            const toonEscape = (s: string) => s.includes(' ') || s.includes(';') || s.includes(':') || s.includes('|') ? `(${s})` : s;

            // Group issues by type, then by severity
            const byType = new Map<string, UIIssue[]>();
            for (const issue of result.issues) {
              const key = `${issue.severity}:${issue.type}`;
              if (!byType.has(key)) byType.set(key, []);
              byType.get(key)!.push(issue);
            }

            // Format grouped issues - message once, then list selectors with key details
            const formatGroupedIssues = (issues: UIIssue[]): string => {
              if (issues.length === 0) return '';

              // Get short description based on type
              const typeLabels: Record<string, string> = {
                'small-touch-target': 'min 44x44',
                'overflow-clipping': issues[0].details.overflowStyleY || 'clipped',
                'no-click-handler': 'no handler',
                'dead-link': 'dead href',
                'not-clickable': 'blocked',
                'outside-viewport': 'outside',
                'partially-outside-viewport': 'partial',
                'horizontal-scroll': 'h-scroll',
              };

              const label = typeLabels[issues[0].type] || issues[0].type;

              // Format each selector with key details
              const selectors = issues.map(i => {
                const d = i.details;
                // For overflow, include px amount
                if (d.overflowPixelsY || d.overflowPixelsX) {
                  const px = d.overflowPixelsY || d.overflowPixelsX;
                  return `${toonEscape(i.selector)}:${px}px`;
                }
                // For touch targets, include size
                if (d.width && d.height) {
                  return `${toonEscape(i.selector)}:${d.width}x${d.height}`;
                }
                return toonEscape(i.selector);
              });

              return `(${label})\n    ${selectors.join('\n    ')}`;
            };

            const parts: string[] = [];
            if (title) parts.push(`page:${toonEscape(title)}`);
            parts.push(`scanned:${result.scannedElements}`);
            parts.push(`checks:[${result.checksPerformed.join('|')}]`);
            parts.push(`viewport:${result.viewport.width}x${result.viewport.height}`);

            // Output grouped by severity, then by type
            const severities = ['error', 'warning', 'info'] as const;
            for (const severity of severities) {
              const typesForSeverity = Array.from(byType.entries())
                .filter(([key]) => key.startsWith(severity + ':'))
                .map(([key, issues]) => {
                  const type = key.split(':')[1];
                  return `${type}:${formatGroupedIssues(issues)}`;
                });

              if (typesForSeverity.length > 0) {
                parts.push(`${severity}s:\n  ${typesForSeverity.join('\n  ')}`);
              }
            }

            if (result.issues.length === 0) {
              parts.push('issues:none');
            }

            const response = parts.join('\n');

            return {
              content: [{ type: 'text', text: response }],
            };
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}

