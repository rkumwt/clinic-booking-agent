import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Annotation, BaseCheckpointSaver, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import type { ClinicBackend } from './backend';
import { GuardContext, checkReply, checkToolCalls } from './guard';
import { progressOf, toolFacts } from './progress';
import { randomUUID } from 'crypto';
import { nextCertainCall } from './autopilot';
import { Turn, readSignals } from './signals';
import { bookingConfirmed, changeOutcome, scriptedReply } from './templates';
import { Flow, HANDOFF_MESSAGE, INTENTS, Intent, faqPrompt, flowPrompt, routerPrompt } from './prompts';
import { createClinicTools } from './tools';

export interface ClinicAgentOptions {
  llm: BaseChatModel;
  backend: ClinicBackend;
  checkpointer: BaseCheckpointSaver;
  timezone: string;
  /** Injected so tests can pin "today". */
  now?: () => Date;
}

export const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  intent: Annotation<Intent | undefined>({ reducer: (_prev, next) => next, default: () => undefined }),
});
export type AgentStateType = typeof AgentState.State;

// The current facts live in the system prompt, so a short window is enough.
const HISTORY_LIMIT = 14;

/** Recent history for the model. A window must not open on an orphaned tool result. */
function recent(messages: BaseMessage[]): BaseMessage[] {
  const window = messages.slice(-HISTORY_LIMIT);
  while (window.length && window[0] instanceof ToolMessage) window.shift();
  return window;
}

function textOf(message: BaseMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((part) => ('text' in part ? String(part.text) : '')).join('');
}

function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return textOf(messages[i]);
  }
  return '';
}

export function parseIntent(raw: string, fallback: Intent): Intent {
  const text = raw.toLowerCase();
  // Earliest match wins, so "booking" beats a later stray "faq" in a chatty reply.
  let best: { intent: Intent; index: number } | undefined;
  for (const intent of INTENTS) {
    const index = text.indexOf(intent);
    if (index !== -1 && (!best || index < best.index)) best = { intent, index };
  }
  return best?.intent ?? fallback;
}

