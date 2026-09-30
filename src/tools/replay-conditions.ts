/**
 * Page-state conditions in the `{{type:value}}` grammar, answered against the
 * run's connection.
 */

import { configManager } from '../config.js';
import { debugLog } from '../debug-logger.js';
import { isElementNotFoundFailure } from '../messages.js';
import type { ExecutionContext } from './replay-types.js';

// =============================================================================
// Page-state conditions, read by the check engine for url, cookie, storage and IndexedDB checks
// =============================================================================

/**
 * Result of condition evaluation
 * - met: true - condition matched
 * - met: false, isError: undefined - condition legitimately not met
 * - met: false, isError: true - evaluation FAILED (should stop sequence)
 */
export type ConditionResult =
  | { met: true }
  | { met: false; reason?: string }
  | { met: false; reason: string; isError: true };

/** The condition types `evaluateCondition` knows how to answer. */
export const CONDITION_TYPES = ['selector', 'url', 'cookie', 'localStorage', 'indexedDB'] as const;

/** Shape of a handlebar condition: `{{type:value}}` or `{{!type:value}}`. */
const CONDITION_PATTERN = /^\{\{(!?)(\w+):(.+)\}\}$/;

/**
 * Evaluate a handlebar-style condition
 * Supported patterns:
 *   {{selector:CSS_SELECTOR}}     - true if element exists
 *   {{!selector:CSS_SELECTOR}}    - true if element does NOT exist
 *   {{url:contains:STRING}}       - true if URL contains string
 *   {{url:matches:REGEX}}         - true if URL matches regex
 *   {{cookie:NAME}}               - true if cookie exists
 *   {{!cookie:NAME}}              - true if cookie does NOT exist
 *   {{localStorage:KEY}}          - true if localStorage key exists
 *   {{!localStorage:KEY}}         - true if localStorage key does NOT exist
 *   {{indexedDB:DB/STORE/KEY}}    - true if that IndexedDB record exists
 *   {{indexedDB:DB/STORE}}        - true if that object store holds any record
 *   {{!indexedDB:...}}            - negation of either form
 */
