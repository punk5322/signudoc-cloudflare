"use client";

import {
  CalendarIcon,
  CaseSensitiveIcon,
  CircleDotIcon,
  HashIcon,
  SignatureIcon,
  SparklesIcon,
  SquareCheckIcon,
  SquareChevronDownIcon,
  TypeIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type MouseEvent,
  type SetStateAction,
} from "react";

import { type PrepareEnvelopeData } from "@/lib/envelopes";
import {
  describeChoiceFieldProblem,
  findChoiceFieldProblem,
  labelTextToShow,
  MAX_FIELD_OPTIONS,
  MAX_FIELD_OPTION_LENGTH,
  MAX_RADIO_GROUP_BUTTONS,
  optionsTextToShow,
  parseOptionLines,
} from "@/lib/field-choices";
import {
  type FieldPlacement,
  type ReplaceFieldsResponse,
} from "@/lib/schemas/field";
import { CanvasShell } from "@/components/layout/canvas-shell";
import { Button } from "@/components/ui/button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/layout/nav-items";
import {
  beginDocumentPanGesture,
  clampDocumentZoomLevel,
  DEFAULT_DOCUMENT_ZOOM_LEVEL,
  DocumentZoomControls,
  endDocumentPanGesture,
  moveDocumentPanGesture,
  type DocumentPanGesture,
  DOCUMENT_ZOOM_STEP,
} from "@/components/shared/document-viewport";
import { getCachedDraftPdfBlob } from "@/lib/draft-pdf-cache";
import {
  moveFieldRect,
  placeFieldAtViewportPoint,
  resizeFieldRectFromHandle,
  type FieldResizeHandle,
} from "@/lib/utils/pdf-coords";
import { InteractivePlacedField } from "./interactive-placed-field";
import { PdfPageCanvas, type PdfPageRenderState } from "./pdf-page-canvas";
import { getSignerPalette } from "./signer-palette";

type PrepareFieldType = FieldPlacement["type"];

type PrepareLiveShellProps = {
  aiFieldsEnabled?: boolean;
  envelopeId: string;
  initialState?: "error";
  record?: PrepareEnvelopeData;
};

type PrepareField = FieldPlacement & {
  id: string;
};

type LiveFieldSource = Array<{
  groupId?: string;
  height: number;
  id: string;
  label?: string;
  options?: string[];
  page: number;
  required: boolean;
  signerId: string;
  type: PrepareFieldType;
  width: number;
  x: number;
  y: number;
}>;

type PrepareShellSigner = {
  color: string;
  email: string;
  id: string;
  name: string;
  order: number;
  tint: string;
};

type FieldTool = {
  defaultHeight: number;
  defaultWidth: number;
  label: string;
  minHeight: number;
  minWidth: number;
  placeholderLabel: string;
  type: PrepareFieldType;
};

type SignerCardProps = {
  fieldCount: number;
  hasSignatureField: boolean;
  isActive: boolean;
  onSelect: () => void;
  signer: PrepareShellSigner;
};

type FieldToolButtonProps = {
  isActive: boolean;
  onSelect: () => void;
  tool: FieldTool;
};

type FieldEditorProps = {
  field: PrepareField;
  /** How many radio buttons share this field's group, itself included. */
  groupSize: number;
  onAddRadioButton: () => void;
  onDelete: () => void;
  onSetLabel: (label: string | undefined) => void;
  onSetOptions: (options: string[]) => void;
  onSetRequired: (required: boolean) => void;
  onSignerChange: (signerId: string) => void;
  signers: readonly PrepareShellSigner[];
};