const KEYWORD_INTENTS: Array<[RegExp, Intent]> = [
  [
    /\b(human|real person|someone at the clinic|receptionist|speak to (a |the )?(person|staff)|emergency|chest pain|can'?t breathe|bleeding)\b/i,
    'handoff',
  ],
  [/\b(reschedul\w*|postpone|prepone|(move|change|shift) (my|the) (appointment|booking))\b/i, 'reschedule'],
  [/\b(cancel (my|the|this) (appointment|booking)|cancel it|want to cancel|refund)\b/i, 'cancel'],
  [/\b(payment link|pay (for|now|online)|make (a |the )?payment)\b/i, 'payment'],
  [
    /\b(book|schedule) (an? |my )?(appointment|slot|visit)\b|\b(appointment|consultation) with\b|\b(need|want|see|looking for) (to see )?(a |an )?[a-z]* ?(doctor|specialist)\b/i,
    'booking',
  ],
];

/** Routes on unmistakable wording. Returns undefined when the message is ambiguous. */
export function keywordIntent(text: string): Intent | undefined {
  return KEYWORD_INTENTS.find(([pattern]) => pattern.test(text))?.[1];
}

export function createClinicAgent(options: ClinicAgentOptions) {
  const { llm, backend, timezone } = options;
  const now = options.now ?? (() => new Date());
  const tools = createClinicTools(backend);

  if (!llm.bindTools) throw new Error('The chat model must support tool calling');
  const bind = (list: Parameters<NonNullable<BaseChatModel['bindTools']>>[0]) => llm.bindTools!(list);

  // Each flow sees only the tools it needs. A cancel conversation cannot
  // accidentally create a booking, and fewer tools means fewer wrong calls.
  const flowModels: Record<Flow, ReturnType<typeof bind>> = {
    booking: bind([
      tools.searchDoctors,
      tools.getAvailableSlots,
      tools.holdSlot,
      tools.confirmBooking,
      tools.transferToHuman,
    ]),
    reschedule: bind([
      tools.getBookingStatus,
      tools.getAvailableSlots,
      tools.holdSlot,
      tools.rescheduleBooking,
      tools.transferToHuman,
    ]),
    cancel: bind([tools.getBookingStatus, tools.cancelBooking, tools.transferToHuman]),
    payment: bind([tools.getBookingStatus, tools.createPaymentLink, tools.transferToHuman]),
  };

  async function intentRouter(state: AgentStateType, config: RunnableConfig) {
    const latest = lastHumanText(state.messages);

    // 1. Unmistakable wording decides without a model call.
    const explicit = keywordIntent(latest);
    if (explicit) return { intent: explicit };

    // 2. In the middle of a flow, an answer ("tomorrow", "Asha Verma", "yes")
    //    belongs to that flow. Only a question is worth re-classifying.
    const inFlow = state.intent && state.intent !== 'faq' && state.intent !== 'handoff';
    if (inFlow && !latest.includes('?')) return { intent: state.intent };

    // 3. Otherwise ask the model.
    const transcript = state.messages
      .filter((m) => m instanceof HumanMessage || (m instanceof AIMessage && textOf(m)))
      .slice(-4)
      .map((m) => `${m instanceof HumanMessage ? 'Patient' : 'Assistant'}: ${textOf(m)}`)
      .join('\n');
    const reply = await llm.invoke([new HumanMessage(routerPrompt(state.intent, transcript))], config);
    return { intent: parseIntent(textOf(reply), state.intent ?? 'faq') };
  }

  async function faqNode(state: AgentStateType, config: RunnableConfig) {
    const hits = await backend.searchFaq(lastHumanText(state.messages)).catch(() => []);
    const reply = await llm.invoke([new SystemMessage(faqPrompt(hits)), ...recent(state.messages)], config);
    return { messages: [reply] };
  }

  const flowNode = (flow: Flow) => async (state: AgentStateType, config: RunnableConfig) => {
    // Rebuilt from tool results on every pass, never from the model's memory.
    const facts = toolFacts(state.messages);
    const progress = progressOf(facts);
    const patientMessages = state.messages.filter((m) => m instanceof HumanMessage).map(textOf);
    const turns: Turn[] = state.messages
      .filter((m) => m instanceof HumanMessage || (m instanceof AIMessage && textOf(m).trim()))
      .map((m) => ({ role: m instanceof HumanMessage ? 'patient' : 'assistant', text: textOf(m) }));
    const signals = readSignals(turns, now(), timezone);
    const ctx: GuardContext = { flow, facts, progress, signals, patientText: patientMessages.join(' ; ') };

    // The outcome of a booking, cancellation or reschedule is announced by a
    // template, not the model: it is the one message that must be exactly right.
    const last = state.messages[state.messages.length - 1];
    if (last instanceof ToolMessage) {
      const latest = facts[facts.length - 1];
      if (latest?.name === 'confirmBooking' && progress.booking) {
        return { messages: [new AIMessage(bookingConfirmed(progress.booking))] };
      }
      if ((latest?.name === 'cancelBooking' || latest?.name === 'rescheduleBooking') && progress.change) {
        return { messages: [new AIMessage(changeOutcome(progress.change))] };
      }
    }

    // Fast path: if only one tool call makes sense, make it without the model.
    // Skipped right after a failed tool call, so the model can explain the
    // error instead of the same call being retried in a loop.
    const lastToolFailed =
      last instanceof ToolMessage && !/^\s*\{(?![^]*"error")/.test(String(last.content));
    const certain = lastToolFailed ? undefined : nextCertainCall(flow, progress, signals);
    if (certain && checkToolCalls([certain], ctx).length === 0) {
      return {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ ...certain, id: `auto_${randomUUID()}`, type: 'tool_call' }],
          }),
        ],
      };
    }

    const system = new SystemMessage(
      flowPrompt(flow, progress, now(), timezone, lastHumanText(state.messages), signals),
    );
    const history = recent(state.messages);

    const problemsWith = (message: AIMessage) =>
      message.tool_calls?.length ? checkToolCalls(message.tool_calls, ctx) : checkReply(textOf(message), ctx);
    const describe = (message: AIMessage) =>
      message.tool_calls?.length
        ? `You tried to call ${message.tool_calls.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}.`
        : `You wrote: "${textOf(message).slice(0, 300)}"`;

    let reply = await flowModels[flow].invoke([system, ...history], config);
    let problems = problemsWith(reply);

    if (problems.length) {
      // One chance to fix it, told exactly what was wrong. The rejected
      // attempt never enters the conversation history.
      const correction = new HumanMessage(
        `[Automatic check] ${describe(reply)}\nThat was blocked because:\n- ${problems.join('\n- ')}\nNow do YOUR NEXT STEP from the instructions correctly.`,
      );
      reply = await flowModels[flow].invoke([system, ...history, correction], config);
      problems = problemsWith(reply);
    }
    // Still wrong: fall back to a scripted message built only from tool results.
    if (problems.length) return { messages: [new AIMessage(scriptedReply(flow, progress, signals))] };
    if (reply.tool_calls?.length) return { messages: [reply] };

    // Chat UIs show plain text; small models add markdown whatever they are told.
    reply.content = textOf(reply).replace(/\*\*/g, '').trim() || scriptedReply(flow, progress, signals);
    return { messages: [reply] };
  };

  async function humanHandoff(state: AgentStateType, config: RunnableConfig) {
    await backend
      .transferToHuman(
        { reason: lastHumanText(state.messages).slice(0, 300) },
        { threadId: String(config.configurable?.thread_id), channel: config.configurable?.channel ?? 'CHAT' },
      )
      .catch(() => undefined);
    return { messages: [new AIMessage(HANDOFF_MESSAGE)] };
  }

  const nodeFor = {
    faq: 'faqNode',
    booking: 'bookingFlow',
    reschedule: 'rescheduleFlow',
    cancel: 'cancelFlow',
    payment: 'paymentFlow',
    handoff: 'humanHandoff',
  } as const satisfies Record<Intent, string>;
  const flowNodes = ['bookingFlow', 'rescheduleFlow', 'cancelFlow', 'paymentFlow'] as const;

  const flowNodeFor = (intent: Intent | undefined) =>
    intent === 'reschedule'
      ? 'rescheduleFlow'
      : intent === 'cancel'
        ? 'cancelFlow'
        : intent === 'payment'
          ? 'paymentFlow'
          : 'bookingFlow';

  /** After a flow node: run the tools it asked for, or stop and wait for the patient. */
  const afterFlow = (state: AgentStateType) => {
    const last = state.messages[state.messages.length - 1];
    return last instanceof AIMessage && last.tool_calls?.length ? 'tools' : END;
  };

  const graph = new StateGraph(AgentState)
    .addNode('intentRouter', intentRouter)
    .addNode('faqNode', faqNode)
    .addNode('bookingFlow', flowNode('booking'))
    .addNode('rescheduleFlow', flowNode('reschedule'))
    .addNode('cancelFlow', flowNode('cancel'))
    .addNode('paymentFlow', flowNode('payment'))
    .addNode('humanHandoff', humanHandoff)
    .addNode('tools', new ToolNode(Object.values(tools)))
    .addEdge(START, 'intentRouter')
    .addConditionalEdges('intentRouter', (state) => nodeFor[state.intent ?? 'faq'], Object.values(nodeFor))
    .addEdge('faqNode', END)
    .addEdge('humanHandoff', END)
    // Tool results go back to whichever flow asked for them.
    .addConditionalEdges('tools', (state) => flowNodeFor(state.intent), [...flowNodes]);

  for (const node of flowNodes) graph.addConditionalEdges(node, afterFlow, ['tools', END]);

  return graph.compile({ checkpointer: options.checkpointer });
}

export type ClinicAgent = ReturnType<typeof createClinicAgent>;
