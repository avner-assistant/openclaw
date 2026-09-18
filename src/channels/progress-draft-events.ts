import {
  buildChannelProgressDraftLineForEntry,
  type ChannelProgressDraftLine,
  type ChannelProgressDraftLineInput,
  type ChannelProgressLineOptions,
  type StreamingCompatEntry,
} from "./streaming.js";

type ProgressPayload<TEvent extends ChannelProgressDraftLineInput["event"]> = Omit<
  Extract<ChannelProgressDraftLineInput, { event: TEvent }>,
  "event"
>;

type ToolProgressPayload = ProgressPayload<"tool"> & { detailMode?: "explain" | "raw" };
type ItemProgressPayload = Omit<ProgressPayload<"item">, "itemKind"> & { kind?: string };
type ChannelProgressDraftEventLine = string | ChannelProgressDraftLine;
export type ChannelProgressDraftEventLineBuilder = (
  input: ChannelProgressDraftLineInput,
  options?: ChannelProgressLineOptions,
) => ChannelProgressDraftEventLine | undefined;

export function createChannelProgressDraftEventHandlers(params: {
  entry: StreamingCompatEntry | null | undefined;
  buildLine?: ChannelProgressDraftEventLineBuilder;
  onTool?: (payload: ToolProgressPayload) => void;
  onItem?: (payload: ItemProgressPayload) => void;
  pushLine: (
    line: ChannelProgressDraftEventLine | undefined,
    options?: { toolName?: string; startImmediately?: boolean },
  ) => Promise<boolean>;
}) {
  const pushEvent = (
    input: Extract<ChannelProgressDraftLineInput, { event: "item" | "approval" }>,
  ) =>
    params.pushLine(
      params.buildLine
        ? params.buildLine(input)
        : buildChannelProgressDraftLineForEntry(params.entry, input),
    );

  return {
    pushToolEvent: (payload: ToolProgressPayload) => {
      params.onTool?.(payload);
      return Promise.resolve(false);
    },
    pushItemEvent: (payload: ItemProgressPayload) => {
      const { kind: itemKind, ...input } = payload;
      params.onItem?.(payload);
      if (payload.hideFromChannelProgress || payload.suppressChannelProgress) {
        return Promise.resolve(false);
      }
      return pushEvent({ event: "item", ...input, itemKind });
    },
    pushApprovalEvent: (payload: ProgressPayload<"approval">) => {
      return payload.phase === "requested"
        ? pushEvent({ event: "approval", ...payload })
        : Promise.resolve(false);
    },
    pushCommandOutputEvent: (payload: ProgressPayload<"command-output">) => {
      void payload;
      return Promise.resolve(false);
    },
    pushPatchEvent: (payload: ProgressPayload<"patch">) => {
      void payload;
      return Promise.resolve(false);
    },
  };
}
