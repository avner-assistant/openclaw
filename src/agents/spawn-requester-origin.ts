/**
 * Spawn requester origin resolver.
 *
 * Normalizes delivery targets and route bindings so spawned runs can attribute the requesting account/channel.
 */
import type { ChatType } from "../channels/chat-type.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveFirstBoundAccountId } from "../routing/bound-account-read.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

// Delivery targets often carry a transport wrapper (e.g. Matrix `room:<id>` or
// LINE `line:group:<id>`), while route bindings commonly store raw peer ids on
// `match.peer.id`. Peel wrappers for those lookups, and separately pass the
// original target as an exact-match alias for channels whose canonical peer ids
// intentionally include prefixes such as `channel:` or `thread:`.
const KIND_PREFIX_TO_CHAT_TYPE: Readonly<Record<string, ChatType>> = {
  "room:": "channel",
  "channel:": "channel",
  "conversation:": "channel",
  "chat:": "channel",
  "thread:": "channel",
  "topic:": "channel",
  "group:": "group",
  "team:": "group",
  "user:": "direct",
  "dm:": "direct",
  "pm:": "direct",
};

// Matches one leading `<alpha-token>:` wrapper at a time.
const GENERIC_PREFIX_PATTERN = /^[a-z][a-z0-9_-]*:/i;

function getKindForRequesterPrefix(prefix: string): ChatType | undefined {
  return Object.hasOwn(KIND_PREFIX_TO_CHAT_TYPE, prefix)
    ? KIND_PREFIX_TO_CHAT_TYPE[prefix]
    : undefined;
}

function normalizeChannelPrefix(channelId: string | undefined): string | undefined {
  const normalized = channelId?.trim().toLowerCase();
  return normalized ? `${normalized}:` : undefined;
}

function shouldPeelRequesterPrefix(prefix: string, channelPrefix: string | undefined): boolean {
  return Boolean(getKindForRequesterPrefix(prefix) || prefix === channelPrefix);
}

function inferPeerKindFromBareId(value: string): ChatType | undefined {
  if (value.startsWith("@")) {
    return "direct";
  }
  if (value.startsWith("!") || value.startsWith("#")) {
    return "channel";
  }
  return undefined;
}

function extractRequesterPeer(
  channelId: string | undefined,
  requesterTo: string | undefined,
): { peerId?: string; peerKind?: ChatType } {
  if (!requesterTo) {
    return {};
  }
  const raw = requesterTo.trim();
  if (!raw) {
    return {};
  }
  const channelPrefix = normalizeChannelPrefix(channelId);
  let inferredKind: ChatType | undefined;
  let allowBareIdKindOverride = false;
  let value = raw;
  while (true) {
    const match = GENERIC_PREFIX_PATTERN.exec(value);
    if (!match) {
      break;
    }
    const prefix = match[0].toLowerCase();
    if (!shouldPeelRequesterPrefix(prefix, channelPrefix)) {
      break;
    }
    const kindFromPrefix = getKindForRequesterPrefix(prefix);
    if (kindFromPrefix) {
      inferredKind ??= kindFromPrefix;
    }
    allowBareIdKindOverride ||= prefix === channelPrefix || prefix === "room:";
    value = value.slice(prefix.length).trim();
  }
  const bareIdKind = value ? inferPeerKindFromBareId(value) : undefined;
  if (bareIdKind && (!inferredKind || allowBareIdKindOverride)) {
    // Id-embedded kind markers (Matrix `!`/`@`, IRC `#`) are more specific
    // than transport wrapper text such as Matrix `room:@user`, which is a
    // direct peer. Explicit kind prefixes like `channel:` still win.
    inferredKind = bareIdKind;
  }
  return { peerId: value || undefined, peerKind: inferredKind };
}

function readRequesterSessionOrigin(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  requestThreadBinding: boolean;
  requesterSessionKey?: string;
}): DeliveryContext | undefined {
  // Single gate for the whole recovery. Callers always know their requester
  // session key, so only the spawn's binding intent may unlock it; otherwise an
  // unbound run adopts a delivery route its own turn never had.
  if (!params.requestThreadBinding) {
    return undefined;
  }
  const sessionKey = params.requesterSessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  return deliveryContextFromSession(
    loadSessionEntry({
      sessionKey,
      storePath: resolveStorePath(params.cfg.session?.store, { agentId: params.requesterAgentId }),
      clone: false,
    }),
  );
}

export function resolveRequesterOriginForChild(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterAgentId: string;
  requesterChannel?: string;
  requesterAccountId?: string;
  requesterTo?: string;
  requesterThreadId?: string | number;
  /** Requester session whose recorded delivery context can be recovered from. */
  requesterSessionKey?: string;
  /**
   * Whether this spawn asks for a thread binding. Required so every caller
   * states the intent explicitly: only a binding spawn may recover a
   * conversation the turn itself does not carry.
   */
  requestThreadBinding: boolean;
  requesterGroupSpace?: string | null;
  requesterMemberRoleIds?: string[];
}) {
  const turnOrigin = normalizeDeliveryContext({
    channel: params.requesterChannel,
    accountId: params.requesterAccountId,
    to: params.requesterTo,
    threadId: params.requesterThreadId,
  });
  // Turns that are not driven by an inbound channel message (heartbeat, cron,
  // steer, agent-to-agent) carry a channel but no target. Thread-bound spawns
  // must still name a conversation to bind to, so recover the route from the
  // requester session. A turn that already has a target owns the route: never
  // let session state add a stale `to`/`threadId` on top of it.
  const requesterOrigin =
    turnOrigin?.channel && !turnOrigin.to
      ? mergeDeliveryContext(
          turnOrigin,
          readRequesterSessionOrigin({
            cfg: params.cfg,
            requesterAgentId: params.requesterAgentId,
            requestThreadBinding: params.requestThreadBinding,
            requesterSessionKey: params.requesterSessionKey,
          }),
        )
      : turnOrigin;
  const { peerId: normalizedPeerId, peerKind: inferredPeerKind } = extractRequesterPeer(
    params.requesterChannel,
    requesterOrigin?.to,
  );
  const rawPeerIdAlias = requesterOrigin?.to?.trim();
  // Same-agent spawns must keep the caller's active inbound account, not
  // re-resolve via bindings that may select a different account for the same
  // agent/channel.
  const boundAccountId =
    params.requesterChannel && params.targetAgentId !== params.requesterAgentId
      ? resolveFirstBoundAccountId({
          cfg: params.cfg,
          channelId: params.requesterChannel,
          agentId: params.targetAgentId,
          peerId: normalizedPeerId,
          exactPeerIdAliases:
            rawPeerIdAlias && rawPeerIdAlias !== normalizedPeerId ? [rawPeerIdAlias] : undefined,
          peerKind: inferredPeerKind,
          groupSpace: params.requesterGroupSpace,
          memberRoleIds: params.requesterMemberRoleIds,
        })
      : undefined;
  return normalizeDeliveryContext({
    ...requesterOrigin,
    channel: params.requesterChannel,
    accountId: boundAccountId ?? requesterOrigin?.accountId,
  });
}
