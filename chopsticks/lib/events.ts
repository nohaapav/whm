import * as c from "console";

import { type HydrationQueries } from "@galacticcouncil/descriptors";

import { toJson } from "./utils";

export type EventRecord = HydrationQueries["System"]["Events"]["Value"][number];

type EvmLog = Extract<
  Extract<EventRecord["event"], { type: "EVM" }>["value"],
  { type: "Log" }
>["value"]["log"];

type Pallet = EventRecord["event"]["type"];

export function findEvent(events: EventRecord[], pallet: Pallet, method: string): unknown {
  return events.find((e) => e.event.type === pallet && e.event.value.type === method)?.event.value
    .value;
}

/** Every `EVM.Log` with the given `topic0`, narrowed to one emitting contract when given. */
export function findEvmLogs(events: EventRecord[], topic0: string, address?: string): EvmLog[] {
  const logs: EvmLog[] = [];
  for (const { event } of events) {
    if (event.type !== "EVM" || event.value.type !== "Log") continue;
    const { log } = event.value.value;
    if (log.topics[0] !== topic0) continue;
    if (address && String(log.address).toLowerCase() !== address.toLowerCase()) continue;
    logs.push(log);
  }
  return logs;
}

export function checkIfExtrinsicSuccess(events: EventRecord[]): boolean {
  return events.some(
    ({ event }) => event.type === "System" && event.value.type === "ExtrinsicSuccess",
  );
}

export function checkIfEthereumExecuted(events: EventRecord[], reason = "Succeed"): boolean {
  return events.some(
    ({ event }) =>
      event.type === "Ethereum" &&
      event.value.type === "Executed" &&
      event.value.value.exit_reason.type === reason,
  );
}

/** True iff an `EVM.Log` with the given `topic0` (event signature hash) was emitted. */
export function checkIfEvmLog(events: EventRecord[], topic0: string): boolean {
  return events.some(
    ({ event }) =>
      event.type === "EVM" &&
      event.value.type === "Log" &&
      event.value.value.log.topics[0] === topic0,
  );
}

export function checkIfXcmSent(events: EventRecord[]): boolean {
  return events.some(({ event }) => event.type === "PolkadotXcm" && event.value.type === "Sent");
}

export function checkIfQueueProcessed(events: EventRecord[]): boolean {
  return events.some(
    ({ event }) =>
      event.type === "MessageQueue" &&
      event.value.type === "Processed" &&
      event.value.value.success === true,
  );
}

/** True iff any queued XCM message failed: `MessageQueue.Processed{success:false}` or `ProcessingFailed`. */
export function checkIfQueueFailed(events: EventRecord[]): boolean {
  return events.some(
    ({ event }) =>
      event.type === "MessageQueue" &&
      ((event.value.type === "Processed" && event.value.value.success === false) ||
        event.value.type === "ProcessingFailed"),
  );
}

/** True iff the XCM executor raised an error (`PolkadotXcm.ProcessXcmError`, e.g. FailedToTransactAsset). */
export function checkIfXcmError(events: EventRecord[]): boolean {
  return events.some(
    ({ event }) => event.type === "PolkadotXcm" && event.value.type === "ProcessXcmError",
  );
}

export function logEvents(events: EventRecord[]) {
  for (const { event } of events) {
    c.log("🥢 Event:", toJson(event, 0));
  }
}
