# Decide

**Make a decision, not more noise.**

Decide helps you make a decision using evidence from the pages you choose. Tell it what matters to you, select the pages that contain your options, and let it work through the available information. It gives you a recommendation when the evidence supports one. It also points out trade offs and missing information, so you can see where the answer is uncertain.

## What you need

For the default setup, you only need Google Chrome and Ollama installed and signed in. You do not need Node.js, npm, a separate server, or a Decide account.

Decide tries Ollama first and uses `gpt-oss:120b-cloud` by default. Ollama needs to be running. If the model is not ready, Decide tries to prepare it the first time you use it.

One thing to know: `gpt-oss:120b-cloud` runs in Ollama's cloud. Even though Decide connects to Ollama on your own computer, the page information needed for your decision is processed by Ollama's cloud model.

## Install Decide

1. Download `Decide-Extension-Only.zip` from the latest release and extract it.
2. Open Chrome and enter `chrome://extensions` in the address bar.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the extracted folder containing `manifest.json`.
6. Leave Ollama running, open the pages you need, and click the Decide icon in Chrome.

Chrome needs the extracted folder for **Load unpacked**. It cannot load the ZIP directly. You only need to do this installation once, unless you remove the extension or replace the folder.

## Make a decision

1. Open the pages that contain the options you are considering.
2. Open Decide from the Chrome toolbar.
3. Write the decision you need to make in the goal box. Be specific about what matters to you.
4. Select between two and eight pages.
5. Click **Make my decision**.

Decide reads the pages you selected and looks for facts that matter to your goal. The recommendation should be based on the evidence it finds. If important information is missing, it should tell you rather than treating an unknown as a fact.

Some websites block access to their content or require you to sign in. Decide may not be able to read those pages. Open the page normally first and make sure the relevant details are visible.

## Optional backup providers

You do not need another API key to use Decide with Ollama.

If Ollama is unavailable or you want backup providers, open **Settings** inside Decide and add your own API key. The providers are tried in this order:

1. Ollama
2. Gemini
3. Groq
4. OpenRouter

Providers without a key are skipped. The keys you add are saved in your local Chrome profile and are not included in this download. When a backup provider is used, the information needed for your decision is sent to that provider. Check the provider's terms before adding a key.

## Privacy

This version does not use a Decide hosted backend and does not send usage analytics to a Decide server. Your provider settings and the last decision are saved in Chrome's local extension storage.

Decide reads the pages you select when you start a decision. Page content and extracted facts are sent to the AI provider that handles the request. The default model uses Ollama Cloud. If you add backup providers, relevant information may be sent to one of them when it is used. Do not send information you would not want processed by the selected provider.

The extension needs permission to read the tabs you select so it can use their visible information. It does not need you to provide a Decide account.

## If something does not work

**Ollama is not reachable.** Open Ollama and check that it is running and signed in.

**The model is not available.** Decide tries to prepare the configured model when Ollama says it is missing. You can also run `ollama run gpt-oss:120b-cloud` in a terminal, then try again.

**A page could not be read.** Check that it is a normal website page, that it has finished loading, and that the information you need is visible.

**A backup provider did not run.** Check its API key and model name in Settings. If you only use Ollama, leave the backup fields empty.

## A final note

Decide is meant to help you think through a decision, not make you stop thinking. Pages can be incomplete or out of date, and AI can make mistakes. Check important claims at their original source before spending money or making a decision with serious consequences.

## License

Decide is released under the MIT License. See `LICENSE` for the full terms.
