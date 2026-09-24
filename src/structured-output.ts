import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";
import type { AnyAgentTool, OutputFormat } from "./types.js";

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = new WeakMap<object, ValidateFunction>();

export type StructuredOutputParseResult =
  | { success: true; value: unknown }
  | { success: false; detail: string };

function validationDetail(errors: ErrorObject[] | null | undefined): string {
  if (!errors?.length) return "The final response did not match the requested JSON Schema.";
  return `The final response did not match the requested JSON Schema: ${ajv.errorsText(errors, { separator: "; " })}`;
}

export function validateStructuredValue(value: unknown, outputFormat: OutputFormat): StructuredOutputParseResult {
  let validate = validators.get(outputFormat.schema);
  try {
    if (!validate) {
      validate = ajv.compile(outputFormat.schema);
      validators.set(outputFormat.schema, validate);
    }
  } catch (error) {
    return { success: false, detail: `The requested output schema could not be compiled: ${error instanceof Error ? error.message : String(error)}` };
  }
  return validate(value)
    ? { success: true, value }
    : { success: false, detail: validationDetail(validate.errors) };
}

export function createStructuredOutputTool(
  format: OutputFormat,
  onResult: (result: StructuredOutputParseResult, toolCallId: string) => void,
): AnyAgentTool {
  return {
    name: "StructuredOutput",
    label: "StructuredOutput",
    description: "Submit the final schema-validated result.",
    parameters: format.schema,
    async execute(id, args) {
      const checked = validateStructuredValue(args, format);
      onResult(checked, id);
      return checked.success
        ? { content: [{ type: "text", text: "Structured output accepted." }] }
        : { isError: true, content: [{ type: "text", text: checked.detail }] };
    },
  };
}

export function parseStructuredOutput(
  text: string,
  outputFormat: OutputFormat,
): StructuredOutputParseResult {
  if (text.trim().length === 0) {
    return { success: false, detail: "The final assistant response did not contain structured output." };
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    return {
      success: false,
      detail: `The final assistant response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateStructuredValue(value, outputFormat);
}
