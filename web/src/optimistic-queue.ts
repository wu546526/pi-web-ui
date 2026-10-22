/**
 * 前端排队/插队消息（steer / followUp）乐观更新与快照对账纯函数。
 *
 * 解决问题：
 * 用户在流式运行期间按 Enter（插队 steer）或点排队（followUp）时，ChatInput 会立即清空输入框。
 * 若等待服务端完整走完 WS 往返 + 附件/视觉桥处理 + 快照下发，期间会出现：
 *   1. 输入框已空、下方排队气泡尚未出现的「消息凭空消失」真空期；
 *   2. 发送瞬间恰逢服务端上一帧在途 `snapshot_delta` 到达，若直接覆盖 `state.queue`，
 *      刚出现的气泡会闪退消失，等下一帧快照才再出现；
 *   3. 点 ✕ / ↩（`queue_remove`）撤回气泡时，若等服务端回包才移除或被在途旧快照覆盖，气泡会迟滞或闪烁。
 *
 * 设计：
 * - 发送流式 `prompt` 时：立即用与服务端同构的 `formatStreamingPrompt` 生成乐观项并追加到 `state.queue`；
 * - 发送 `queue_remove` 时：立即从 `state.queue` 移除对应项；
 * - 发送空闲态 `prompt` 时：立即在消息列表尾部本地回显用户气泡（echo- 前缀 id，
 *   recordOptimisticPromptEcho），快照对账落账（reconcileOptimisticPromptEchoes）、
 *   TTL 超时或通知回滚三方消解，消除空闲发送到服务端回包之间的「消息凭空消失」真空期；
 * - 收到服务端 `snapshot` / `snapshot_delta` 时：通过基线计数（baselineMatches）精确判定服务端是否已落账，
 *   未落账前保持乐观态不闪烁，落账后无缝交接给服务端权威队列，绝不产生重复气泡。
 */

import type { PromptAttachment, UiContentBlock, UiMessage, UiState } from "./types";
import { removeQueuedByIndexOrText } from "../../server/queue-utils.js";
import { formatStreamingPrompt, readTextQuote, splitQuotedPrompt } from "../../server/text-quote.js";

/** 乐观入队项最长保活时间（毫秒）：覆盖大图视觉桥转述等慢速前置阶段，超时自动释放。 */
export const OPTIMISTIC_ADD_TTL_MS = 15_000;
/** 乐观移除项最长保活时间（毫秒）：仅用于抵消在途旧 snapshot_delta 的闪回。 */
export const OPTIMISTIC_REMOVE_TTL_MS = 3_000;
/** 空闲态回显气泡最长保活时间（毫秒）：覆盖大会话快照序列化与慢附件前置，超时自动移除。 */
export const OPTIMISTIC_ECHO_TTL_MS = 15_000;
/** 本地回显气泡的消息 id 前缀：真实服务端消息 id（u-/a-/t-）永不以此开头。 */
export const OPTIMISTIC_ECHO_ID_PREFIX = "echo-";

/** 本地回显气泡消息 id（echo-<seq>），与真实服务端消息 id 空间隔离，永不碰撞。 */
export function makeEchoMessageId(seq: number): string {
	return `${OPTIMISTIC_ECHO_ID_PREFIX}${seq}`;
}

export function isEchoMessageId(id: string | undefined): boolean {
	return typeof id === "string" && id.startsWith(OPTIMISTIC_ECHO_ID_PREFIX);
}

export interface PendingQueueAdd {
	conversationId: string;
	kind: "steer" | "followUp";
	rawText: string;
	formattedText: string;
	/** 发送时刻服务端队列中已存在的同内容项数量（支持连续发送两条相同文字如“继续”）。 */
	baselineQueueMatches: number;
	/** 发送时刻已落盘消息中同内容用户消息数量（若入队后瞬间出队落盘，据此即时消解乐观项）。 */
	baselineUserMsgMatches: number;
	createdAt: number;
}

