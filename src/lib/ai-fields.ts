import { z } from "zod";

import type { FieldPlacement } from "./schemas/field.ts";
import { clampNormalizedFieldRect } from "./utils/pdf-coords.ts";

// Suggests signer fields for a draft by sending its PDF to Claude. The
// suggestions come back to the sender's editor as ordinary unsaved fields;
// nothing here saves or sends anything. Never log the PDF, the model's
// answer or the key: errors thrown from here carry only fixed messages.

export const AI_FIELDS_MODEL = "claude-sonnet-5-5";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const REQUEST_TIMEOUT_MS = 110_000;
// Claude reads PDFs of up to 600 pages in one request.
export const MAX_AI_FIELDS_PAGES = 600;
const MAX_SUGGESTIONS = 300;
const MIN_FIELD_SIZE = 0.01;

export const aiFieldTypes = [
  "signature",
  "initials",
  "date",
  "name",
  "text",
  "checkbox",
] as const;

type AiFieldType = (typeof aiFieldTypes)[number];

export type AiFieldSigner = { id: string; name: string; order: number };

export type AiFieldSuggestion = Omit<
  FieldPlacement,
  "envelopeId" | "groupId" | "id" | "options"
>;

export class AiFieldsError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = "AiFieldsError";
    this.statusCode = statusCode;
  }
}

// Positions are asked for in percent of the page from its top-left corner,
// which maps straight onto the editor's 0-1 top-left coordinates.
const outputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "page", "signer", "x", "y", "width", "height"],
        properties: {
          type: { type: "string", enum: [...aiFieldTypes] },
          page: { type: "integer", description: "1-based page number" },
          signer: {
            type: "integer",
            description: "Number of the signer from the list (1-based)",
          },
          x: { type: "number", description: "Left edge, % of page width" },
          y: { type: "number", description: "Top edge, % of page height" },
          width: { type: "number", description: "% of page width" },
          height: { type: "number", description: "% of page height" },
          label: {
            type: "string",
            description: "Short label for text fields, such as Company",
          },
        },
      },
    },
  },
} as const;

function buildPrompt(signers: readonly AiFieldSigner[], pageCount: number) {
  const signerLines = signers
    .map((signer, index) => `${String(index + 1)}. ${signer.name}`)
    .join("\n");

  return `This PDF (${String(pageCount)} pages) is being prepared for electronic signature. Find every place a signer must sign, initial, date, print their name, fill in text or tick a box, and return one field for each.

Signers, in signing order:
${signerLines}

Field types: "signature" for signature lines, "initials" for initial boxes, "date" for the date signed, "name" for a printed full name, "text" for other blanks to fill in, "checkbox" for boxes to tick.

For each field give the page, the signer's number from the list (match the role or name printed near the line, such as Tenant, Buyer or Client; use 1 when unclear), and a box in percent of the page measured from the top-left corner that sits on the line or blank where the entry goes. Only include places meant for these signers to fill in, not text already filled in. Return an empty list if there are none.`;
}

/** Calls Claude with the PDF and returns its JSON answer, unvalidated. */
export async function requestFieldSuggestions(input: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  pageCount: number;
  pdf: Uint8Array;
  signers: readonly AiFieldSigner[];
}): Promise<unknown> {
  const { apiKey, fetchImpl = fetch, pageCount, pdf, signers } = input;
  let response: Response;

  try {
    response = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
      body: JSON.stringify({
        model: AI_FIELDS_MODEL,
        max_tokens: 16000,
        // A safety decline is retried on Anthropic's recommended model.
        fallbacks: "default",
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema: outputSchema },
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: Buffer.from(pdf).toString("base64"),
                },
              },
              { type: "text", text: buildPrompt(signers, pageCount) },
            ],
          },
        ],
      }),
      headers: {
        "anthropic-beta": "server-side-fallback-2026-07-01",
        "anthropic-version": "2026-10-21",
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new AiFieldsError("Could not reach the AI service. Try again.", 502);
  }

  if (!response.ok) {
    throw new AiFieldsError(
      response.status === 429 || response.status === 529
        ? "The AI service is busy. Try again in a minute."
        : response.status === 401 || response.status === 403
          ? "The AI service rejected the API key. An admin must check ANTHROPIC_API_KEY."
          : "The AI service could not read this document.",
      502,
    );
  }

  const message = (await response.json().catch(() => null)) as {
    content?: Array<{ text?: string; type?: string }>;
    stop_reason?: string;
  } | null;

  if (message?.stop_reason === "refusal") {
    throw new AiFieldsError("The AI service declined this document.", 422);
  }

  const text = message?.content?.find((block) => block.type === "text")?.text;

  if (message?.stop_reason === "max_tokens" || !text) {
    throw new AiFieldsError(
      "The AI service returned no usable answer. Try again.",
      502,
    );
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parse error quotes the text, so it is not passed on.
    throw new AiFieldsError(
      "The AI service returned no usable answer. Try again.",
      502,
    );
  }
}

const percentSchema = z.number().finite();
const suggestionSchema = z.object({
  height: percentSchema,
  label: z.string().optional(),
  page: z.number().int(),
  signer: z.number().int().optional(),
  type: z.string(),
  width: percentSchema,
  x: percentSchema,
  y: percentSchema,
});

/** Maps a box in percent of the page onto the editor's 0-1 coordinates. */
export function percentRectToNormalized(rect: {
  height: number;
  width: number;
  x: number;
  y: number;
}) {
  return clampNormalizedFieldRect({
    height: Math.max(rect.height / 100, MIN_FIELD_SIZE),
    width: Math.max(rect.width / 100, MIN_FIELD_SIZE),
    x: rect.x / 100,
    y: rect.y / 100,
  });
}

/**
 * Turns Claude's answer into editor fields. Anything malformed, of another
 * type or on a page the document does not have is dropped; boxes are clamped
 * into the page; an unknown signer number goes to the first signer.
 */
export function parseFieldSuggestions(
  output: unknown,
  context: { pageCount: number; signers: readonly AiFieldSigner[] },
): AiFieldSuggestion[] {
  const signers = context.signers
    .slice()
    .sort((left, right) => left.order - right.order);
  const firstSigner = signers[0];
  const items =
    output && typeof output === "object" && "fields" in output
      ? (output as { fields: unknown }).fields
      : null;

  if (!firstSigner || !Array.isArray(items)) {
    return [];
  }

  const suggestions: AiFieldSuggestion[] = [];

  for (const item of items.slice(0, MAX_SUGGESTIONS)) {
    const parsed = suggestionSchema.safeParse(item);

    if (
      !parsed.success ||
      !(aiFieldTypes as readonly string[]).includes(parsed.data.type) ||
      parsed.data.page < 1 ||
      parsed.data.page > context.pageCount
    ) {
      continue;
    }

    const field = parsed.data;
    const type = field.type as AiFieldType;
    const signer =
      (field.signer !== undefined ? signers[field.signer - 1] : undefined) ??
      firstSigner;
    const label =
      type === "text"
        ? field.label?.trim().slice(0, 120) || undefined
        : undefined;

    suggestions.push({
      ...percentRectToNormalized(field),
      label,
      page: field.page,
      // Matches the editor: text and checkboxes start optional.
      required: type !== "text" && type !== "checkbox",
      signerId: signer.id,
      type,
    });
  }

  return suggestions;
}
