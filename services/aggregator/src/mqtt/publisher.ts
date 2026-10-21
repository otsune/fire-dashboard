// Legacy store adapter while the Fire API migrates to the standalone service.
import { createMqttPublisher as standalone } from "../../../usage/src/mqtt/publisher";
import type { MqttPublisherOptions } from "../../../usage/src/mqtt/publisher";
import type { Store } from "../store";
export * from "../../../usage/src/mqtt/publisher";
export function createMqttPublisher(store: Store, options: MqttPublisherOptions) {
  return standalone({ inspect: fn => store.inspect(state => fn({
    schemaVersion: 1,
    delivery: { schemaVersion: 1, streamId: state.streamId, revision: state.usageRevision, publishedAt: state.usagePublishedAt ?? new Date().toISOString(), ...state.dashboard.usageDelivery, usage: state.dashboard.usage },
    usageSequences: state.usageSequences, usageValues: state.usageValues, usageObservedAt: state.usageObservedAt,
  })) }, { ...options, topicPrefix: options.topicPrefix ?? "fire-dashboard/v1/main" });
}