export interface PendingQueueRemove {
	conversationId: string;
	kind: "steer" | "followUp";
	text: string;
	index?: number;
	/** 移除后本地期望剩余的同内容项数量；服务端队列仍大于此值说明在途快照早于移除动作。 */
	expectedRemainingMatches: number;
	createdAt: number;
}

/** 空闲态发送的本地回显气泡（服务端确认前暂存，确认后自动移除跟踪）。 */
export interface PendingPromptEcho {
	conversationId: string;
	/** 规范化后的用户正文（trim 后），与服务端落盘消息的首个 text block 全等比较。
	 *  服务端把附件/图片拆成独立 custom 消息，正文不含侧牌标记，回显气泡同构。 */
	rawText: string;
	/** 本地气泡消息 id（echo- 前缀，与真实服务端 id 空间隔离）。 */
	messageId: string;
	/** 发送时刻已落盘消息中同内容用户消息数量（不含回显气泡）。 */
	baselineUserMsgMatches: number;
	createdAt: number;
}

export interface OptimisticQueueTracker {
	adds: PendingQueueAdd[];
	removes: PendingQueueRemove[];
	/** 空闲态 prompt 的本地回显气泡（echo- 前缀 id），见 recordOptimisticPromptEcho。 */
	echoes: PendingPromptEcho[];
}

export function createOptimisticQueueTracker(): OptimisticQueueTracker {
	return { adds: [], removes: [], echoes: [] };
}

function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 将前端 `PromptAttachment[]` 格式化为与服务端 `formatStreamingPrompt` 同构的排队文本，
 * 使 `<QueuedMessage>` 的 `splitQuotedPrompt` 能立即渲染出文本、引用卡片与附件芯片。
 */
export function formatOptimisticQueuedPrompt(text: string, attachments?: readonly PromptAttachment[]): string {
	const quotes = (attachments ?? [])
		.filter((a) => a.mode === "quote")
		.map((a) => readTextQuote(a.quote))
		.filter((q) => q !== null);
	const imageNames: string[] = [];
	const textAsides: string[] = [];

	for (const att of attachments ?? []) {
		if (att.mode === "quote") continue;
		if (att.imageData) {
			imageNames.push(att.name || "image.png");
			continue;
		}
		if (att.fileData) {
			const name = att.name || "file";
			textAsides.push(`<file path="${escapeXmlAttr(name)}" />`);
			continue;
		}
		if (att.mode === "page") {
			const url = att.path || "";
			const title = att.name || url;
			textAsides.push(`<browser-page url="${escapeXmlAttr(url)}" title="${escapeXmlAttr(title)}"></browser-page>`);
			continue;
		}
		if (att.mode === "conversation") {
			const title = att.name || att.conversationId || att.sessionPath || "conversation";
			textAsides.push(`<conversation-ref title="${escapeXmlAttr(title)}"></conversation-ref>`);
			continue;
		}
		if (att.path) {
			const linesAttr = att.lines ? ` lines="${att.lines.start}-${att.lines.end}"` : "";
			textAsides.push(`<file path="${escapeXmlAttr(att.path)}"${linesAttr} />`);
		}
	}

	return formatStreamingPrompt(text, textAsides, quotes, imageNames);
}

/** 提取排队文本的规范化比较签名（正文 + 引用数 + 附件名集合），兼容服务端视觉桥重写图片为 <vision-bridge>。 */
export function normalizeQueuedPromptKey(value: string): string {
	const parsed = splitQuotedPrompt(value);
	const body = parsed.text.trim();
	const quoteSig = parsed.quotes.map((q) => `${q.role}:${q.messageId}:${q.text.trim()}`).join("|");
	return `${body}\u0000${quoteSig}`;
}

export function isSameQueuedPrompt(a: string, b: string): boolean {
	if (a === b) return true;
	return normalizeQueuedPromptKey(a) === normalizeQueuedPromptKey(b);
}

