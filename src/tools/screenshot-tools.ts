/**
 * Screenshot Tools
 */

import { z } from 'zod';
import { executeWithPauseDetection, actionFailureResponse } from '../debugger-aware-wrapper.js';
import { checkBrowserAutomation } from '../error-helpers.js';
import { createTool } from '../validation-helpers.js';
import { promises as fs } from 'fs';
import path from 'path';
import { createSuccessResponse, createErrorResponse } from '../messages.js';
import { spawn } from 'child_process';
import { resolveSelector, isExtendedSelector, cleanupResolvedSelector } from '../utils/selector-resolver.js';
import { getOutputPath, getTempPath } from '../helpers/paths.js';
import { throwIfAborted } from '../utils/abort.js';

// WeasyPrint availability cache
let weasyPrintCache: { available: boolean; version?: string; error?: string; checkedAt: number } | null = null;
const CACHE_TTL = 60000; // 1 minute

/**
 * Check if WeasyPrint is installed and available
 */
async function checkWeasyPrintAvailable(): Promise<{ available: boolean; version?: string; error?: string }> {
  // Return cached result if fresh
  if (weasyPrintCache && (Date.now() - weasyPrintCache.checkedAt) < CACHE_TTL) {
    return { available: weasyPrintCache.available, version: weasyPrintCache.version, error: weasyPrintCache.error };
  }

  return new Promise((resolve) => {
    const process = spawn('weasyprint', ['--version']);

    let output = '';
    let errorOutput = '';
    let resolved = false;

    process.stdout.on('data', (data) => {
      output += data.toString();
    });

    process.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    process.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      if (code === 0) {
        const version = output.trim() || errorOutput.trim(); // Version might be on stderr
        const result = { available: true, version };
        weasyPrintCache = { ...result, checkedAt: Date.now() };
        resolve(result);
      } else {
        const result = {
          available: false,
          error: 'WeasyPrint not found in PATH or failed to execute'
        };
        weasyPrintCache = { ...result, checkedAt: Date.now() };
        resolve(result);
      }
    });

    process.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      const result = {
        available: false,
        error: `Failed to execute weasyprint: ${err.message}`
      };
      weasyPrintCache = { ...result, checkedAt: Date.now() };
      resolve(result);
    });

    // Timeout after 5 seconds
    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      process.kill();

      const result = {
        available: false,
        error: 'WeasyPrint check timed out'
      };
      weasyPrintCache = { ...result, checkedAt: Date.now() };
      resolve(result);
    }, 5000);
  });
}

/**
 * Validate page has printable content
 */
async function validatePageContent(page: any): Promise<{ valid: boolean; error?: string }> {
  const pageUrl = page.url();

  // Reject chrome:// and about: URLs
  if (pageUrl.startsWith('chrome://') || pageUrl.startsWith('about:')) {
    return {
      valid: false,
      error: `Cannot print ${pageUrl}. Please navigate to a web page with content first.`
    };
  }

  // Check if page has meaningful content
  const hasContent = await page.evaluate(() => {
    // @ts-ignore - This code runs in browser context
    const body = document.body;
    if (!body) return false;

    // Check if body has text content
    const text = body.innerText.trim();
    if (text.length > 10) return true;

    // Check if body has visible elements (images, videos, etc.)
    const elements = body.querySelectorAll('img, video, canvas, svg, iframe');
    if (elements.length > 0) return true;

    // Check if there are any styled elements with dimensions
    const styledElements = body.querySelectorAll('div, section, article, main');
    for (const el of Array.from(styledElements)) {
      // @ts-ignore - This code runs in browser context
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return true;
      }
    }

    return false;
  });

  if (!hasContent) {
    return {
      valid: false,
      error: 'Page appears to be blank or has no printable content. Please navigate to a page with content first.'
    };
  }

  return { valid: true };
}

/**
 * Generate PDF using WeasyPrint engine
 */