export async function evaluateCondition(
  condition: string,
  ctx: ExecutionContext
): Promise<ConditionResult> {
  const { executeToolCall, connectionReason, logPrefix = 'executor' } = ctx;
  const replayConfig = configManager.getReplayConfig();

  // Parse the handlebar pattern
  const match = condition.match(CONDITION_PATTERN);
  if (!match) {
    return {
      met: false,
      reason: `Invalid condition format: "${condition}". Expected {{type:value}} or {{!type:value}}. Supported types: ${CONDITION_TYPES.join(', ')}`,
      isError: true
    };
  }

  const [, negated, type, value] = match;
  const isNegated = negated === '!';

  await debugLog(logPrefix, `Evaluating condition: ${type}${isNegated ? ' (negated)' : ''} = ${value}`);

  try {
    let conditionMet = false;

    switch (type) {
      case 'selector': {
        // Absence is the answer, not a broken condition: it arrives as a thrown
        // ToolError, which any other failure does too - hence the classifier.
        const probeSelector = async () => {
          try {
            await executeToolCall('dom', {
              action: 'querySelector',
              selector: value,
              connectionReason
            });
            return {};
          } catch (selectorError: any) {
            return {
              failure: selectorError?.message || String(selectorError),
              errorId: selectorError?.response?._errorId,
            };
          }
        };

        // querySelector answers only when it finds the element; absence is its error.
        const attempt = await probeSelector();
        if (attempt.failure) {
          if (isElementNotFoundFailure({ errorId: attempt.errorId, text: attempt.failure })) {
            conditionMet = false;
            break;
          }
          return {
            met: false,
            reason: `Error evaluating selector condition "${value}": ${attempt.failure}`,
            isError: true
          };
        }
        conditionMet = true;
        break;
      }

      case 'url': {
        const pageInfo = await executeToolCall('navigate', {
          action: 'info',
          connectionReason
        });
        // From `_meta`: the rendered text ends the URL at the first comma or
        // space, so a data: URL or a `?ids=1,2` query would compare truncated.
        const currentUrl = pageInfo?._meta?.navigate?.url ?? '';

        if (value.startsWith('contains:')) {
          const searchStr = value.substring('contains:'.length);
          conditionMet = currentUrl.includes(searchStr);
        } else if (value.startsWith('matches:')) {
          const pattern = value.substring('matches:'.length);

          // Check regex length limit
          if (pattern.length > replayConfig.maxRegexLength) {
            return {
              met: false,
              reason: `Regex pattern too long (${pattern.length} chars, max ${replayConfig.maxRegexLength}). Simplify the pattern or increase maxRegexLength in config.`,
              isError: true
            };
          }

          // Safely compile regex
          let regex: RegExp;
          try {
            regex = new RegExp(pattern);
          } catch (regexError: any) {
            return {
              met: false,
              reason: `Invalid regex pattern "${pattern}": ${regexError.message}. Check syntax at https://regex101.com (JavaScript flavor).`,
              isError: true
            };
          }

          conditionMet = regex.test(currentUrl);
        } else {
          conditionMet = currentUrl === value;
        }
        break;
      }

      case 'cookie': {
        const result = await executeToolCall('storage', {
          action: 'getCookies',
          connectionReason
        });
        // Names from `_meta`: grepping the rendered JSON matched another
        // cookie's VALUE, and the `name=wanted` form matched any cookie whose
        // name merely ENDS with it.
        conditionMet = (result?._meta?.storage?.cookieNames ?? []).includes(value);
        break;
      }

      case 'localStorage': {
        const result = await executeToolCall('storage', {
          action: 'getLocalStorage',
          key: value,
          connectionReason
        });
        // Presence from `_meta`. The old text test read the whole rendered
        // response, so a key whose VALUE was "null" - or contained "not found",
        // or any OTHER key's value did - reported the key as missing, and a
        // `{{localStorage:...}}` guard skipped work it should have done. An
        // empty string is a stored value and counts as present.
        conditionMet = result?._meta?.storage?.found === true;
        break;
      }

      case 'indexedDB': {
        // DB/STORE/KEY, where the key may itself contain slashes. Two segments
        // ask "does this store hold anything at all".
        const segments = value.split('/');
        const [db, store, ...rest] = segments;
        const key = rest.join('/');
        if (!db || !store) {
          return {
            met: false,
            reason: `Invalid indexedDB condition "${value}". Expected {{indexedDB:DB/STORE/KEY}} or {{indexedDB:DB/STORE}}.`,
            isError: true
          };
        }
        // A key segment that interpolated to nothing must NOT quietly become the
        // store form ("is anything in here"), which answers a different question
        // and would flip a setup decision with no signal.
        if (rest.length > 0 && !key) {
          return {
            met: false,
            reason: `Invalid indexedDB condition "${value}": the key is empty.`
              + ` Use {{indexedDB:${db}/${store}}} to ask whether the store holds anything,`
              + ` or check the {{var:...}} that produced the key.`,
            isError: true
          };
        }

        // A database or store that doesn't exist yet is the record being
        // ABSENT, not a broken condition: that is the state a fresh profile is
        // in, and the state a setup sequence exists to heal. It arrives as a
        // thrown ToolError, like any other tool failure.
        const probe = async (probeKey?: string | number) => {
          try {
            const res: any = probeKey !== undefined
              ? await executeToolCall('storage', { action: 'idbGet', db, store, key: probeKey, connectionReason })
              : await executeToolCall('storage', { action: 'idbGetAll', db, store, limit: 1, connectionReason });
            return { res };
          } catch (idbError: any) {
            return { failure: idbError?.message || String(idbError) };
          }
        };

        const isAbsence = (failure: string) =>
          /does not exist|not found in database|no object store/i.test(failure);

        /**
         * Presence comes from the tool's structured `_meta`, never from its
         * rendered text: a record whose VALUE contains "No record found for
         * this key." (or "**Count:** 0") read as absent when this grepped the
         * markdown.
         */
        const presentIn = (res: any): boolean => {
          const meta = res?._meta?.storage;
          return key ? meta?.found === true : (meta?.count ?? 0) > 0;
        };

        let attempt = await probe(key || undefined);
        if (attempt.failure) {
          if (isAbsence(attempt.failure)) { conditionMet = false; break; }
          return {
            met: false,
            reason: `Error evaluating indexedDB condition "${value}": ${attempt.failure}`,
            isError: true
          };
        }

        conditionMet = presentIn(attempt.res);

        // A condition is written as text, so a numerically-keyed store ("42")
        // would never match its own record - IndexedDB keys 42 and "42" are
        // different keys. Retry as a number before concluding absence.
        if (!conditionMet && key && /^-?\d+(\.\d+)?$/.test(key)) {
          const numeric = await probe(Number(key));
          if (!numeric.failure && presentIn(numeric.res)) {
            await debugLog(logPrefix, `indexedDB key "${key}" matched as a number, not a string`);
            conditionMet = true;
          }
        }
        break;
      }

      default:
        return {
          met: false,
          reason: `Unknown condition type: "${type}". Supported types: ${CONDITION_TYPES.join(', ')}`,
          isError: true
        };
    }

    // Apply negation
    const finalResult = isNegated ? !conditionMet : conditionMet;
    await debugLog(logPrefix, `Condition ${condition} = ${finalResult}`);

    if (finalResult) {
      return { met: true };
    } else {
      return { met: false };
    }
  } catch (error: any) {
    // Tool execution errors are real errors, not just "condition not met"
    return {
      met: false,
      reason: `Error evaluating ${type} condition: ${error.message}`,
      isError: true
    };
  }
}
