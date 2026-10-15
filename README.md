# Decide

Decide is a Chrome side panel for comparing options across the pages you already have open. Write down the decision, select the tabs with useful information, and Decide extracts facts before asking an AI provider to compare them. Each option keeps a link to its source page, and the result calls out trade-offs and important gaps instead of filling them with guesses.

## What you need

- Google Chrome 116 or newer.
- Ollama installed, running, and signed in.
- An internet connection for the default `gpt-oss:120b-cloud` model, which runs through Ollama Cloud.

You do not need Node.js, npm, a separate Decide server, or a Decide account to use the extension.

## Install from a release ZIP

1. Download the extension-only ZIP from the release and extract it.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the extracted folder containing `manifest.json`.
5. Open the pages you want to compare and click the Decide icon.

Chrome's **Load unpacked** option takes a folder, not the ZIP file itself.

## Run a comparison

1. Open the pages that describe your options.
2. Open Decide from the Chrome toolbar.
3. Enter the decision and the constraints that matter to you.
4. Select between two and five pages.
5. Click **Make my decision**.

Decide captures information from the selected tabs, extracts relevant facts, and sends those facts to the configured model for comparison. The result includes source links, supporting facts, trade-offs, and missing information where available. Retailer pages change frequently, and a page may hide or delay details, so check prices and selected variants on the source page before buying.

## AI providers

Ollama is tried first. The default model is `gpt-oss:120b-cloud`; it is a cloud model, so using it does not keep the page content on your computer.

Gemini, Groq, and OpenRouter are optional fallbacks. Add your own API key in **Settings** to enable one. Providers without a key are skipped, and the configured providers are tried in this order: Ollama, Gemini, Groq, then OpenRouter. When a fallback handles a decision, the information needed for that request is sent to that provider. Check the provider's terms before using it.

## Privacy and data handling

Decide does not run a hosted backend of its own and does not send usage analytics to a Decide server. It reads the tabs you select when you start a decision. Page titles, URLs, relevant text, headings, structured data, and extracted facts may be included in the request sent to the AI provider. URL query parameters can contain private information, so avoid selecting pages whose URLs or contents you do not want processed by that provider.

Provider settings, API keys, and the saved decision are stored in Chrome's local extension storage. They are not included in the source or release ZIP. See [PRIVACY.md](PRIVACY.md) for the data-handling summary.

## Troubleshooting

**Ollama is unavailable.** Open Ollama and check that it is running and signed in.

**The model is missing.** Decide asks Ollama to prepare the configured model. You can also run `ollama run gpt-oss:120b-cloud` in a terminal and retry.

**A page could not be read.** Make sure it is a normal `http` or `https` tab and that the relevant information has loaded. Some sites restrict access or render details in a way the extension cannot capture.

**A fallback provider did not run.** Check its API key and model name in **Settings**. If you only use Ollama, leave the fallback keys empty.

## License

Decide is released under the MIT License. See [LICENSE](LICENSE).
