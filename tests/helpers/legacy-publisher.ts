import {
  createMqttPublisher as publisher,
  type MqttPublisherOptions,
} from "../../services/usage/src/mqtt/publisher";
import type { Store } from "../../services/aggregator/src/store";
import { legacyUsageStore } from "./legacy-usage";
export function createMqttPublisher(
  store: Store,
  options: MqttPublisherOptions,
) {
  return publisher(legacyUsageStore(store), {
    ...options,
    topicPrefix: options.topicPrefix ?? "fire-dashboard/v1/main",
  });
}
