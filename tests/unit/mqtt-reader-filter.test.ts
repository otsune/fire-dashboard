import { expect, it } from "vitest";
import { createMqttReaderFilter } from "../../services/usage/src/mqtt/reader-filter";
const connect = Buffer.from([
  0x10, 15, 0, 4, 77, 81, 84, 84, 4, 2, 0, 60, 0, 3, 116, 115, 116,
]);
function subscribe(topic: string) {
  const text = Buffer.from(topic);
  return Buffer.concat([
    Buffer.from([0x82, text.length + 5, 0, 1, 0, text.length]),
    text,
    Buffer.from([1]),
  ]);
}
it("reassembles split MQTT packets and only allows exact usage topic subscriptions", () => {
  const filter = createMqttReaderFilter("test/v1", 1024);
  expect(filter(connect.subarray(0, 4))).toEqual([]);
  expect(filter(connect.subarray(4))).toEqual([connect]);
  const sub = subscribe("test/v1/usage/state");
  expect(filter(Buffer.concat([sub, Buffer.from([0xc0, 0])]))).toEqual([
    sub,
    Buffer.from([0xc0, 0]),
  ]);
  expect(() => filter(subscribe("test/v1/usage/#"))).toThrow();
});
it("refuses publish, will/username privilege changes, invalid framing and traffic before CONNECT", () => {
  expect(() =>
    createMqttReaderFilter("test", 1024)(subscribe("test/usage/state")),
  ).toThrow();
  for (const flag of [6, 0x82, 0x42]) {
    const input = Buffer.from(connect);
    input[9] = flag;
    expect(() => createMqttReaderFilter("test", 1024)(input)).toThrow();
  }
  const filter = createMqttReaderFilter("test", 1024);
  filter(connect);
  expect(() => filter(Buffer.from([0x30, 3, 0, 1, 120]))).toThrow();
  expect(() =>
    createMqttReaderFilter(
      "test",
      1024,
    )(Buffer.from([0x10, 0xff, 0xff, 0xff, 0xff])),
  ).toThrow();
});
