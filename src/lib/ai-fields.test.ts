import assert from "node:assert/strict";
import test from "node:test";

import {
  AiFieldsError,
  parseFieldSuggestions,
  percentRectToNormalized,
  requestFieldSuggestions,
} from "./ai-fields.ts";
import { fieldPlacementListSchema } from "./schemas/field.ts";

const signers = [
  { id: "signer-b", name: "Landlord", order: 2 },
  { id: "signer-a", name: "Tenant", order: 1 },
];
const context = { pageCount: 2, signers };

test("a box in percent from the top-left becomes the editor's 0-1 box", () => {
  assert.deepEqual(
    percentRectToNormalized({ height: 5, width: 30, x: 10, y: 80 }),
    { height: 0.05, width: 0.3, x: 0.1, y: 0.8 },
  );
});

test("a box past the page edge is clamped inside it", () => {
  const rect = percentRectToNormalized({
    height: 20,
    width: 50,
    x: 90,
    y: -5,
  });

  assert.equal(rect.x + rect.width <= 1, true);
  assert.equal(rect.y, 0);
  assert.equal(rect.width, 0.5);
});

test("signers are matched by signing order, unknown ones go to the first", () => {
  const fields = parseFieldSuggestions(
    {
      fields: [
        {
          height: 4,
          page: 1,
          signer: 2,
          type: "signature",
          width: 30,
          x: 10,
          y: 80,
        },
        {
          height: 4,
          page: 1,
          signer: 9,
          type: "date",
          width: 15,
          x: 50,
          y: 80,
        },
        { height: 4, page: 2, type: "initials", width: 8, x: 85, y: 90 },
      ],
    },
    context,
  );

  assert.deepEqual(
    fields.map((field) => field.signerId),
    ["signer-b", "signer-a", "signer-a"],
  );
});

test("unknown types, bad pages and malformed items are dropped", () => {
  const fields = parseFieldSuggestions(
    {
      fields: [
        {
          height: 4,
          page: 1,
          signer: 1,
          type: "dropdown",
          width: 30,
          x: 10,
          y: 10,
        },
        {
          height: 4,
          page: 3,
          signer: 1,
          type: "signature",
          width: 30,
          x: 10,
          y: 10,
        },
        {
          height: 4,
          page: 0,
          signer: 1,
          type: "name",
          width: 30,
          x: 10,
          y: 10,
        },
        { page: 1, type: "text" },
        "nonsense",
        {
          height: 4,
          page: 1,
          signer: 1,
          type: "checkbox",
          width: 3,
          x: 10,
          y: 10,
        },
      ],
    },
    context,
  );

  assert.deepEqual(
    fields.map((field) => field.type),
    ["checkbox"],
  );
  assert.deepEqual(parseFieldSuggestions(null, context), []);
  assert.deepEqual(parseFieldSuggestions({ fields: "x" }, context), []);
  assert.deepEqual(
    parseFieldSuggestions({ fields: [] }, { pageCount: 1, signers: [] }),
    [],
  );
});

test("parsed suggestions pass the editor's own field validation", () => {
  const fields = parseFieldSuggestions(
    {
      fields: [
        {
          height: 4,
          page: 1,
          signer: 1,
          type: "signature",
          width: 130,
          x: 50,
          y: 99,
        },
        {
          height: 4,
          label: " Company ",
          page: 2,
          signer: 2,
          type: "text",
          width: 30,
          x: 10,
          y: 10,
        },
        {
          height: 4,
          label: "ignored",
          page: 2,
          signer: 2,
          type: "name",
          width: 30,
          x: 10,
          y: 20,
        },
      ],
    },
    context,
  );

  assert.equal(fields[1]?.label, "Company");
  assert.equal(fields[1]?.required, false);
  assert.equal(fields[2]?.label, undefined);
  assert.equal(fields[0]?.required, true);
  assert.equal(fieldPlacementListSchema.safeParse(fields).success, true);
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const callInput = {
  apiKey: "test-key",
  pageCount: 1,
  pdf: new Uint8Array([37, 80, 68, 70]),
  signers,
};

test("the request sends the PDF as a document with the key in a header", async () => {
  let sent: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
  } | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent = {
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    };
    return new Response(
      JSON.stringify({
        content: [{ text: '{"fields":[]}', type: "text" }],
        stop_reason: "end_turn",
      }),
    );
  }) as unknown as typeof fetch;

  assert.deepEqual(await requestFieldSuggestions({ ...callInput, fetchImpl }), {
    fields: [],
  });
  assert.ok(sent);
  const { body, headers } = sent as {
    body: Record<string, unknown>;
    headers: Record<string, string>;
  };
  assert.equal(body.model, "claude-sonnet-5-5");
  assert.equal(headers["x-api-key"], "test-key");
  assert.match(JSON.stringify(body.messages), /"type":"document"/);
});

test("API failures, refusals and bad JSON become fixed messages", async () => {
  await assert.rejects(
    requestFieldSuggestions({ ...callInput, fetchImpl: fakeFetch(500, {}) }),
    AiFieldsError,
  );
  await assert.rejects(
    requestFieldSuggestions({
      ...callInput,
      fetchImpl: fakeFetch(200, { content: [], stop_reason: "refusal" }),
    }),
    { message: "The AI service declined this document.", statusCode: 422 },
  );
  await assert.rejects(
    requestFieldSuggestions({
      ...callInput,
      fetchImpl: fakeFetch(200, {
        content: [{ text: "secret contract text {", type: "text" }],
        stop_reason: "end_turn",
      }),
    }),
    (error: Error) => !error.message.includes("secret"),
  );
});
