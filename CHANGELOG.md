# Changelog

## v1.0.0

This update brings the public source in line with the current extension build.

- Capture current prices from retailer-specific page signals and keep them separate from list price or MRP.
- Keep price evidence tied to the selected product and its variant; do not substitute a campaign price or an unrelated product's price when the selected price is missing.
- Preserve selected-page evidence through fact validation and show a clear current-price fact when the evidence is unambiguous.
- Keep display and other product specifications when their labels use common retailer-specific formats.
- Reject review-like sentences accidentally paired with technical specification labels, without changing concise valid values such as AMOLED, refresh rate, or resolution.
- Remove duplicate RAM-capacity facts when two known labels carry the same value. Conflicting values remain visible.
- Replace the repeated generic candidate assessment with a short summary based on facts already captured for that item.
- Describe the overall recommendation as based on captured page information, not as independently verified facts.

The side-panel layout and styling are unchanged in this update. The Chrome manifest version remains `1.0.3`; `v1.0.0` is the launch package name.