export function countMatchingInQueue(list: readonly string[], target: string): number {
	let count = 0;
	for (const item of list) {
		if (isSameQueuedPrompt(item, target)) count += 1;
	}
	return count;
}

export function countMatchingUserMessages(messages: readonly UiMessage[], rawText: string): number {
	const norm = rawText.trim();
	let count = 0;
	for (const msg of messages) {
		if (msg.role !== "user") continue;
		// 本地回显气泡不算服务端落账：基线与确认计数都必须只统计真实落盘消息
		if (isEchoMessageId(msg.id)) continue;
		const textBlock = msg.content.find((b) => b.type === "text") as { type: "text"; text: string } | undefined;
		const msgText = (textBlock?.text ?? "").trim();
		if (msgText === norm) count += 1;
	}
	return count;
}

/**
 * 判断一条流式期间发出的 `prompt` 是否应当进入前端本地乐观队列。
 * 排除：非流式态、空消息、斜杠命令、审查者自动委派模式（直接转给执行会话，不在本会话排队）、
 * 目标审查回合中的 steer（由服务端顺延到 deferredPrompts 并弹 toast，不进 SDK queue）。
 */
export function shouldOptimisticallyQueuePrompt(opts: {
	state: UiState | null;
	text: string;
	attachments?: readonly PromptAttachment[];
	queue?: boolean;
	goalReviewing?: boolean;
}): boolean {
	const { state, text, attachments, queue = false, goalReviewing = false } = opts;
	if (!state || !state.isStreaming) return false;
	if (state.delegateMode === true) return false;
	const trimmed = (text ?? "").trim();
	const hasAttach = Boolean(attachments && attachments.length > 0);
	if (!trimmed && !hasAttach) return false;
	if (trimmed.startsWith("/")) return false;
	if (goalReviewing && !queue) return false;
	return true;
}

/**
 * 判断一条空闲态（非流式）发出的 `prompt` 是否应当立即本地回显气泡。
 * 排除：流式态（走 shouldOptimisticallyQueuePrompt 的排队/插队路径）、空消息、
 * 斜杠命令（结果可能直接是本地 notice，不产生用户消息）、审查者自动委派模式。
 */
export function shouldOptimisticallyEchoPrompt(opts: {
	state: UiState | null;
	text: string;
	attachments?: readonly PromptAttachment[];
}): boolean {
	const { state, text, attachments } = opts;
	if (!state || state.isStreaming) return false;
	if (state.delegateMode === true) return false;
	const trimmed = (text ?? "").trim();
	const hasAttach = Boolean(attachments && attachments.length > 0);
	if (!trimmed && !hasAttach) return false;
	if (trimmed.startsWith("/")) return false;
	return true;
}

/**
 * 空闲态发送 `prompt` 时记录本地回显气泡，并返回追加了气泡的 `UiState`。
 * 消解三路：快照对账落账（reconcileOptimisticPromptEchoes）/ TTL 超时 / 通知回滚
 * （rollbackUnconfirmedOptimisticAdds）。
 */
export function recordOptimisticPromptEcho(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		text: string;
		attachments?: readonly PromptAttachment[];
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	const now = opts.now ?? Date.now();
	if (!state || !shouldOptimisticallyEchoPrompt({ state, text: opts.text, attachments: opts.attachments })) {
		return { tracker, state };
	}

	const rawText = (opts.text ?? "").trim();
	const seq = nextEchoSeq(tracker);
	const entry: PendingPromptEcho = {
		conversationId: state.conversationId,
		rawText,
		messageId: makeEchoId(seq),
		baselineUserMsgMatches: countMatchingUserMessages(state.messages, rawText),
		createdAt: now,
	};
	const echoMessage = buildEchoMessage(entry, now);

	return {
		tracker: { ...tracker, echoes: [...echoesOf(tracker), entry] },
		state: { ...state, messages: [...state.messages, echoMessage] },
	};
}

