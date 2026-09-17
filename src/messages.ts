/**
 * Message template system for devharness
 *
 * Loads and formats user-facing messages from docs/messages.md
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface MessageTemplate {
  id: string;
  type: 'error' | 'success' | 'warning' | 'info' | 'list';
  code?: string;
  summary?: string;  // Brief action description for status line (e.g., "Breakpoint set")
  content: string;   // Key details and additional info
  once?: string;     // Orientation: rendered on the first call of a session only
  suggestions?: string[];
  note?: string;
  example?: string;
}

class MessageManager {
  private messages: Map<string, MessageTemplate> = new Map();
  private loaded = false;

  /**
   * Load messages from docs/messages.md
   */
  private loadMessages(): void {
    if (this.loaded) return;

    try {
      const messagesPath = join(__dirname, '..', 'docs', 'messages.md');
      const content = readFileSync(messagesPath, 'utf-8');

      this.parseMessages(content);
      this.loaded = true;
    } catch (error) {
      console.error('[devharness] Warning: Failed to load messages.md, using fallback messages:', error);
      this.loadFallbackMessages();
    }
  }

  /**
   * Parse messages from markdown content
   */
  private parseMessages(content: string): void {
    // Split by message headers (## MESSAGE_ID)
    const sections = content.split(/^## /m).filter(s => s.trim());

    for (const section of sections) {
      const lines = section.split('\n');
      const id = lines[0].trim();

      if (!id || id.startsWith('#') || id === 'Variable Templates') continue;

      let type: 'error' | 'success' | 'warning' | 'info' | 'list' = 'info';
      let code: string | undefined;
      let summary: string | undefined;
      let contentLines: string[] = [];
      let suggestions: string[] = [];
      let note: string | undefined;
      let example: string | undefined;

      let inCodeBlock = false;
      let inSuggestions = false;
      let inOnce = false;
      let onceLines: string[] = [];
      let codeBlockLines: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];

        // Parse metadata
        if (line.startsWith('**Type:**')) {
          const typeMatch = line.match(/\*\*Type:\*\*\s+(error|success|warning|info|list)/);
          if (typeMatch) type = typeMatch[1] as any;
          continue;
        }

        if (line.startsWith('**Code:**')) {
          const codeMatch = line.match(/\*\*Code:\*\*\s+(\w+)/);
          if (codeMatch) code = codeMatch[1];
          continue;
        }

        if (line.startsWith('**Summary:**')) {
          summary = line.replace(/\*\*Summary:\*\*\s*/, '').trim();
          continue;
        }

        // Handle code blocks
        if (line.trim().startsWith('```')) {
          if (!inCodeBlock) {
            inCodeBlock = true;
            codeBlockLines = [];
          } else {
            inCodeBlock = false;
            if (example === undefined) {
              example = codeBlockLines.join('\n');
            }
          }
          continue;
        }

        if (inCodeBlock) {
          codeBlockLines.push(line);
          continue;
        }

        // Parse suggestions
        if (line.startsWith('**Suggestions:**')) {
          inSuggestions = true;
          continue;
        }

        if (inSuggestions && line.trim().startsWith('-')) {
          suggestions.push(line.trim().substring(1).trim());
          continue;
        }

        if (line.startsWith('**Note:**')) {
          note = line.replace(/\*\*Note:\*\*\s*/, '').trim();
          continue;
        }

        if (line.startsWith('**Example:**')) {
          continue; // Example code block follows
        }

        // Skip only specific metadata lines, not all lines starting with **
        if (line.startsWith('**Type:**') || line.startsWith('**Code:**')) {
          inSuggestions = false;
          continue;
        }

        // Skip horizontal rules
        if (line.trim() === '---') {
          continue;
        }

        if (line.startsWith('**Once per session:**')) {
          inOnce = true;
          inSuggestions = false;
          continue;
        }

        // Collect content lines
        if (line.trim() && !line.startsWith('#')) {
          (inOnce ? onceLines : contentLines).push(line);
        }
      }

      this.messages.set(id, {
        id,
        type,
        code,
        summary,
        content: contentLines.join('\n').trim(),
        once: onceLines.length > 0 ? onceLines.join('\n').trim() : undefined,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        note,
        example,
      });
    }
  }

  /**
   * Load fallback messages if markdown file can't be loaded
   */
  private loadFallbackMessages(): void {
    this.messages.set('CHROME_ALREADY_RUNNING', {
      id: 'CHROME_ALREADY_RUNNING',
      type: 'error',
      code: 'CHROME_RUNNING',
      content: 'Chrome is already running. Use killChrome() to close the existing instance, or use connectDebugger() to connect to it instead.',
    });

    this.messages.set('DEBUGGER_NOT_CONNECTED', {
      id: 'DEBUGGER_NOT_CONNECTED',
      type: 'error',
      code: 'NOT_CONNECTED',
      content: 'Not connected to debugger',
    });

    this.messages.set('CHROME_NOT_RUNNING', {
      id: 'CHROME_NOT_RUNNING',
      type: 'error',
      code: 'CHROME_NOT_RUNNING',
      content: '{{message}}',
    });

    this.loaded = true;
  }

  /**
   * Get a message by ID with variable substitution
   */
  getMessage(id: string, variables: Record<string, any> = {}): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      console.error(`[devharness] Warning: Message template '${id}' not found`);
      return `Message not found: ${id}`;
    }

    const once = this.takeOnce(id, template);
    const body = this.formatMessage(template.content, variables);
    return once ? `${body}\n\n${this.formatMessage(once, variables)}` : body;
  }

  /** Returns the once block on the first call for that id, nothing after. */
  private takeOnce(id: string, template: MessageTemplate): string | undefined {
    if (!template.once || this.saidOnce.has(id)) return undefined;
    this.saidOnce.add(id);
    return template.once;
  }

  private saidOnce = new Set<string>();

  /**
   * Get a complete message template with metadata
   */
  getMessageTemplate(id: string): MessageTemplate | undefined {
    if (!this.loaded) this.loadMessages();
    return this.messages.get(id);
  }

  /**
   * Format an error message with suggestions and examples
   * Uses the same Status + Key detail format as getFormattedResponse
   */
  getErrorMessage(id: string, variables: Record<string, any> = {}): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      return `Error: Message not found\nTemplate ID: ${id}`;
    }

    // Format the content with variable substitution
    const formattedContent = this.formatMessage(template.content, variables);

    // Build the response with Status + Key detail format
    const lines: string[] = [];

    // Line 1: Status line (always "Error" for error messages)
    if (template.summary) {
      lines.push(`Error: ${this.formatMessage(template.summary, variables)}`);
    } else {
      // Extract first line of content as summary if no explicit summary
      const firstLine = formattedContent.split('\n')[0].trim();
      lines.push(`Error: ${firstLine}`);
    }

    // Line 2: Key detail (first line of content if we have a summary)
    if (template.summary) {
      const firstContentLine = formattedContent.split('\n')[0].trim();
      if (firstContentLine) {
        lines.push(firstContentLine);
      }
    }

    // Build output: first two lines, then blank line, then rest
    let message = lines.join('\n');

    // Determine remaining content (skip lines already used)
    const contentLinesToSkip = template.summary ? 1 : 1;
    const restOfContent = formattedContent.split('\n').slice(contentLinesToSkip).join('\n').trim();

    // Always add blank line after first section, then rest of content if any
    if (restOfContent) {
      message += '\n\n' + restOfContent;
    }

    if (template.suggestions && template.suggestions.length > 0) {
      message += '\n\n**Suggestions:**\n';
      template.suggestions.forEach(suggestion => {
        message += `- ${this.formatMessage(suggestion, variables)}\n`;
      });
    }

    if (template.note) {
      message += `\n\n**Note:** ${this.formatMessage(template.note, variables)}`;
    }

    if (template.example) {
      message += `\n\n**Example:**\n${template.example}`;
    }

    return message.trim();
  }

  /**
   * Resolve a dotted path to a value in the variables object
   */
  private resolveVariable(key: string, variables: Record<string, any>): any {
    return key.split('.').reduce((obj: any, prop: string) => {
      return obj && obj[prop] !== undefined ? obj[prop] : undefined;
    }, variables);
  }

  /**
   * Format a message template with variable substitution
   * Supports:
   * - {{variable}} - simple substitution
   * - {{object.property}} - nested access
   * - {{#variable}}...{{/variable}} - conditional (truthy)
   * - {{^variable}}...{{/variable}} - inverted conditional (falsy)
   * - {{#if condition}}...{{/if}} - explicit if blocks
   * - {{#each array}}...{{/each}} - iteration over arrays
   */
  private formatMessage(template: string, variables: Record<string, any>): string {
    let result = template;

    // Process conditionals and loops repeatedly until no more changes (handles nested)
    let previousResult = '';
    let iterations = 0;
    const maxIterations = 100; // Prevent infinite loops

    while (previousResult !== result && iterations < maxIterations) {
      previousResult = result;
      iterations++;

      // Handle {{#each array}}...{{/each}} loops - must be processed before conditionals
      result = result.replace(/\{\{#each\s+([\w.]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (match, key, content) => {
        const array = this.resolveVariable(key, variables);
        if (!Array.isArray(array) || array.length === 0) {
          return ''; // Remove block if not an array or empty
        }

        // Iterate and substitute each item
        return array.map((item, index) => {
          // Create a context with the item's properties available directly
          // and also as 'this' for simple values
          let itemContent = content;

          if (typeof item === 'object' && item !== null) {
            // For objects, substitute {{property}} with item.property
            itemContent = itemContent.replace(/\{\{([\w.]+)\}\}/g, (m: string, prop: string) => {
              // Check if it's a property of the item
              if (prop in item) {
                return String(item[prop] ?? '');
              }
              // Check nested properties
              const value = this.resolveVariable(prop, item);
              if (value !== undefined) {
                return String(value);
              }
              // Fall back to parent variables
              const parentValue = this.resolveVariable(prop, variables);
              if (parentValue !== undefined) {
                return String(parentValue);
              }
              return m; // Keep placeholder if not found
            });

            // Handle conditionals within each block using item context
            itemContent = this.processConditionals(itemContent, { ...variables, ...item });
          } else {
            // For primitive values, {{this}} refers to the value
            itemContent = itemContent.replace(/\{\{this\}\}/g, String(item));
          }

          return itemContent;
        }).join('');
      });

      // Handle {{#if condition}}...{{/if}} blocks
      result = result.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
        const value = this.resolveVariable(key, variables);
        // Check for truthy: non-null, non-undefined, non-empty array, non-empty string, true
        const isTruthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
        if (isTruthy) {
          return content;
        }
        return '';
      });

      // Handle conditional blocks {{#var}}...{{/var}} (truthy) - original syntax
      result = result.replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
        // Skip if this looks like a helper (if, each, etc.)
        if (['if', 'each', 'unless'].includes(key)) {
          return match;
        }
        const value = this.resolveVariable(key, variables);
        if (value) {
          return content;
        }
        return '';
      });

      // Handle inverted conditional blocks {{^var}}...{{/var}} (falsy)
      result = result.replace(/\{\{\^([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
        const value = this.resolveVariable(key, variables);
        if (!value) {
          return content;
        }
        return '';
      });
    }

    // Final pass: Variable substitution supporting dot notation {{var}} or {{obj.prop}}
    result = result.replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
      const value = this.resolveVariable(key, variables);

      if (value !== undefined) {
        return String(value);
      }
      return match; // Keep placeholder if variable not provided
    });

    return result;
  }

  /**
   * Process conditionals within a given context (used by #each)
   */
  private processConditionals(template: string, context: Record<string, any>): string {
    let result = template;

    // Handle {{#if condition}}...{{/if}} blocks
    result = result.replace(/\{\{#if\s+([\w.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
      const value = this.resolveVariable(key, context);
      const isTruthy = Array.isArray(value) ? value.length > 0 : Boolean(value);
      return isTruthy ? content : '';
    });

    // Handle {{#var}}...{{/var}} conditionals (truthy)
    result = result.replace(/\{\{#([\w.]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (match, key, content) => {
      if (['if', 'each', 'unless'].includes(key)) {
        return match;
      }
      const value = this.resolveVariable(key, context);
      return value ? content : '';
    });

    return result;
  }

  /**
   * Get message code for error responses
   */
  getMessageCode(id: string): string | undefined {
    if (!this.loaded) this.loadMessages();
    return this.messages.get(id)?.code;
  }

  /**
   * Check if a message exists
   */
  hasMessage(id: string): boolean {
    if (!this.loaded) this.loadMessages();
    return this.messages.has(id);
  }

  /**
   * Format data as a JSON code block
   */
  formatCodeBlock(data: any, language: string = 'json'): string {
    const jsonString = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    return `\`\`\`${language}\n${jsonString}\n\`\`\``;
  }

  /**
   * Format an array as a markdown bullet list
   */
  formatList(items: string[]): string {
    return items.map(item => `- ${item}`).join('\n');
  }

  /**
   * Get a complete markdown-only response for a tool
   * Combines message template with optional data formatting
   *
   * Output format:
   * Line 1: Status line (Success/Error/Warning/Info: Brief description)
   * Line 2: Key detail (most important info like location, ID, count)
   * Line 3+: Additional content (suggestions, notes, data)
   */
  getFormattedResponse(id: string, variables: Record<string, any> = {}, data?: any): string {
    if (!this.loaded) this.loadMessages();

    const template = this.messages.get(id);
    if (!template) {
      return `Error: Message template not found\nTemplate ID: ${id}`;
    }

    // Format the content with variable substitution
    const formattedContent = this.formatMessage(template.content, variables);

    // Build the response with Status + Key detail format
    const lines: string[] = [];

    // Line 1: Status line (skip prefix for 'list' and 'success' types - they're self-evident)
    const typeLabel = template.type.charAt(0).toUpperCase() + template.type.slice(1);
    const skipPrefix = template.type === 'list' || template.type === 'success';
    if (template.summary) {
      const summaryText = this.formatMessage(template.summary, variables);
      lines.push(skipPrefix ? summaryText : `${typeLabel}: ${summaryText}`);
    } else {
      // Extract first line of content as summary if no explicit summary
      const firstLine = formattedContent.split('\n')[0].trim();
      lines.push(skipPrefix ? firstLine : `${typeLabel}: ${firstLine}`);
    }

    // Line 2: Key detail (first line of content if we have a summary)
    if (template.summary) {
      const firstContentLine = formattedContent.split('\n')[0].trim();
      if (firstContentLine) {
        lines.push(firstContentLine);
      }
    }

    // Build output: first two lines, then blank line, then rest
    let markdown = lines.join('\n');

    // Determine remaining content (skip lines already used)
    const contentLinesToSkip = template.summary ? 1 : 1;
    const restOfContent = formattedContent.split('\n').slice(contentLinesToSkip).join('\n').trim();

    // Always add blank line after first section, then rest of content if any
    if (restOfContent) {
      markdown += '\n\n' + restOfContent;
    }

    // Add suggestions for errors
    if (template.type === 'error' && template.suggestions && template.suggestions.length > 0) {
      markdown += '\n\n**Suggestions:**\n';
      template.suggestions.forEach(suggestion => {
        markdown += `- ${this.formatMessage(suggestion, variables)}\n`;
      });
    }

    // Add note if present
    if (template.note) {
      markdown += `\n\n**Note:** ${this.formatMessage(template.note, variables)}`;
    }

    const once = this.takeOnce(id, template);
    if (once) {
      markdown += `\n\n${this.formatMessage(once, variables)}`;
    }

    // Add example for errors
    if (template.type === 'error' && template.example) {
      markdown += `\n\n**Example:**\n${template.example}`;
    }

    // Add data as code block if provided
    if (data !== undefined) {
      markdown += '\n\n';
      if (typeof data === 'object') {
        markdown += this.formatCodeBlock(data);
      } else {
        markdown += data;
      }
    }

    return markdown.trim();
  }
}

// Export singleton instance
export const messages = new MessageManager();

/**
 * Helper function to get a formatted message
 */
export function getMessage(id: string, variables?: Record<string, any>): string {
  return messages.getMessage(id, variables);
}

/**
 * Helper function to get a formatted error message with suggestions
 */
export function getErrorMessage(id: string, variables?: Record<string, any>): string {
  return messages.getErrorMessage(id, variables);
}

/**
 * Helper function to get message code
 */
export function getMessageCode(id: string): string | undefined {
  return messages.getMessageCode(id);
}

/**
 * Helper function to get a complete markdown-only response
 */
export function getFormattedResponse(id: string, variables?: Record<string, any>, data?: any): string {
  return messages.getFormattedResponse(id, variables, data);
}

/**
 * Helper function to format data as a code block
 */
export function formatCodeBlock(data: any, language: string = 'json'): string {
  return messages.formatCodeBlock(data, language);
}

/**
 * Helper function to format an array as a markdown list
 */
export function formatList(items: string[]): string {
  return messages.formatList(items);
}

import type { ToolResponseMeta } from './tool-response.js';

/**
 * MCP Response type
 */
interface MCPResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  /** Structured metadata for programmatic use (validation, replay). Decoupled from text output. */
  _meta?: ToolResponseMeta;
  /**
   * Message template id behind an error, for callers that must classify a
   * failure rather than display it. In-process only - the replay executor reads
   * the handler's return value (and ToolError's captured response) before
   * anything is serialized, so it need not survive the wire.
   */
  _errorId?: string;
}

