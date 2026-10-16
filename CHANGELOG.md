# Changelog

## v1.0.3 — First public release

This is the first public downloadable build of Decide, based on the source currently in this repository.

- Capture current prices from retailer-specific page signals and keep them separate from list price or MRP.
- Keep price evidence tied to the selected product and variant; do not substitute a campaign price or an unrelated product's price when the selected price is missing.
- Show a current-price fact when the evidence is unambiguous, and leave pricing unknown when it is not.
- Handle common retailer formats for display and other product specifications.
- Reject review text that has been incorrectly paired with a technical specification label.
- Merge duplicate RAM facts when known equivalent labels carry the same value, while preserving conflicting values.
- Describe recommendations as based on information captured from the selected pages, not as independently verified facts.

The side-panel layout and styling are unchanged. The extension manifest version, package version, and public release tag are aligned at `1.0.3`.
