# Testing Decide

The repository includes a small regression suite for the worker's price presentation and fact-quality handling.

## Automated tests

Requirements: Node.js 18 or newer. The extension itself does not need Node.js or npm to run.

```sh
npm test
```

These tests execute selected worker functions in a Node VM. They check that an unambiguous captured current-price fact is surfaced without promoting MRP, that missing-price warnings remain when a selected item has no unambiguous current price, that known duplicate RAM labels are merged only when their values agree, and that review snippets cannot be promoted into technical specification fields. They do not start Chrome, call an AI provider, or visit Amazon/Flipkart.

## Manual Chrome checks before a release

1. Load the extracted extension folder at `chrome://extensions` using **Load unpacked**.
2. Compare at least two live product pages. Use the same selected RAM/storage variant when comparing prices.
3. Confirm the displayed price matches the selected variant and is not the MRP, a crossed-out price, or an advertisement.
4. Confirm that the product's display size, resolution, refresh rate, and other visible specifications are retained where the page provides them. Review text must not appear as a display/specification value.
5. Check each **Open source page** link and make sure it points to the tab used for that candidate.
6. Repeat with a page where the price is not visible. Decide should leave it unknown rather than inventing a price.
7. If a backup provider is enabled, verify the expected provider behavior and remember that selected-page information is sent to whichever provider handles the request.

Retailer DOMs change, so passing local tests is not a substitute for this browser check.
