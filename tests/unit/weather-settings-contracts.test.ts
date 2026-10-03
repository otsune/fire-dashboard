import { expect, it } from "vitest";
import * as contracts from "../../packages/contracts/src/index";
const selection = { office: "130000", region: "130010", station: "44132" };
it("exports bounded strict numeric weather settings contracts", () => {
  expect(typeof contracts.weatherSettingsStateSchema).toBe("object");
  expect(
    contracts.weatherSettingsStateSchema.parse({ revision: "one", selection }),
  ).toEqual({ revision: "one", selection });
  for (const input of [
    { revision: "", selection },
    { revision: "x".repeat(129), selection },
    { revision: "one", selection: { ...selection, office: "../bad" } },
    { revision: "one", selection: { ...selection, region: "https://evil" } },
    { revision: "one", selection: { ...selection, station: "1" } },
    { revision: "one", selection: { ...selection, label: "user label" } },
    { revision: "one", selection, canEdit: true },
  ])
    expect(contracts.weatherSettingsStateSchema.safeParse(input).success).toBe(
      false,
    );
  expect(
    contracts.weatherSettingsStateSchema.parse({
      revision: "one",
      selection: null,
    }).selection,
  ).toBeNull();
});
it("view and save schemas contain canonical weather", () => {
  const settings = { revision: "one", selection };
  const weather = contracts.emptyWeather();
  expect(
    contracts.weatherSettingsViewSchema.parse({
      ...settings,
      canEdit: false,
      weather,
    }),
  ).toEqual({ ...settings, canEdit: false, weather });
  expect(
    contracts.weatherSaveResultSchema.parse({ settings, weather }),
  ).toEqual({ settings, weather });
});