function echoesOf(tracker: OptimisticQueueTracker): PendingPromptEcho[] {
	// 兼容旧结构 tracker（可能缺 echoes 字段，如旧单测/持久化状态）
	return tracker.echoes ?? [];
}

function nextEchoSeq(tracker: OptimisticQueueTracker): number {
	let max = 0;
	for (const e of echoesOf(tracker)) {
		const n = Number.parseInt(e.messageId.slice(OPTIMISTIC_ECHO_ID_PREFIX.length), 10);
		if (Number.isFinite(n) && n > max) max = n;
	}
	return max + 1;
}

function makeEchoId(seq: number): string {
	return makeEchoMessageId(seq);
}

/** 构建与服务端落盘用户消息同构的本地回显气泡（纯正文文本；附件/图片由服务端拆成独立
 *  custom 消息，落账后随快照自然出现为附件卡片，回显阶段不预渲染，避免标记泄漏）。 */
function buildEchoMessage(entry: PendingPromptEcho, createdAt: number): UiMessage {
	const content: UiContentBlock[] = [];
	if (entry.rawText) content.push({ type: "text", text: entry.rawText });
	return {
		id: entry.messageId,
		role: "user",
		content,
		timestamp: createdAt,
	};
}

/**
 * 发送流式 `prompt` 时记录乐观入队项，并返回乐观更新后的 `UiState`。
 */