/**
 * Create an error response in MCP format with markdown content
 */
export function createErrorResponse(messageId: string, variables?: Record<string, any>): MCPResponse {
  return {
    content: [
      {
        type: 'text',
        text: getErrorMessage(messageId, variables),
      },
    ],
    isError: true,
    _errorId: messageId,
  };
}

/**
 * Whether a tool failure means "that element isn't on the page", as opposed to
 * any other failure. Prefers the response's `_errorId`; the text forms are for
 * a failure that arrived without one. Lives beside the ELEMENT_NOT_FOUND
 * template so a reword is caught here rather than in every caller that
 * classifies one.
 */
export function isElementNotFoundFailure(failure: { errorId?: string; text?: string }): boolean {
  if (failure.errorId) return failure.errorId === 'ELEMENT_NOT_FOUND';
  const text = failure.text || '';
  // The second is puppeteer's own phrasing, for a handler that let the
  // library's error through instead of returning ELEMENT_NOT_FOUND.
  return /Element not found:/.test(text) || /No element found for selector/i.test(text);
}

/**
 * Create a success response in MCP format with markdown content
 */
export function createSuccessResponse(messageId: string, variables?: Record<string, any>, data?: any): MCPResponse {
  return {
    content: [
      {
        type: 'text',
        text: getFormattedResponse(messageId, variables, data),
      },
    ],
  };
}

/**
 * Format a tool success response (for tools that don't use message templates)
 * Uses Status + Key detail format
 */
export function formatToolSuccess(message: string, data?: any): MCPResponse {
  let text = `Success: ${message}`;
  if (data) {
    text += '\n\n' + formatCodeBlock(data);
  }
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Format a tool error response (for tools that don't use message templates)
 * Uses Status + Key detail format
 */
export function formatToolError(code: string, message: string, data?: any): MCPResponse {
  let text = `Error: ${message}\nCode: ${code}`;
  if (data) {
    text += '\n\n' + formatCodeBlock(data);
  }
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

// Console-specific formatting functions have been moved to:
// src/formatters/console-formatter.ts
