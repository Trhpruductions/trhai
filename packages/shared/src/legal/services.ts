import type { LegalFacts } from "../legalFacts.js";
import type { LegalDocument } from "./model.js";

// "Services TRH AI can contact, and the software it is made of."
//
// The companion to the Privacy Policy: every outside service a request can go to, with
// that company's own privacy policy, and every piece of software TRH AI ships or
// downloads, with its licence as the app's own install records state it. The voice and
// model tables repeat the records in apps/api/src/services/toolCatalog.ts and
// modelSetup.ts word for word, and a test there (legal-services.test.ts) fails when the
// two drift apart, so the page cannot say one thing while the install screen says another.

export function servicesDocument(facts: LegalFacts): LegalDocument {
  const product = facts.productName;
  return {
    id: "services",
    title: "Services TRH AI can contact, and the software it is made of",
    summary: `Every outside service ${product} can send a request to, and every program, model and voice it uses, with their licences.`,
    version: null,
    effective: facts.effectiveDate,
    sections: [
      {
        id: "services",
        heading: "1. Services it can contact",
        blocks: [
          { kind: "p", text: `${product} has no server of its own. These are the only companies' services it sends requests to, and each one's own privacy policy says what that company does with a request. The [Privacy Policy](#legal-privacy) says exactly what each request carries and how to stop it.` },
          {
            kind: "table",
            caption: "Outside services",
            head: ["Service", "Used for", "Their privacy policy"],
            rows: [
              ["GitHub (GitHub, Inc.)", "Finding out whether a newer version exists; downloading updates, the engine (llama.cpp), Piper, whisper.cpp and the ffmpeg build.", "https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement"],
              ["Hugging Face (Hugging Face, Inc.)", "Downloading models and voices you choose to install.", "https://huggingface.co/privacy"],
              ["DuckDuckGo (Duck Duck Go, Inc.)", "Web searches you ask for, and the Network screen's Check now button.", "https://duckduckgo.com/privacy"],
              ["Any website you ask it to read", "Reading a page as text when you give its address.", "That site's own."],
              ["Your email provider", "Sending an email you asked for, through the account you connected.", "Your provider's own."]
            ]
          },
          { kind: "p", text: `${product} does not use any advertising, analytics, crash-reporting or tracking service, and loads no fonts, scripts or images from other companies' servers.` },
          { kind: "note", tone: "review", text: "The app's window is built on Chromium (through Electron). Chromium has built-in features of its own, such as spell-check dictionaries, that can contact Google's servers; the project has not yet measured whether this build does. Confirm by watching the app's network traffic, and switch the feature off or list it here." }
        ]
      },
      {
        id: "shipped",
        heading: "2. Software that ships with TRH AI",
        blocks: [
          { kind: "p", text: "The installer contains the app and the open-source libraries it is built with. Their licence texts are inside the installed program, and the most important are:" },
          {
            kind: "table",
            caption: "Shipped software",
            head: ["Software", "What it does here", "Licence"],
            rows: [
              ["Electron and Chromium", "The app's window.", "MIT (Electron); BSD and others (Chromium), listed in LICENSES.chromium.html inside the app"],
              ["Node.js (inside Electron)", "Runs the local service.", "MIT"],
              ["Express, helmet, cors, morgan", "The local service that the window talks to.", "MIT"],
              ["Nodemailer", "Sends email through the account you connect.", "MIT-0"],
              ["unpdf", "Reads the text of PDF files.", "MIT"],
              ["Next.js, React", "The screens.", "MIT"],
              ["sharp (image library used by Next.js)", "Present in the installed files; TRH AI does not use it to process your images.", "Apache 2.0; its Windows binary also carries LGPL 3.0 parts"],
              ["Geist, Geist Mono, Orbitron and Oxanium fonts", "The app's lettering, stored with the app.", "SIL Open Font License 1.1"]
            ]
          },
          { kind: "note", tone: "review", text: "A single third-party notices file for the installer (every library with its licence text) does not exist yet and should be added before public release; the LGPL parts of sharp and the project's own LICENSE file (the repository has none) need a lawyer's word." }
        ]
      },
      {
        id: "downloaded",
        heading: "3. Software it downloads",
        blocks: [
          { kind: "p", text: `These are fetched from GitHub and Hugging Face when you install them in **Settings, Engine and models**, or by ${product} itself for the parts it needs to start working. Each file is checked against a fixed size and checksum before it is used. They run on your PC and are not part of the installer.` },
          {
            kind: "table",
            caption: "Downloaded programs",
            head: ["Program", "What it does here", "Licence"],
            rows: [
              ["llama.cpp (llama-server)", "Runs the AI model.", "MIT"],
              ["NVIDIA CUDA runtime (only with an NVIDIA graphics card)", "Lets the engine use the graphics card.", "NVIDIA's own licence"],
              ["Piper", "Turns text into speech.", "MIT; it includes eSpeak NG, which is GPL 3"],
              ["whisper.cpp and the Whisper base.en model", "Turns speech into text.", "MIT"],
              ["ffmpeg (Windows build by gyan.dev)", "Makes and converts audio and video.", "GPL 3"]
            ]
          },
          { kind: "note", tone: "review", text: "The install records in the app name a licence for Piper, whisper.cpp and ffmpeg but not yet for llama.cpp, the CUDA runtime or eSpeak NG; the licences above for those three are as their makers publish them and should be added to the records. Distributing a GPL program by having the app download it is a question for a lawyer." }
        ]
      },
      {
        id: "voices",
        heading: "4. Voices",
        blocks: [
          { kind: "p", text: "Each voice is a separate file with its own licence, as its makers state it. The install screen shows the same words beside each voice." },
          {
            kind: "table",
            caption: "Voices",
            head: ["Voice", "Licence, as its makers state it", "Commercial use"],
            rows: [
              ["Alan (en_GB-alan-medium)", "All rights reserved (Mycroft AI)", "Not cleared"],
              ["Cori (en_GB-cori-high)", "Public domain (LibriVox recordings)", "Yes"],
              ["Jarvis (en_GB-jarvis-high)", "Fan-made imitation of a film character (tagged MIT, not cleared)", "Not cleared"],
              ["Ryan (en_US-ryan-high)", "CC BY-NC-SA 4.0 (non-commercial)", "No"],
              ["Amy (en_US-amy-medium)", "No licence stated (Mimic 3 collection)", "Not cleared"]
            ]
          },
          { kind: "note", tone: "review", text: "Only Cori is plainly free for any use. The owner chose on 2026-10-25 to install all five, with Alan as the default voice. Free of charge is not the same as non-commercial: whether TRH AI may ship Alan, Jarvis, Ryan and Amy is still a decision for the owner with a lawyer; dropping a voice is one line in the install records." }
        ]
      },
      {
        id: "models",
        heading: "5. AI models",
        blocks: [
          { kind: "p", text: "The models are made by Alibaba's Qwen team and, for the no-refusals versions, by other people who changed them so they do not refuse. Each is downloaded from its publisher on Hugging Face. The install screen shows each licence." },
          {
            kind: "table",
            caption: "Models",
            head: ["Model", "Licence", "Commercial use"],
            rows: [
              ["Qwen2.5 Coder 7B (no refusals)", "Apache 2.0", "Yes"],
              ["Qwen3 4B Instruct (no refusals)", "Apache 2.0", "Yes"],
              ["Qwen3 VL 8B (pictures, no refusals)", "Apache 2.0", "Yes"],
              ["Qwen3 VL 4B (pictures, no refusals)", "Apache 2.0", "Yes"],
              ["Qwen3 4B Instruct", "Apache 2.0", "Yes"],
              ["Qwen2.5 Coder 7B", "Apache 2.0", "Yes"],
              ["Qwen3 8B", "Apache 2.0", "Yes"],
              ["Qwen2.5 VL 7B (pictures)", "Apache 2.0", "Yes"],
              ["Qwen2.5 3B", "Qwen Research License (non-commercial)", "No"],
              ["Qwen2.5 VL 3B (pictures)", "Qwen Research License (non-commercial)", "No"]
            ]
          },
          { kind: "p", text: "A model's licence is the model's, not TRH AI's. If you use TRH AI for work, use a model whose licence allows it; the two research-licence models are offered for personal use only and say so on the install screen." },
          { kind: "note", tone: "review", text: "The no-refusals models are third parties' edits of Qwen's models, offered as the recommended defaults. Their publishers' repositories state Apache 2.0; one source repository could not be reached when checked. A lawyer should confirm that recommending them is acceptable." }
        ]
      },
      {
        id: "brand",
        heading: "6. TRH AI's own name and pictures",
        blocks: [
          { kind: "p", text: `The name ${product}, its lettering and its screens belong to ${facts.operatorName}. The background picture and the app's icon were made with an image-generating AI, and the icon still shows the product's earlier name, Ascend AI.` },
          { kind: "note", tone: "review", text: "The two brand images carry metadata naming OpenAI's image model as their maker. Who owns an AI-generated picture, and whether it can be a trademark, varies by country; the owner should decide whether to keep them, and should replace the icon so that it names TRH AI." }
        ]
      }
    ]
  };
}