export function recordOptimisticQueueAdd(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		text: string;
		attachments?: readonly PromptAttachment[];
		queue?: boolean;
		engine?: string;
		goalReviewing?: boolean;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	const now = opts.now ?? Date.now();
	if (
		!shouldOptimisticallyQueuePrompt({
			state,
			text: opts.text,
			attachments: opts.attachments,
			queue: opts.queue,
			goalReviewing: opts.goalReviewing,
		}) ||
		!state
	) {
		return { tracker, state };
	}

	const steerSupported = state?.engineCapabilities?.steer !== false && opts.engine !== "dsh";
	const kind: "steer" | "followUp" = opts.queue || !steerSupported ? "followUp" : "steer";
	const formattedText = formatOptimisticQueuedPrompt(opts.text, opts.attachments);
	const rawText = splitQuotedPrompt(formattedText).text.trim();
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;

	// 当前显示列表中已包含的匹配数作为基线（扣除尚未被服务端确认的同内容乐观项，得到服务端真实基线）
	const unconfirmedSameCount = tracker.adds.filter(
		(a) =>
			a.conversationId === state.conversationId &&
			a.kind === kind &&
			isSameQueuedPrompt(a.formattedText, formattedText),
	).length;
	const currentTotalMatches = countMatchingInQueue(currentList, formattedText);
	const baselineQueueMatches = Math.max(0, currentTotalMatches - unconfirmedSameCount);
	const baselineUserMsgMatches = countMatchingUserMessages(state.messages, rawText);

	const addEntry: PendingQueueAdd = {
		conversationId: state.conversationId,
		kind,
		rawText,
		formattedText,
		baselineQueueMatches,
		baselineUserMsgMatches,
		createdAt: now,
	};

	const nextQueue =
		kind === "steer"
			? { ...state.queue, steering: [...state.queue.steering, formattedText] }
			: { ...state.queue, followUp: [...state.queue.followUp, formattedText] };

	return {
		tracker: {
			adds: [...tracker.adds, addEntry],
			removes: tracker.removes,
			echoes: echoesOf(tracker),
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

/**
 * 发送 `queue_remove`（点 ✕ 或 ↩ 撤回）时立即从前端 `state.queue` 移除，并记录短期防闪回标记。
 */
export function recordOptimisticQueueRemove(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
	opts: {
		kind: "steer" | "followUp";
		text: string;
		index?: number;
		now?: number;
	},
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state) return { tracker, state };
	const now = opts.now ?? Date.now();
	const { kind, text, index } = opts;
	const currentList = kind === "steer" ? state.queue.steering : state.queue.followUp;
	const nextList = removeQueuedByIndexOrText(currentList, text, index);

	// 若此次移除恰好抵消了一条尚未落账的乐观新增项，直接消掉该新增项
	let nextAdds = tracker.adds;
	const pendingAddIdx = nextAdds.findIndex(
		(a) => a.conversationId === state.conversationId && a.kind === kind && isSameQueuedPrompt(a.formattedText, text),
	);
	if (pendingAddIdx >= 0) {
		nextAdds = [...nextAdds.slice(0, pendingAddIdx), ...nextAdds.slice(pendingAddIdx + 1)];
	}

	const expectedRemainingMatches = countMatchingInQueue(nextList, text);
	const removeEntry: PendingQueueRemove = {
		conversationId: state.conversationId,
		kind,
		text,
		index,
		expectedRemainingMatches,
		createdAt: now,
	};

	const nextQueue = kind === "steer" ? { ...state.queue, steering: nextList } : { ...state.queue, followUp: nextList };

	return {
		tracker: {
			adds: nextAdds,
			removes: [...tracker.removes, removeEntry],
			echoes: echoesOf(tracker),
		},
		state: {
			...state,
			queue: nextQueue,
		},
	};
}

/**
 * 收到服务端权威 `snapshot` 或合并后的 `snapshot_delta` 时，与本地乐观队列对账：
 * 1. 流式已结束（`!isStreaming`）：清空当前会话所有乐观项，直接使用服务端队列；
 * 2. 先应用尚未被服务端确认的 `removes`（抑制在途旧快照把刚删掉的气泡闪回）；
 * 3. 再检查 `adds`：若服务端 `queue` 或 `messages` 的匹配数已超越发送时基线，说明服务端已确认，
 *    自动移除乐观项；否则保留并追加到 `state.queue` 末尾，确保前置阶段气泡稳定不消失。
 */
export function reconcileOptimisticQueue(
	tracker: OptimisticQueueTracker,
	incomingState: UiState,
	now = Date.now(),
): { tracker: OptimisticQueueTracker; state: UiState } {
	if (tracker.adds.length === 0 && tracker.removes.length === 0) {
		return { tracker, state: incomingState };
	}

	const convId = incomingState.conversationId;
	if (!incomingState.isStreaming) {
		const keptAdds = tracker.adds.filter(
			(a) => a.conversationId !== convId && now - a.createdAt < OPTIMISTIC_ADD_TTL_MS,
		);
		const keptRemoves = tracker.removes.filter(
			(r) => r.conversationId !== convId && now - r.createdAt < OPTIMISTIC_REMOVE_TTL_MS,
		);
		if (keptAdds.length === tracker.adds.length && keptRemoves.length === tracker.removes.length) {
			return { tracker, state: incomingState };
		}
		return {
			tracker: { ...tracker, adds: keptAdds, removes: keptRemoves },
			state: incomingState,
		};
	}

	let steering = [...incomingState.queue.steering];
	let followUp = [...incomingState.queue.followUp];
	let queueMutated = false;

	// 1. 对账 removes
	const nextRemoves: PendingQueueRemove[] = [];
	for (const rem of tracker.removes) {
		if (now - rem.createdAt >= OPTIMISTIC_REMOVE_TTL_MS) continue;
		if (rem.conversationId !== convId) {
			nextRemoves.push(rem);
			continue;
		}
		const targetList = rem.kind === "steer" ? steering : followUp;
		const serverMatches = countMatchingInQueue(targetList, rem.text);
		if (serverMatches > rem.expectedRemainingMatches) {
			// 服务端快照仍带这条已被用户删除的项（在途旧快照）→ 本地继续过滤掉它
			let stripped = removeQueuedByIndexOrText(targetList, rem.text, rem.index);
			if (stripped.length === targetList.length) {
				const fallbackIdx = targetList.findIndex((item) => isSameQueuedPrompt(item, rem.text));
				if (fallbackIdx >= 0) {
					stripped = [...targetList.slice(0, fallbackIdx), ...targetList.slice(fallbackIdx + 1)];
				}
			}
			if (rem.kind === "steer") steering = stripped;
			else followUp = stripped;
			queueMutated = true;
			nextRemoves.push(rem);
		}
		// 若 serverMatches <= rem.expectedRemainingMatches，说明服务端已确认删除，直接丢弃该 remove 追踪项
	}

	// 2. 对账 adds（同内容多条乐观项按顺序逐条核销）
	const nextAdds: PendingQueueAdd[] = [];
	// 记录已经被前序乐观项“认领”的额外服务端匹配数，支持连续多条同文乐观项逐一落账
	const claimedServerExtras = new Map<string, number>();

	for (const add of tracker.adds) {
		if (now - add.createdAt >= OPTIMISTIC_ADD_TTL_MS) continue;
		if (add.conversationId !== convId) {
			nextAdds.push(add);
			continue;
		}
		const targetList = add.kind === "steer" ? steering : followUp;
		const key = `${add.kind}:${normalizeQueuedPromptKey(add.formattedText)}`;
		const claimed = claimedServerExtras.get(key) ?? 0;

		const serverQueueMatches = countMatchingInQueue(targetList, add.formattedText);
		const serverUserMsgMatches = countMatchingUserMessages(incomingState.messages, add.rawText);

		const confirmedInQueue = serverQueueMatches > add.baselineQueueMatches + claimed;
		const confirmedInMessages = serverUserMsgMatches > add.baselineUserMsgMatches;

		if (confirmedInQueue) {
			claimedServerExtras.set(key, claimed + 1);
			continue;
		}
		if (confirmedInMessages) {
			continue;
		}

		// 服务端尚未落账（在途旧快照或服务端仍在处理附件/视觉桥）→ 保持乐观气泡在列尾
		if (add.kind === "steer") {
			steering.push(add.formattedText);
		} else {
			followUp.push(add.formattedText);
		}
		claimedServerExtras.set(key, claimed + 1);
		queueMutated = true;
		nextAdds.push(add);
	}

	const nextTracker =
		nextAdds.length === tracker.adds.length && nextRemoves.length === tracker.removes.length
			? tracker
			: { ...tracker, adds: nextAdds, removes: nextRemoves };

	if (!queueMutated) {
		return { tracker: nextTracker, state: incomingState };
	}

	return {
		tracker: nextTracker,
		state: {
			...incomingState,
			queue: { steering, followUp },
		},
	};
}

/**
 * 当服务端返回 error / warning 级别通知（如流式期间消息被拒绝、会话已中止等）时，
 * 立即撤销当前会话尚未被服务端确认的乐观入队项，防止被拒消息在界面上残留。
 */
export function rollbackUnconfirmedOptimisticAdds(
	tracker: OptimisticQueueTracker,
	state: UiState | null,
): { tracker: OptimisticQueueTracker; state: UiState | null } {
	if (!state) return { tracker, state };
	const convId = state.conversationId;
	const toRollback = tracker.adds.filter((a) => a.conversationId === convId);
	const echoesToRollback = echoesOf(tracker).filter((e) => e.conversationId === convId);
	if (toRollback.length === 0 && echoesToRollback.length === 0) return { tracker, state };

	let steering = [...state.queue.steering];
	let followUp = [...state.queue.followUp];
	for (const item of toRollback) {
		if (item.kind === "steer") {
			steering = removeQueuedByIndexOrText(steering, item.formattedText);
		} else {
			followUp = removeQueuedByIndexOrText(followUp, item.formattedText);
		}
	}

	const echoIds = new Set(echoesToRollback.map((e) => e.messageId));
	const nextMessages = echoIds.size > 0 ? state.messages.filter((m) => !echoIds.has(m.id)) : state.messages;

	return {
		tracker: {
			adds: tracker.adds.filter((a) => a.conversationId !== convId),
			removes: tracker.removes,
			echoes: echoesOf(tracker).filter((e) => e.conversationId !== convId),
		},
		state: {
			...state,
			queue: { steering, followUp },
			messages: nextMessages,
		},
	};
}

/**
 * 收到服务端权威 `snapshot` / 合并后的 `snapshot_delta` 时，与本地空闲态回显气泡对账：
 * - 快照里已出现同正文用户消息（计数超越发送时基线）→ 服务端已落账，移除回显气泡；
 * - 服务端尚未落账且未超 TTL → 保留回显气泡（追加到快照消息列表尾部）；
 * - 超过 TTL → 移除回显气泡并放弃跟踪（真实消息随下一帧快照自然出现）。
 */
export function reconcileOptimisticPromptEchoes(
	tracker: OptimisticQueueTracker,
	incomingState: UiState,
	now = Date.now(),
): { tracker: OptimisticQueueTracker; state: UiState } {
	if (echoesOf(tracker).length === 0) return { tracker, state: incomingState };
	if (incomingState.isStreaming) {
		// 流式已启动：服务端快照为权威态。本会话的回显气泡要么已被真实消息取代
		// （全量快照整体覆盖），要么仍混在增量合并列表里（delta append）—— 统一
		// 剥离本会话 echo- 气泡，避免幽灵残留；真实消息由快照自身携带。
		const staleIds = new Set<string>();
		const kept: PendingPromptEcho[] = [];
		for (const e of echoesOf(tracker)) {
			if (e.conversationId === incomingState.conversationId) staleIds.add(e.messageId);
			else kept.push(e);
		}
		const nextTracker = kept.length === echoesOf(tracker).length ? tracker : { ...tracker, echoes: kept };
		if (staleIds.size === 0) return { tracker: nextTracker, state: incomingState };
		return {
			tracker: nextTracker,
			state: { ...incomingState, messages: incomingState.messages.filter((m) => !staleIds.has(m.id)) },
		};
	}

	const convId = incomingState.conversationId;
	const keptEchoes: PendingPromptEcho[] = [];
	const staleEchoIds = new Set<string>();
	const appendEchoes: UiMessage[] = [];

	for (const echo of echoesOf(tracker)) {
		if (echo.conversationId !== convId || now - echo.createdAt >= OPTIMISTIC_ECHO_TTL_MS) {
			// 过期或非本会话：过期项的气泡要移除（不在本帧追加），跨会话项继续跟踪
			if (echo.conversationId === convId) staleEchoIds.add(echo.messageId);
			if (echo.conversationId === convId) continue;
			keptEchoes.push(echo);
			continue;
		}
		const serverMatches = countMatchingUserMessages(incomingState.messages, echo.rawText);
		if (serverMatches > echo.baselineUserMsgMatches) {
			// 服务端已落账 → 移除本地气泡，跟踪终止
			staleEchoIds.add(echo.messageId);
			continue;
		}
		// 未落账 → 保留跟踪；若本地气泡已在列表中（delta 合并场景）原位保留，否则追加到列表尾。
		// 不查重直接追加会导致 delta 帧上出现重复气泡。
		keptEchoes.push(echo);
		if (!incomingState.messages.some((m) => m.id === echo.messageId)) {
			appendEchoes.push(buildEchoMessage(echo, echo.createdAt));
		}
	}

	const nextTracker =
		keptEchoes.length === echoesOf(tracker).length
			? tracker
			: { adds: tracker.adds, removes: tracker.removes, echoes: keptEchoes };
	if (staleEchoIds.size === 0 && appendEchoes.length === 0) {
		return { tracker: nextTracker, state: incomingState };
	}

	const messages = staleEchoIds.size > 0 ? incomingState.messages.filter((m) => !staleEchoIds.has(m.id)) : [...incomingState.messages];
	const nextState: UiState = {
		...incomingState,
		messages: appendEchoes.length > 0 ? [...messages, ...appendEchoes] : messages,
	};
	return { tracker: nextTracker, state: nextState };
}