type SaveState = "error" | "saved" | "saving";
type PersistFieldsResult = {
  ok: boolean;
  redirectPath: string | null;
};
const fieldTools: readonly FieldTool[] = [
  {
    defaultHeight: 0.07,
    defaultWidth: 0.24,
    label: "Signature",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Sign",
    type: "signature",
  },
  {
    defaultHeight: 0.055,
    defaultWidth: 0.14,
    label: "Initials",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Initials",
    type: "initials",
  },
  {
    defaultHeight: 0.045,
    defaultWidth: 0.12,
    label: "Date",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Date",
    type: "date",
  },
  {
    defaultHeight: 0.045,
    defaultWidth: 0.2,
    label: "Name",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Name",
    type: "name",
  },
  {
    defaultHeight: 0.055,
    defaultWidth: 0.18,
    label: "Text",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Text",
    type: "text",
  },
  {
    defaultHeight: 0.023,
    defaultWidth: 0.03,
    label: "Checkbox",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Checkbox",
    type: "checkbox",
  },
  {
    defaultHeight: 0.045,
    defaultWidth: 0.16,
    label: "Number",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Number",
    type: "number",
  },
  {
    defaultHeight: 0.045,
    defaultWidth: 0.22,
    label: "Dropdown",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Dropdown",
    type: "dropdown",
  },
  {
    defaultHeight: 0.023,
    defaultWidth: 0.03,
    label: "Radio button",
    minHeight: 0.0045,
    minWidth: 0.006,
    placeholderLabel: "Radio button",
    type: "radio",
  },
] as const;

// Fields the sender may leave optional. A signature, initials, the date and
// the name are always needed.
function canBeOptional(type: PrepareFieldType) {
  return (
    type === "text" ||
    type === "checkbox" ||
    type === "number" ||
    type === "dropdown" ||
    type === "radio"
  );
}

/** The fields that change together with this one: its radio group, or itself. */
function isSameChoice(field: PrepareField, other: PrepareField) {
  return (
    field.id === other.id ||
    (field.type === "radio" &&
      other.type === "radio" &&
      field.groupId !== undefined &&
      field.groupId === other.groupId)
  );
}

