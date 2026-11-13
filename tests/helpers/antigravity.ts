// Synthetic quota values using the group/bucket IDs observed in agy 1.5.1.
// No account identity or captured response is included.
export const antigravityGroups = {
  command: {
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              remaining_fraction: 0,
              reset_time: "2026-11-14T01:00:00Z",
            },
            { id: "gemini-5h", remaining_fraction: 1, disabled: true },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-weekly",
              remaining_fraction: 0.47361234567,
              reset_time: "2026-11-19T06:00:00Z",
            },
            {
              id: "3p-5h",
              remaining_fraction: 1,
              reset_time: "2026-11-13T10:00:00Z",
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-20T05:00:00Z",
            },
          ],
        },
      ],
    },
  },
};
