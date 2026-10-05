# Fire Dashboard CSS P0 baseline

- Source commit: `dc38f9a40d811a102b414aa56577efe018a862fc`
- Source tree: `d4265e36a4a24f8287c58d94713af82eda246a02`
- Capture date: 2026-10-05 UTC
- Browser: repository Playwright Chromium, default device scale factor 1
- Data: local unconfigured dashboard only; no external API, account, Fire device, or settings mutation

## Recorded viewports

- Fire landscape: 1280 x 799
- Fire portrait: 800 x 1279
- Windows landscape: 1280 x 800
- Compact landscape: 960 x 600

`computed-styles.json` records the effective root/body font sizes, browser
visual viewport scale, focused settings-button styling, and document/client
dimensions for each capture.

At normal browser zoom, the effective root and body font size is 16 px and
`visualViewport.scale` is 1. The current settings-button focus treatment is a
3 px `rgb(184, 214, 162)` outline with 3 px offset, no box shadow, and the
existing 9 px radius. Landscape captures fit without document scrolling;
portrait keeps the clock visible and scrolls vertically (1844 px document in
the 1279 px viewport).

Fully Kiosk text zoom and device accessibility text scaling are not inferred
from these desktop captures and remain unconfirmed. No Fire device setting was
changed.
