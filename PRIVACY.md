# Privacy

Decide does not use a Decide hosted backend or send usage analytics to a Decide server.

Decide reads page information only from the tabs you select when you start a decision. That information is sent to the AI provider used for the request. Ollama is tried first, with `gpt-oss:120b-cloud` as the default model. That model uses Ollama Cloud, so information needed for the decision is processed by Ollama's cloud service.

Gemini, Groq and OpenRouter are optional backup providers. If you add their API keys in Settings, Decide may send the information needed for a decision to one of them when it is used. Provider keys and saved results are kept in Chrome's local extension storage.

Do not select pages containing information you do not want sent to your chosen AI provider. Always check important information at its original source.