/** An id for a radio group, or for a button added to one. */
function newLocalId() {
  return typeof window !== "undefined" &&
    "crypto" in window &&
    typeof window.crypto.randomUUID === "function"
    ? window.crypto.randomUUID()
    : `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const genericSubmitError = "Something went wrong. Please try again.";
const autosaveDelayMs = 450;

function buildLiveSigners(
  signers: PrepareEnvelopeData["signers"],
): PrepareShellSigner[] {
  return signers
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((signer, index) => ({
      ...getSignerPalette(index),
      email: signer.email,
      id: signer.id,
      name: signer.name,
      order: signer.order,
    }));
}

function buildLiveFields(
  fields: LiveFieldSource | PrepareEnvelopeData["fields"],
) {
  return fields.map((field, index) => ({
    groupId: field.groupId,
    height: field.height,
    id: field.id ?? `field-${index + 1}`,
    label: field.label,
    options: field.options ? [...field.options] : undefined,
    page: field.page,
    required: field.required,
    signerId: field.signerId,
    type: field.type,
    width: field.width,
    x: field.x,
    y: field.y,
  }));
}

function getFieldTool(type: PrepareFieldType) {
  return fieldTools.find((tool) => tool.type === type) ?? fieldTools[0];
}

function roundNormalized(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isTextEntryTarget(target: EventTarget | null) {
  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  ) {
    return true;
  }

  return target instanceof HTMLElement && target.isContentEditable;
}

function clearSelectedFieldFromViewportClick(
  event: ReactPointerEvent<HTMLElement>,
  armedTool: PrepareFieldType | null,
  setSelectedFieldId: Dispatch<SetStateAction<string | null>>,
) {
  if (armedTool) {
    return;
  }

  const target = event.target;

  if (
    target instanceof HTMLElement &&
    target.closest("[data-placed-field='true']")
  ) {
    return;
  }

  setSelectedFieldId(null);
}

function buildFieldRequest(fields: readonly PrepareField[]) {
  return {
    fields: fields.map((field) => ({
      groupId: field.type === "radio" ? field.groupId : undefined,
      height: roundNormalized(field.height),
      id: field.id,
      label: field.label,
      options: field.type === "dropdown" ? (field.options ?? []) : undefined,
      page: field.page,
      required: field.required,
      signerId: field.signerId,
      type: field.type,
      width: roundNormalized(field.width),
      x: roundNormalized(field.x),
      y: roundNormalized(field.y),
    })),
  };
}

function serializeFieldRequest(fields: readonly PrepareField[]) {
  return JSON.stringify(buildFieldRequest(fields));
}

async function parseJsonResponse<T>(
  response: Response,
): Promise<{ data: T | null; error: string | null }> {
  const payload = (await response.json().catch(() => null)) as
    | { error?: string }
    | T
    | null;

  if (!response.ok) {
    return {
      data: null,
      error:
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : genericSubmitError,
    };
  }

  return {
    data: payload as T | null,
    error: null,
  };
}

export function PrepareLiveShell({
  aiFieldsEnabled = false,
  envelopeId,
  initialState,
  record,
}: PrepareLiveShellProps) {
  if (initialState === "error" || !record) {
    return <PrepareLiveShellError envelopeId={envelopeId} />;
  }

  return (
    <PrepareLiveShellContent
      aiFieldsEnabled={aiFieldsEnabled}
      envelopeId={envelopeId}
      record={record}
    />
  );
}

function PrepareLiveShellError({ envelopeId }: { envelopeId: string }) {
  return (
    <CanvasShell
      backHref={`/envelopes/${envelopeId}/signers`}
      backLabel="Back"
      nextDisabled
      nextLabel="Next →"
      stepLabel="Step 3 of 4"
      title='"Document"'
    >
      <div className="flex min-h-[calc(100vh-73px)] items-center justify-center p-4 sm:p-6 lg:p-8">
        <section className="panel w-full max-w-[520px] p-8 text-center sm:p-10">
          <div className="mx-auto inline-flex size-14 items-center justify-center rounded-2xl bg-(--danger-soft) text-lg font-extrabold text-(--danger)">
            !
          </div>
          <h1 className="mt-5 text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Couldn&apos;t load this document
          </h1>
          <p className="mt-2 text-sm leading-6 text-(--secondary)">
            Something went wrong. Please try again.
          </p>
          <Button
            className="mt-7"
            onClick={() => window.location.reload()}
            type="button"
          >
            Retry
          </Button>
        </section>
      </div>
    </CanvasShell>
  );
}

function PrepareLiveShellContent({
  aiFieldsEnabled,
  envelopeId,
  record,
}: {
  aiFieldsEnabled: boolean;
  envelopeId: string;
  record: PrepareEnvelopeData;
}) {
  const signers = buildLiveSigners(record.signers);
  const initialFields = buildLiveFields(record.fields);
  const [activePage, setActivePage] = useState(1);
  const [selectedSignerId, setSelectedSignerId] = useState(
    signers[0]?.id ?? "",
  );
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [armedTool, setArmedTool] = useState<PrepareFieldType | null>(null);
  const [fields, setFields] = useState<PrepareField[]>(initialFields);
  const [isMobileToolsOpen, setIsMobileToolsOpen] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isContinuing, setIsContinuing] = useState(false);
  const [isPlacingWithAi, setIsPlacingWithAi] = useState(false);
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [isFieldInteracting, setIsFieldInteracting] = useState(false);
  const [isDocumentPanning, setIsDocumentPanning] = useState(false);
  const [pageRenderState, setPageRenderState] =
    useState<PdfPageRenderState>("loading");
  const [zoomLevel, setZoomLevel] = useState(DEFAULT_DOCUMENT_ZOOM_LEVEL);
  const [preferredDocumentUrl, setPreferredDocumentUrl] = useState<
    string | null
  >(null);
  const autosaveTimeoutRef = useRef<number | null>(null);
  const paperGridRef = useRef<HTMLDivElement | null>(null);
  const documentPanGestureRef = useRef<DocumentPanGesture | null>(null);
  const currentFieldsRef = useRef(fields);
  const lastSavedSignatureRef = useRef(serializeFieldRequest(initialFields));
  const fieldCounterRef = useRef(initialFields.length);
  const persistFieldsRef = useRef<
    (nextFields: readonly PrepareField[]) => Promise<PersistFieldsResult>
  >(async () => ({
    ok: false,
    redirectPath: null,
  }));

  currentFieldsRef.current = fields;

  const pageCount = record.pages.length;
  const pageFields = fields.filter((field) => field.page === activePage);
  const activePageRecord =
    record.pages.find((page) => page.pageNumber === activePage) ??
    record.pages[0];
  const selectedField =
    fields.find(
      (field) => field.id === selectedFieldId && field.page === activePage,
    ) ?? null;
  const selectedSigner =
    signers.find((signer) => signer.id === selectedSignerId) ?? signers[0];
  const missingSignatureSigner = signers.find(
    (signer) =>
      !fields.some(
        (field) => field.signerId === signer.id && field.type === "signature",
      ),
  );
  // A dropdown without choices, or a radio button on its own, can be saved
  // in a draft but not sent.
  const choiceProblem = findChoiceFieldProblem(fields);
  const choiceProblemMessage = choiceProblem
    ? describeChoiceFieldProblem(
        choiceProblem,
        signers.find((signer) => signer.id === choiceProblem.signerId)?.name ??
          "a signer",
      )
    : null;
  const canContinue = missingSignatureSigner == null && choiceProblem == null;
  const selectedGroupSize = selectedField
    ? fields.filter((field) => isSameChoice(selectedField, field)).length
    : 0;
  const fieldEditorActions = selectedField
    ? {
        onAddRadioButton: () =>
          addRadioButton(selectedField.id, setFields, setSelectedFieldId),
        onDelete: () =>
          deleteField(selectedField.id, setFields, setSelectedFieldId),
        onSetLabel: (label: string | undefined) =>
          updateField(selectedField.id, { label }, setFields),
        onSetOptions: (options: string[]) =>
          updateField(selectedField.id, { options }, setFields),
        onSetRequired: (required: boolean) =>
          setFieldRequired(selectedField.id, required, setFields),
        onSignerChange: (signerId: string) => {
          setSelectedSignerId(signerId);
          reassignField(selectedField.id, signerId, setFields);
        },
      }
    : null;

  useEffect(() => {
    let isActive = true;
    let localDocumentUrl: string | null = null;

    setPreferredDocumentUrl(null);

    async function resolvePreferredDocumentUrl() {
      try {
        const cachedPdfBlob = await getCachedDraftPdfBlob(envelopeId);

        if (!isActive) {
          return;
        }

        if (cachedPdfBlob) {
          localDocumentUrl = URL.createObjectURL(cachedPdfBlob);
          setPreferredDocumentUrl(localDocumentUrl);
          return;
        }
      } catch (error) {
        console.error("Failed to restore the cached draft PDF preview.", error);
      }

      if (isActive) {
        setPreferredDocumentUrl(record.pdfUrl);
      }
    }

    void resolvePreferredDocumentUrl();

    return () => {
      isActive = false;

      if (localDocumentUrl) {
        URL.revokeObjectURL(localDocumentUrl);
      }
    };
  }, [envelopeId, record.pdfUrl]);

  useEffect(() => {
    return () => {
      if (autosaveTimeoutRef.current) {
        window.clearTimeout(autosaveTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedFieldId) {
      return;
    }

    const fieldId = selectedFieldId;

    function handleDeleteFieldKeydown(event: KeyboardEvent) {
      if (event.defaultPrevented || isFieldInteracting) {
        return;
      }

      if (event.key !== "Backspace" && event.key !== "Delete") {
        return;
      }

      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }

      if (isTextEntryTarget(event.target)) {
        return;
      }

      event.preventDefault();
      deleteField(fieldId, setFields, setSelectedFieldId);
    }

    window.addEventListener("keydown", handleDeleteFieldKeydown);

    return () => {
      window.removeEventListener("keydown", handleDeleteFieldKeydown);
    };
  }, [isFieldInteracting, selectedFieldId]);

  useEffect(() => {
    if (zoomLevel > DEFAULT_DOCUMENT_ZOOM_LEVEL) {
      return;
    }

    setIsDocumentPanning(false);
    documentPanGestureRef.current = null;
  }, [zoomLevel]);

