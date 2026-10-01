/**
 * Zod Validation Helpers
 * Provides utilities for validating tool parameters with Zod schemas
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Result of parameter validation
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; error: any };

function isMissingRequiredIssue(issue: z.ZodIssue): boolean {
  return issue.code === 'invalid_type' && issue.received === 'undefined';
}

/**
 * Unwraps optional/default/nullable wrappers to get at the underlying type
 * for describing enums, etc.
 */
function unwrapZodType(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault
  ) {
    current = current instanceof z.ZodDefault ? current._def.innerType : current.unwrap();
  }
  return current;
}

interface MissingParamInfo {
  name: string;
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Best-effort lookup of a field's Zod definition to describe what's expected.
 * Only handles flat/dotted top-level object fields; falls back to a bare
 * shape if the schema isn't a ZodObject or the path can't be resolved.
 */
function describeMissingField(schema: z.ZodTypeAny, fieldPath: string): MissingParamInfo {
  const info: MissingParamInfo = { name: fieldPath, type: 'unknown' };

  let currentSchema: z.ZodTypeAny | undefined = schema;
  let fieldSchema: z.ZodTypeAny | undefined;

  for (const part of fieldPath.split('.')) {
    if (!(currentSchema instanceof z.ZodObject)) {
      fieldSchema = undefined;
      break;
    }
    fieldSchema = currentSchema.shape[part];
    currentSchema = fieldSchema;
  }

  if (!fieldSchema) return info;

  info.description = (fieldSchema as any)._def?.description;

  if (fieldSchema instanceof z.ZodDefault) {
    try {
      info.default = fieldSchema._def.defaultValue();
    } catch {
      // ignore
    }
  }

  const unwrapped = unwrapZodType(fieldSchema);

  if (unwrapped instanceof z.ZodEnum) {
    info.type = 'enum';
    info.enum = unwrapped.options;
  } else if (unwrapped instanceof z.ZodString) {
    info.type = 'string';
  } else if (unwrapped instanceof z.ZodNumber) {
    info.type = 'number';
  } else if (unwrapped instanceof z.ZodBoolean) {
    info.type = 'boolean';
  } else if (unwrapped instanceof z.ZodArray) {
    info.type = 'array';
  } else if (unwrapped instanceof z.ZodObject) {
    info.type = 'object';
  } else {
    info.type = (unwrapped as any)._def?.typeName || 'unknown';
  }

  return info;
}

/**
 * Validates parameters against a Zod schema
 * Returns validated data or formatted error response
 *
 * A failure's `parameters` lists the fields it names, which the reply turns
 * into a `replay` repeat carrying only those fields.
 */
export function validateParams<T extends z.ZodTypeAny>(
  params: unknown,
  schema: T,
  toolName: string
): ValidationResult<z.infer<T>> {
  const result = schema.safeParse(params);

  if (result.success) return { success: true, data: result.data };

  const missingIssues = result.error.issues.filter(isMissingRequiredIssue);
  const otherIssues = result.error.issues.filter(issue => !isMissingRequiredIssue(issue));
  const parameters: Record<string, string> = {};
  for (const issue of result.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        parameters[key] = renamedTo(toolName, key) ?? 'not a parameter of this tool';
        if (key === 'connectionReason' || key === 'reference') parameters.connection ??= `takes what ${key} held`;
      }
    } else {
      parameters[issue.path.join('.') || 'root'] = isMissingRequiredIssue(issue) ? 'missing' : fieldIssue(issue);
    }
  }

  if (missingIssues.length > 0) {
    const error: Record<string, unknown> = {
      success: false,
      error: `Missing required parameter(s) for tool '${toolName}'`,
      code: otherIssues.length > 0 ? 'INVALID_PARAMS' : 'MISSING_PARAMETERS',
      missingParameters: missingIssues.map(issue => describeMissingField(schema, issue.path.join('.'))),
      parameters,
    };
    if (otherIssues.length > 0) {
      error.validationErrors = formatZodErrors(toolName, result.error, otherIssues);
    }
    return { success: false, error };
  }

  return {
    success: false,
    error: {
      success: false,
      error: `Invalid parameters for tool '${toolName}'`,
      code: 'INVALID_PARAMS',
      validationErrors: formatZodErrors(toolName, result.error),
      parameters,
    }
  };
}