async function generatePDFWithWeasyPrint(
  page: any,
  args: {
    saveToDisk: string;
    mediaType?: 'print' | 'screen';
    baseUrl?: string;
    stylesheets?: string[];
    optimizeImages?: boolean;
    timeout?: number;
  }
): Promise<{ success: boolean; notInstalled?: boolean; filepath?: string; fileSize?: string; version?: string; error?: string; context?: any }> {
  // A binary absent from PATH fails to spawn (ENOENT) rather than exiting
  // non-zero, so availability is carried as a flag rather than read off the text.
  const wpCheck = await checkWeasyPrintAvailable();
  if (!wpCheck.available) {
    return {
      success: false,
      notInstalled: true,
      error: wpCheck.error || 'WeasyPrint not found',
      context: { version: wpCheck.version }
    };
  }

  // Validate page content
  const contentValidation = await validatePageContent(page);
  if (!contentValidation.valid) {
    return {
      success: false,
      error: contentValidation.error
    };
  }

  const pageUrl = page.url();

  // Prepare output path
  const outputPath = path.isAbsolute(args.saveToDisk)
    ? args.saveToDisk
    : path.join(process.cwd(), args.saveToDisk);

  // Ensure output directory exists
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  // Build WeasyPrint command - use URL directly instead of temp file
  const wpArgs = [pageUrl, outputPath];
  wpArgs.push('--media-type', args.mediaType || 'print');

  if (args.baseUrl) {
    wpArgs.push('--base-url', args.baseUrl);
  }

  // Inject A4 page size via CSS to match Chrome default (WeasyPrint has no --page-size flag)
  // Create temporary CSS file with @page rule
  const tempCssPath = getTempPath(`a4-page-${Date.now()}.css`);
  await fs.mkdir(path.dirname(tempCssPath), { recursive: true });
  await fs.writeFile(tempCssPath, '@page { size: A4; margin: 1cm; }');
  wpArgs.push('--stylesheet', tempCssPath);

  if (args.stylesheets && args.stylesheets.length > 0) {
    for (const stylesheet of args.stylesheets) {
      wpArgs.push('--stylesheet', stylesheet);
    }
  }

  if (args.optimizeImages !== false) {
    wpArgs.push('--optimize-images');
  }

  const timeoutMs = args.timeout || 30000;

  // Execute WeasyPrint
  const result = await new Promise<{ success: boolean; error?: string; stderr?: string }>((resolve) => {
    const wpProcess = spawn('weasyprint', wpArgs);
    let errorOutput = '';
    let resolved = false;

    wpProcess.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    wpProcess.on('close', (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      if (code === 0) {
        resolve({ success: true });
      } else {
        resolve({
          success: false,
          error: errorOutput || `WeasyPrint exited with code ${code}`,
          stderr: errorOutput
        });
      }
    });

    wpProcess.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutHandle);

      resolve({
        success: false,
        error: `Failed to execute WeasyPrint: ${err.message}`
      });
    });

    const timeoutHandle = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      wpProcess.kill();

      resolve({
        success: false,
        error: `WeasyPrint execution timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);
  });

  // Clean up temp CSS file
  try {
    await fs.unlink(tempCssPath);
  } catch {
    // Ignore cleanup errors
  }

  if (!result.success) {
    return {
      success: false,
      error: result.error || 'Unknown error',
      context: {
        pageUrl,
        command: `weasyprint ${wpArgs.join(' ')}`,
        stderr: result.stderr,
        version: wpCheck.version
      }
    };
  }

  // Get PDF file size
  const stats = await fs.stat(outputPath);
  const fileSizeMB = (stats.size / 1_000_000).toFixed(2);

  return {
    success: true,
    filepath: outputPath,
    fileSize: `${fileSizeMB} MB`,
    version: wpCheck.version
  };
}

/**
 * Generate PDF using Chrome engine
 */
async function generatePDFWithChrome(
  page: any,
  args: {
    saveToDisk?: string;
    landscape?: boolean;
    printBackground?: boolean;
    scale?: number;
    paperWidthCm?: number;
    paperHeightCm?: number;
  }
): Promise<{ success: boolean; filepath?: string; fileSize?: string; error?: string; context?: any }> {
  // Validate page content
  const contentValidation = await validatePageContent(page);
  if (!contentValidation.valid) {
    return {
      success: false,
      error: contentValidation.error
    };
  }

  const pageUrl = page.url();

  let cdpSession: any;
  try {
    cdpSession = await page.createCDPSession();

    // A4 paper size in cm: 21.0 x 29.7 (default for consistency with WeasyPrint)
    const a4WidthCm = 21.0;
    const a4HeightCm = 29.7;

    // Convert cm to inches (CDP expects inches): 1 cm = 0.393701 inches
    const cmToInches = (cm: number) => cm * 0.393701;

    const paperWidthInches = args.paperWidthCm ? cmToInches(args.paperWidthCm) : cmToInches(a4WidthCm);
    const paperHeightInches = args.paperHeightCm ? cmToInches(args.paperHeightCm) : cmToInches(a4HeightCm);

    // Use CDP Page.printToPDF command
    const pdfData = await cdpSession.send('Page.printToPDF', {
      landscape: args.landscape ?? false,
      printBackground: args.printBackground ?? true,
      scale: args.scale ?? 1,
      paperWidth: paperWidthInches,
      paperHeight: paperHeightInches,
    });

    const buffer = Buffer.from(pdfData.data, 'base64');

    // Without a path, the PDF goes where screenshots go; the reply carries no
    // PDF body, so a PDF not written anywhere was lost.
    const filepath = args.saveToDisk
      ? (path.isAbsolute(args.saveToDisk) ? args.saveToDisk : path.join(process.cwd(), args.saveToDisk))
      : path.join(getOutputPath('pdfs', new Date().toISOString().split('T')[0]), `page-${Date.now()}.pdf`);

    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, buffer);

    return {
      success: true,
      filepath,
      fileSize: `${(buffer.length / 1_000_000).toFixed(2)} MB`,
    };
  } catch (error: any) {
    return {
      success: false,
      error: error.message,
      context: {
        pageUrl,
        options: {
          landscape: args.landscape,
          printBackground: args.printBackground,
          scale: args.scale,
          paperWidthCm: args.paperWidthCm,
          paperHeightCm: args.paperHeightCm
        }
      }
    };
  } finally {
    await cdpSession?.detach().catch(() => {});
  }
}

const clipSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
}).strict();

const screenshotSchema = z.object({
  action: z.enum(['fullPage', 'viewport', 'element', 'pdf']),
  connectionReason: z.string(),

  // Screenshot options
  type: z.enum(['png', 'jpeg']).optional(),
  quality: z.number().min(0).max(100).optional().describe('JPEG quality 0-100'),
  clip: clipSchema.optional().describe('Region to capture'),
  saveToDisk: z.string().optional().describe('Output path (default: .devharness/screenshots/ or .devharness/pdfs/)'),
  autoSaveThreshold: z.number().optional().describe('Auto-save bytes threshold'),
  fullPage: z.boolean().optional(),

  // Element
  selector: z.string().optional().describe('CSS selector. Supports :has-text(), :text()'),

  // PDF options
  engine: z.enum(['chrome', 'weasyprint']).optional(),
  landscape: z.boolean().optional(),
  printBackground: z.boolean().optional(),
  scale: z.number().optional().describe('Page scale 0.1-2'),
  paperWidthCm: z.number().optional(),
  paperHeightCm: z.number().optional(),
  mediaType: z.enum(['print', 'screen']).optional(),
  baseUrl: z.string().optional(),
  stylesheets: z.array(z.string()).optional(),
  optimizeImages: z.boolean().optional(),
  timeout: z.number().optional().describe('Timeout ms').refine(val => val === undefined || (val >= 1000 && val <= 120000), {
    message: 'Timeout must be between 1000ms and 120000ms'
  }),
}).strict();

export function createScreenshotTools(resolveConnectionFromReason: (connectionReason: string) => Promise<any>) {
  /**
   * Save screenshot buffer to disk
   */
  const saveScreenshotToDisk = async (buffer: Buffer, type: string, suggestedPath?: string): Promise<string> => {
    const timestamp = Date.now();
    const ext = type === 'png' ? 'png' : 'jpg';

    // If user provided a path, use it
    if (suggestedPath) {
      const filepath = path.isAbsolute(suggestedPath) ? suggestedPath : path.join(process.cwd(), suggestedPath);
      await fs.mkdir(path.dirname(filepath), { recursive: true });
      await fs.writeFile(filepath, buffer);
      return filepath;
    }

    // Default: save to .devharness/screenshots/YYYY-MM-DD/
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const screenshotDir = getOutputPath('screenshots', date);

    // Ensure directory exists
    await fs.mkdir(screenshotDir, { recursive: true });

    const filename = `screenshot-${timestamp}.${ext}`;
    const filepath = path.join(screenshotDir, filename);

    await fs.writeFile(filepath, buffer);

    return filepath;
  };

  return {
    screenshot: createTool(
      'Visual verification only. Use extractText for content. Actions: fullPage (full page screenshot), viewport (viewport screenshot), element (element screenshot), pdf (print to PDF with Chrome or WeasyPrint engines)',
      screenshotSchema,
      // abortSignal (#110): ENTRY CHECKPOINT ONLY - enough to not START a
      // capture (or, for `pdf`, a multi-second WeasyPrint/Chrome print) after
      // the user has cancelled. Once started there is nothing to cancel: the
      // capture is one CDP call and the PDF engines are a spawned process /
      // Page.printToPDF with their own timeouts, neither of which takes a
      // signal. Adding one is a bigger change than a checkpoint, so it is
      // deliberately not done here.
      async (args, abortSignal?: AbortSignal) => {
        const { action } = args;

        throwIfAborted(abortSignal);

        // Resolve connection from reason
        const resolved = await resolveConnectionFromReason(args.connectionReason);
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

        switch (action) {
          case 'fullPage': {
            const fullPage = args.fullPage ?? true;
            const type = args.type || 'jpeg';
            const quality = args.quality ?? (args.clip ? 50 : 30);
            const autoSaveThreshold = args.autoSaveThreshold ?? 1;

            // Get screenshot as Buffer (not base64 yet)
            const screenshot = await page.screenshot({
              fullPage,
              type: type as 'png' | 'jpeg',
              ...(type === 'jpeg' && { quality }),
              ...(args.clip && { clip: args.clip }),
              optimizeForSpeed: true,
            }) as Buffer;

            // Check if we should save to disk
            const shouldSaveToDisk = screenshot.length >= autoSaveThreshold || args.saveToDisk;

            if (shouldSaveToDisk) {
              const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
              const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
              const fileSize = `${sizeMB}MB`;
              return createSuccessResponse('SCREENSHOT_SAVED', { filepath, fileSize });
            }

            // Small screenshot: return as native image content
            return {
              content: [
                {
                  type: 'text',
                  text: `Screenshot captured (${(screenshot.length / 1000).toFixed(1)}KB)`,
                },
                {
                  type: 'image',
                  data: screenshot.toString('base64'),
                  mimeType: `image/${type}`,
                },
              ],
            };
          }

          case 'viewport': {
            const type = args.type || 'jpeg';
            const quality = args.quality ?? (args.clip ? 50 : 30);
            const autoSaveThreshold = args.autoSaveThreshold ?? 1;

            // Get screenshot as Buffer (not base64 yet)
            const screenshot = await page.screenshot({
              fullPage: false,
              type: type as 'png' | 'jpeg',
              ...(type === 'jpeg' && { quality }),
              ...(args.clip && { clip: args.clip }),
              optimizeForSpeed: true,
            }) as Buffer;

            // Check if we should save to disk
            const shouldSaveToDisk = screenshot.length >= autoSaveThreshold || args.saveToDisk;

            if (shouldSaveToDisk) {
              const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
              const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
              const fileSize = `${sizeMB}MB`;
              return createSuccessResponse('SCREENSHOT_SAVED', { filepath, fileSize });
            }

            // Small screenshot: return as native image content
            return {
              content: [
                {
                  type: 'text',
                  text: `Viewport screenshot captured (${(screenshot.length / 1000).toFixed(1)}KB)`,
                },
                {
                  type: 'image',
                  data: screenshot.toString('base64'),
                  mimeType: `image/${type}`,
                },
              ],
            };
          }

          case 'element': {
            if (!args.selector) {
              return createErrorResponse('INVALID_PARAMS', { message: 'selector is required for element action' });
            }

            const rawSelector = args.selector;

            // Resolve extended selectors (like :has-text())
            let selector = rawSelector;
            let selectorWarning: string | undefined;
            if (isExtendedSelector(selector)) {
              const resolved = await resolveSelector(page, selector);
              if ('error' in resolved) {
                return createErrorResponse('ELEMENT_NOT_FOUND', {
                  selector: rawSelector,
                  suggestion: resolved.suggestion,
                });
              }
              selector = resolved.selector;
              selectorWarning = resolved.warning;
            }

            const type = args.type || 'jpeg';
            const quality = args.quality ?? 50;
            const autoSaveThreshold = args.autoSaveThreshold ?? 1;

            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                const element = await page.$(selector);

                if (!element) {
                  return { error: `Element not found: ${selector}` };
                }

                // Get screenshot as Buffer
                const screenshot = await element.screenshot({
                  type: type as 'png' | 'jpeg',
                  ...(type === 'jpeg' && { quality }),
                  optimizeForSpeed: true,
                }) as Buffer;

                // Check if we should save to disk
                const shouldSaveToDisk = screenshot.length >= autoSaveThreshold || args.saveToDisk;

                if (shouldSaveToDisk) {
                  const filepath = await saveScreenshotToDisk(screenshot, type, args.saveToDisk);
                  const sizeMB = (screenshot.length / 1_000_000).toFixed(2);
                  return {
                    selector: rawSelector,
                    filepath,
                    size: `${sizeMB}MB`,
                  };
                }

                return {
                  selector: rawSelector,
                  type,
                  buffer: screenshot,
                  size: `${(screenshot.length / 1000).toFixed(1)}KB`,
                };
              },
              'takeElementScreenshot'
            );

            // Clean up temporary selector attribute
            await cleanupResolvedSelector(page, selector);

            {
              const failed = actionFailureResponse(result, 'element screenshot', rawSelector);
              if (failed) return failed;
            }
            if (result.result?.error) {
              return createErrorResponse('ELEMENT_NOT_FOUND', { selector: rawSelector });
            }

            // Handle disk save
            if (result.result?.filepath) {
              const response = createSuccessResponse('SCREENSHOT_SAVED', {
                filepath: result.result.filepath,
                fileSize: result.result.size,
              });
              if (selectorWarning) {
                response.content[0].text += `\n\n**Warning:** ${selectorWarning}`;
              }
              return response;
            }

            // Handle image return - small screenshots
            let captureText = `Element screenshot captured for \`${rawSelector}\` (${result.result?.size})`;
            if (selectorWarning) {
              captureText += `\n\n**Warning:** ${selectorWarning}`;
            }
            return {
              content: [
                {
                  type: 'text',
                  text: captureText,
                },
                {
                  type: 'image',
                  data: result.result?.buffer?.toString('base64') || '',
                  mimeType: `image/${type}`,
                },
              ],
            };
          }

          case 'pdf': {
            const engine = args.engine || 'chrome';

            // Both engines read the page's content first, which a paused page
            // answers only once it resumes.
            if (targetCdpManager.isPaused()) {
              return createErrorResponse('PDF_GENERATION_FAILED', { error: 'execution is paused at a breakpoint' });
            }

            // Branch based on engine
            if (engine === 'weasyprint') {
              if (!args.saveToDisk) {
                return createErrorResponse('INVALID_PARAMS', { message: 'saveToDisk is required for WeasyPrint engine' });
              }

              const result = await generatePDFWithWeasyPrint(page, {
                saveToDisk: args.saveToDisk,
                mediaType: args.mediaType,
                baseUrl: args.baseUrl,
                stylesheets: args.stylesheets,
                optimizeImages: args.optimizeImages,
                timeout: args.timeout,
              });

              if (!result.success) {
                if (result.notInstalled) {
                  return createErrorResponse('WEASYPRINT_NOT_FOUND', {
                    error: result.error,
                    ...result.context
                  });
                }

                return createErrorResponse('WEASYPRINT_EXECUTION_FAILED', {
                  error: result.error || 'Unknown error',
                  ...result.context
                });
              }

              return createSuccessResponse('PDF_SAVED', {
                filepath: result.filepath!,
                fileSize: result.fileSize!,
                engine: 'weasyprint',
                version: result.version
              });
            }

            // Chrome engine
            const result = await executeWithPauseDetection(
              targetCdpManager,
              async () => {
                return await generatePDFWithChrome(page, {
                  saveToDisk: args.saveToDisk,
                  landscape: args.landscape,
                  printBackground: args.printBackground,
                  scale: args.scale,
                  paperWidthCm: args.paperWidthCm,
                  paperHeightCm: args.paperHeightCm,
                });
              },
              'printToPDF'
            );

            if (!result.success || !result.result || result.result.error) {
              return createErrorResponse('PDF_GENERATION_FAILED', {
                error: result.result?.error || result.error
                  || (result.pausedAtBreakpoint ? 'execution is paused at a breakpoint' : 'Unknown error occurred'),
                ...result.result?.context
              });
            }

            return createSuccessResponse('PDF_SAVED', {
              filepath: result.result.filepath!,
              fileSize: result.result.fileSize!,
              engine: 'chrome'
            });
          }

          default:
            return createErrorResponse('INVALID_ACTION', { action });
        }
      }
    ),
  };
}
