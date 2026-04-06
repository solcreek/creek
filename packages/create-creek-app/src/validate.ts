import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, useDefaults: true });

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export interface ValidationError {
  path: string;
  message: string;
}

/**
 * Validate data against a JSON Schema from creek-template.json.
 * Returns { valid, errors }.
 */
export function validateData(
  schema: Record<string, unknown>,
  data: Record<string, unknown>,
): ValidationResult {
  // Strip $schema meta field — ajv doesn't support 2020-12 meta-schema by default
  const { $schema: _, ...schemaWithoutMeta } = schema;
  const validate = ajv.compile(schemaWithoutMeta);
  const valid = validate(data);

  if (valid) {
    return { valid: true, errors: [] };
  }

  const errors: ValidationError[] = (validate.errors ?? []).map((err) => ({
    path: err.instancePath || "/",
    message: err.message ?? "unknown error",
  }));

  return { valid: false, errors };
}