/** Where a field an earlier version took went, for a call still written with it. */
function renamedTo(toolName: string, key: string): string | undefined {
  if (key === 'connectionReason' || key === 'reference') return 'renamed to connection';
  if (toolName === 'connection' && key === 'name') return 'renamed to connection (launch, attach) and newName (rename)';
  return undefined;
}

/** What is wrong with one field's value, without the field's name. */
function fieldIssue(issue: z.ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return `must be ${issue.expected}, got ${issue.received}`;
    case 'invalid_enum_value':
      return `one of ${issue.options.join(', ')}`;
    default:
      return issue.message;
  }
}

/** One line per field a refusal names: what each missing field takes, then each invalid value. */
export function describeRefusal(error: { missingParameters?: MissingParamInfo[]; validationErrors?: string[] }): string {
  const missing = (error.missingParameters ?? []).map(field => {
    const takes = field.enum ? `one of ${field.enum.join(', ')}` : field.type;
    return `- \`${field.name}\` missing (${takes})${field.description ? `: ${field.description}` : ''}`;
  });
  const invalid = (error.validationErrors ?? []).map(line => `- ${line}`);
  return [...missing, ...invalid].join('\n');
}

/**
 * Converts Zod validation errors to user-friendly messages
 */
function formatZodErrors(toolName: string, error: z.ZodError, issues: z.ZodIssue[] = error.issues): string[] {
  return issues.flatMap(issue => {
    const path = issue.path.length > 0 ? issue.path.join('.') : 'root';

    switch (issue.code) {
      case 'invalid_type':
        if (issue.received === 'undefined') {
          return `Missing required parameter: ${path}`;
        }
        return `Parameter '${path}' must be ${issue.expected}, got ${issue.received}`;

      case 'unrecognized_keys':
        return issue.keys.map(key => {
          const renamed = renamedTo(toolName, key);
          return renamed ? `\`${key}\` ${renamed}` : `Unknown parameter: ${key}`;
        });

      case 'too_small':
        if (issue.type === 'string') {
          return `Parameter '${path}' must be at least ${issue.minimum} characters`;
        } else if (issue.type === 'number') {
          return `Parameter '${path}' must be at least ${issue.minimum}`;
        } else if (issue.type === 'array') {
          return `Parameter '${path}' must contain at least ${issue.minimum} items`;
        }
        return `Parameter '${path}' is too small`;

      case 'too_big':
        if (issue.type === 'string') {
          return `Parameter '${path}' must be at most ${issue.maximum} characters`;
        } else if (issue.type === 'number') {
          return `Parameter '${path}' must be at most ${issue.maximum}`;
        } else if (issue.type === 'array') {
          return `Parameter '${path}' must contain at most ${issue.maximum} items`;
        }
        return `Parameter '${path}' is too big`;

      case 'invalid_enum_value':
        return `Parameter '${path}' must be one of: ${issue.options.join(', ')}`;

      case 'invalid_string':
        if (issue.validation === 'email') {
          return `Parameter '${path}' must be a valid email address`;
        } else if (issue.validation === 'url') {
          return `Parameter '${path}' must be a valid URL`;
        } else if (issue.validation === 'regex') {
          return `Parameter '${path}' does not match required pattern`;
        }
        return `Parameter '${path}' is invalid`;

      default:
        return issue.message || `Parameter '${path}' is invalid`;
    }
  });
}

/**
 * Helper to create tool definitions with Zod schemas
 * Automatically generates JSON Schema for MCP ListTools response
 */
export function createTool<T extends z.ZodTypeAny>(
  description: string,
  zodSchema: T,
  handler: (args: z.infer<T>, abortSignal?: AbortSignal) => Promise<any>
) {
  return {
    description,
    zodSchema,
    inputSchema: zodToJsonSchema(zodSchema, {
      $refStrategy: 'none', // Inline all schemas for compatibility
      target: 'jsonSchema7',
      strictUnions: true
    }),
    handler
  };
}
