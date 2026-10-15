# Privacy and data handling

Decide does not run its own hosted backend and does not send usage analytics to a Decide server.

## What Decide reads

When you start a decision, Decide reads the tabs you selected. The captured information can include each page's title and URL, description, headings, structured data, relevant visible text, and extracted facts. The page URL may include query parameters. Do not select pages if you would not want their content or URL processed by the model provider.

## Where the information goes

Ollama is tried first. The default model, `gpt-oss:120b-cloud`, runs through Ollama Cloud. Although the extension contacts Ollama through the local Ollama service, the model processes the request in the cloud.

Gemini, Groq, and OpenRouter are optional fallbacks. If you add an API key in Settings and a fallback provider is used, information needed for the decision is sent to that provider. Review the provider's terms and privacy policy before enabling it.

## What stays in Chrome

Provider settings, API keys, and the saved decision are stored in Chrome's local extension storage for your profile. They are not bundled with the extension and are not sent to a Decide-operated server.

Decide's output can be incomplete or wrong. Check important claims, especially prices and product variants, on the original page before acting on them.
